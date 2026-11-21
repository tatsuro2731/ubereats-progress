"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { read } = require("../src/quest-image-api.js");

const input = { key: "test-key", imageUrl: "data:image/jpeg;base64,/9j/2Q==" };
const example = { number: null, readable: true, completed: 20, target: 120, remaining: 100, baseReward: "¥13,220",
  bonusTiers: [{ additionalCount: 10, reward: "+¥1,730" }] };
function response(data) {
  return { ok: true, json: async () => ({ status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify(data.cards ? data : { screen: "progress", periodText: null, cards: [data] }) }] }] }) };
}

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
    assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_image", image_url: input.imageUrl, detail: "high" }] }]);
    return response(example);
  });
  const result = await read({ ...input, signal });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(result.candidates[0], { label: "進行中のクエスト", completed: 20,
    tiers: [{ target: 120, reward: 13220 }, { target: 130, reward: 1730 }] });
});

test("a missing remaining-count label and no bonus rows are valid", async t => {
  t.mock.method(globalThis, "fetch", async () => response({ ...example, completed: 0, remaining: null, bonusTiers: [] }));
  const result = await read(input);
  assert.equal(result.candidates[0].completed, 0);
  assert.deepEqual(result.candidates[0].tiers, [{ target: 120, reward: 13220 }]);
});

test("uncertain, incomplete, inconsistent and out-of-range readings cannot populate a quest", async t => {
  let change;
  t.mock.method(globalThis, "fetch", async () => response({ ...example, ...change }));
  for (change of [{ readable: false }, { completed: null }, { completed: 207 }, { completed: 1.5 }, { target: "120" },
    { remaining: 99 }, { remaining: undefined }, { baseReward: null }, { baseReward: "¥10,000,000" }, { baseReward: "¥,580" }, { baseReward: "¥7,58" }, { bonusTiers: null },
    { bonusTiers: Array(5).fill(example.bonusTiers[0]) }, { bonusTiers: [null] },
    { bonusTiers: [{ additionalCount: 9880, reward: "+¥200" }] }, { bonusTiers: [{ additionalCount: 10, reward: null }] }]) {
    await assert.rejects(read(input), /確定できません/);
  }
});

test("selection cards keep each printed yen digit and skip incomplete cards independently", async t => {
  const card = (number, target, baseReward, bonus) => ({
    number, readable: true, target, baseReward, completed: null, remaining: null,
    bonusTiers: [{ additionalCount: 10, reward: bonus }]
  });
  const periodText = "月曜日 午前4時00分 〜 金曜日 午前4時00分";
  const cards = [card(1, 120, "￥８，８４０", "＋￥１，０９０"), card(2, 110, "¥7,580", "+¥1,010"),
    { ...card(3, 100, "¥6,420", null), readable: false }];
  let data = { screen: "selection", periodText, cards };
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
  for (const invalid of [[cards[0], cards[0]], [{ ...cards[1], baseReward: "¥,580" }],
    [{ ...cards[1], completed: 0 }], [{ ...cards[1], bonusTiers: [{ additionalCount: 10, reward: null }] }]]) {
    data = { ...data, cards: invalid };
    await assert.rejects(read(input), /確定できません/);
  }
  data = { screen: "other", periodText: null, cards: [] };
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
