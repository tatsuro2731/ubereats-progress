"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { read } = require("../src/quest-image-api.js");

const input = { key: "test-key", imageUrl: "data:image/jpeg;base64,/9j/2Q==" };
const example = { done: 20, left: 100, ok: true, goal: 120, yen: "¥13,220",
  bonus: [{ add: 10, yen: "+¥1,730" }] };
function response(data) {
  return { ok: true, json: async () => ({ status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify(data.cards ? data : { screen: "progress", period: null, cards: [data], bottom: null }) }] }] }) };
}

const progressHint = { startAt: 1795374000000, endAt: 1795719600000,
  total: 16, tiers: [{ target: 40, reward: 3680 }, { target: 50, reward: 1290 }] };
const sameQuest = { type: "predicate", name: "same_quest", probability: 0.99 };
const remaining = { type: "choice", name: "remaining", choice: "22", confidence: 0.99 };
const completed = { type: "choice", name: "completed", choice: "18", confidence: 0.98 };

test("a matching quest returns only the exact count, including zero, without full transcription", async t => {
  let choice = "18";
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/decisions");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.input[0].content[0].image_url, input.imageUrl);
    assert.ok(body.questions[1].choices.some(c => c.value === choice));
    assert.ok(body.questions[1].choices.some(c => c.value === "other"));
    return Response.json({ answers: [{ ...completed, choice }, sameQuest, { ...remaining, choice: String(40 - Number(choice)) }] });
  });
  assert.deepEqual(await read({ ...input, progressHint }), { screen: "count", completed: 18 });
  choice = "0";
  assert.deepEqual(await read({ ...input, progressHint: { ...progressHint, total: 0 } }), { screen: "count", completed: 0 });
  assert.equal(fetch.mock.callCount(), 2);
});

test("unclear, refused, invalid and unavailable decisions all fall back once to the ordinary reader", async t => {
  let decision;
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(url.split("/").at(-1));
    return calls.at(-1) === "decisions" ? decision : response(example);
  });
  for (const answers of [[sameQuest, { ...completed, choice: "other" }], [sameQuest, { ...completed, choice: "38" }],
    [{ ...sameQuest, probability: 0.4 }, completed], [sameQuest, { ...completed, confidence: 0.8 }],
    [sameQuest, { type: "refusal", name: "completed" }], [completed, completed], [sameQuest, completed, { ...remaining, choice: "21" }], [sameQuest, completed, { ...remaining, choice: "other" }], null]) {
    decision = answers ? Response.json({ answers: answers.length === 2 ? [...answers, remaining] : answers }) : new Response(null, { status: 403 });
    calls.length = 0;
    assert.equal((await read({ ...input, progressHint })).candidates[0].completed, 20);
    assert.deepEqual(calls, ["decisions", "responses"]);
  }
  calls.length = 0;
  await read({ ...input, progressHint: { ...progressHint, tiers: [{ target: "from user", reward: 0 }] } });
  assert.deepEqual(calls, ["responses"]);
});

test("cancelling the decision request does not start a second paid call", async t => {
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    controller.abort();
    assert.ok(signal.aborted);
    throw new DOMException("Cancelled", "AbortError");
  });
  await assert.rejects(read({ ...input, progressHint, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("a slow Decisions request times out independently and the full reader still works", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    calls.push(url.split("/").at(-1));
    if (calls.at(-1) === "responses") {
      assert.equal(signal.aborted, false);
      return response(example);
    }
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  });
  const reading = read({ ...input, progressHint, signal: new AbortController().signal });
  t.mock.timers.tick(3000);
  assert.equal((await reading).candidates[0].completed, 20);
  assert.deepEqual(calls, ["decisions", "responses"]);
});

test("only the reviewed JPEG goes to OpenAI, the key is used only for authorization, and tiers are cumulative", async t => {
  const signal = new AbortController().signal;
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.method, "POST");
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.ok(!options.body.includes(input.key));
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.model, "gpt-4.1-mini");
    assert.equal(body.text.format.strict, true);
    const [selection, progress] = body.text.format.schema.properties.cards.items.anyOf;
    assert.deepEqual(selection.required, ["n", "ok", "goal", "yen", "bonus"]);
    assert.deepEqual(progress.required, ["done", "left", "ok", "goal", "yen", "bonus"]);
    assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_image", image_url: input.imageUrl, detail: "high" }] }]);
    return response(example);
  });
  const result = await read({ ...input, signal });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(result.candidates[0], { label: "進行中のクエスト", completed: 20,
    tiers: [{ target: 120, reward: 13220 }, { target: 130, reward: 1730 }] });
});

test("a missing remaining-count label and no bonus rows are valid", async t => {
  t.mock.method(globalThis, "fetch", async () => response({ ...example, done: 0, left: null, bonus: [] }));
  const result = await read(input);
  assert.equal(result.candidates[0].completed, 0);
  assert.deepEqual(result.candidates[0].tiers, [{ target: 120, reward: 13220 }]);
});

test("uncertain, incomplete, inconsistent and out-of-range readings cannot populate a quest", async t => {
  let change;
  t.mock.method(globalThis, "fetch", async () => response({ ...example, ...change }));
  for (change of [{ ok: false }, { done: null }, { done: 207 }, { done: 1.5 }, { goal: "120" },
    { left: 99 }, { left: undefined }, { yen: null }, { yen: "¥10,000,000" }, { yen: "¥,580" }, { yen: "¥7,58" }, { bonus: null },
    { bonus: Array(5).fill(example.bonus[0]) }, { bonus: [null] },
    { bonus: [{ add: 9880, yen: "+¥200" }] }, { bonus: [{ add: 10, yen: null }] }]) {
    await assert.rejects(read(input), /確定できません/);
  }
});

test("selection cards keep each printed yen digit and skip incomplete cards independently", async t => {
  const card = (n, goal, yen, extraYen) => ({
    n, ok: true, goal, yen,
    bonus: [{ add: 10, yen: extraYen }]
  });
  const periodText = "月曜日 午前4時00分 〜 金曜日 午前4時00分";
  const cards = [card(1, 120, "￥８，８４０", "＋￥１，０９０"), card(2, 110, "¥7,580", "+¥1,010"),
    { ...card(3, 100, "¥6,420", null), bonus: [] }];
  let data = { screen: "selection", period: periodText, cards, bottom: "cut_off" };
  t.mock.method(globalThis, "fetch", async () => response(data));
  const result = await read(input);
  assert.equal(result.periodText, periodText);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.candidates, [
    { label: "クエスト1", tiers: [{ target: 120, reward: 8840 }, { target: 130, reward: 1090 }] },
    { label: "クエスト2", tiers: [{ target: 110, reward: 7580 }, { target: 120, reward: 1010 }] }
  ]);
  const totals = require("../src/app-core.js").questTierTotals(result.candidates[1].tiers);
  assert.deepEqual(totals.map(row => row.totalReward), [7580, 8590]);
  data = { ...data, bottom: "visible" };
  assert.equal((await read(input)).candidates[2].checkTiers, true, "a last option with fewer stages must be checked even if the model marked its lower edge visible");
  for (const invalid of [[cards[0], cards[0]], [{ ...cards[1], yen: "¥,580" }],
    [{ ...cards[1], done: 0 }],
    [{ ...cards[1], bonus: [{ add: 10, yen: null }] }]]) {
    data = { ...data, cards: invalid };
    await assert.rejects(read(input), /確定できません/);
  }
  data = { ...data, cards: [cards[1]], bottom: "uncertain" };
  await assert.rejects(read(input), /確定できません/);
  data = { screen: "other", period: null, cards: [], bottom: null };
  await assert.rejects(read(input), /確定できません/);
});

test("invalid inputs never send the key or an arbitrary URL", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network request"));
  for (const imageUrl of ["https://example.com/image.jpeg", "blob:test", "data:image/png;base64,abcd",
    "data:image/jpeg;base64,abcd", "data:image/jpeg;base64,/9j/!", input.imageUrl + "a".repeat(12 * 1024 * 1024)]) {
    await assert.rejects(read({ ...input, imageUrl }), /切り出し/);
  }
  await assert.rejects(read({ ...input, key: " " }), /APIキー/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("failed requests do not retry or disclose provider error details", async t => {
  let status;
  const fetch = t.mock.method(globalThis, "fetch", async () => ({
    ok: false, status, json: async () => assert.fail("unexpected provider error content")
  }));
  for (const [code, expected] of [[401, /APIキー/], [403, /利用権限/], [429, /利用上限/], [500, /時間をおいて/], [400, /リクエスト/]]) {
    status = code;
    await assert.rejects(read(input), expected);
  }
  assert.equal(fetch.mock.callCount(), 5);
});

test("refusals, invalid structured output and truncated model responses are discarded", async t => {
  let payload;
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => payload }));
  for (payload of [
    { ...(await response(example).json()), status: "incomplete" },
    { status: "completed", output: [] },
    ...[{ type: "refusal", refusal: input.key }, { type: "output_text", text: "not JSON" }].map(part => ({
      status: "completed", output: [{ type: "message", role: "assistant", content: [part] }]
    }))
  ]) await assert.rejects(read(input), /確定できません/);
});

test("network errors are sanitized and cancellation keeps its AbortError name", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error(input.key); });
  await assert.rejects(read(input), error => error.message.includes("通信状況") && !error.message.includes(input.key));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(read({ ...input, signal: controller.signal }), { name: "AbortError" });
});
