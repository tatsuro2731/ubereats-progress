"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appOrigin = "https://tatsuro2731.github.io";
const context = { site: { url: "https://example.netlify.app" } };
const jpeg = fs.readFileSync(path.join(__dirname, "fixtures/one-pixel.jpg"));
const user = { id: "owner-id", email: "owner@example.com", confirmed_at: "2026-01-01T00:00:00Z" };
const identityAuth = "Bearer test-identity";
const openAiKey = "test-provider";
const relay = import("../netlify/functions/quest-progress.mjs").then(module => module.default);

function request(options = {}) {
  const { method = "POST", headers, body = jpeg } = options;
  return new Request("https://untrusted-host.invalid/api/quest-progress", {
    method, headers: { Origin: appOrigin, Authorization: identityAuth, "Content-Type": "image/jpeg", ...headers },
    ...(method === "POST" ? { body } : {})
  });
}

function configure(t, env) {
  const previous = globalThis.Netlify;
  globalThis.Netlify = { env: { get: name => env[name] } };
  t.after(() => { globalThis.Netlify = previous; });
}

test("only the app origin passes preflight and unauthorized callers cannot trigger an upstream call", async t => {
  configure(t, {});
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected call"));
  const handle = await relay;
  const preflight = await handle(request({ method: "OPTIONS" }), context);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), appOrigin);
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(preflight.headers.get("Access-Control-Max-Age"), "600");
  assert.equal(preflight.headers.get("Cache-Control"), "no-store");
  assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  const other = await handle(request({ headers: { Origin: "https://other.invalid" } }), context);
  assert.equal(other.status, 403);
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await handle(request({ method: "PUT" }), context)).status, 405);
  assert.equal((await handle(request({ method: "GET", headers: { Authorization: "" } }), context)).status, 401);
  assert.equal((await handle(request({ headers: { Authorization: "" } }), context)).status, 401);
  assert.equal((await handle(request(), context)).status, 503);
  assert.equal(fetch.mock.callCount(), 0);
});

test("only a confirmed owner from this site's Identity can invoke OCR", async t => {
  const env = { QUEST_OWNER_EMAIL: user.email, QUEST_OPENAI_API_KEY: openAiKey };
  configure(t, env);
  const handle = await relay;
  let identityStatus = 200, account = user, autoconfirm = false, settingsOffline = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, context.site.url);
    assert.equal(options.redirect, "error");
    if (url.pathname === "/.netlify/identity/settings") {
      if (settingsOffline) throw new Error("settings unavailable");
      return Response.json({ autoconfirm });
    }
    assert.equal(url.pathname, "/.netlify/identity/user");
    assert.equal(options.headers.Authorization, identityAuth);
    return Response.json(account, { status: identityStatus });
  });
  identityStatus = 401;
  const expired = await handle(request(), context);
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get("Server-Timing"), null);
  identityStatus = 200;
  account = { ...user, confirmed_at: null };
  assert.equal((await handle(request(), context)).status, 403);
  account = { ...user, email: "other@example.com", user_metadata: { email: user.email } };
  assert.equal((await handle(request(), context)).status, 403);
  env.QUEST_OWNER_ID = "another-owner";
  account = user;
  assert.equal((await handle(request(), context)).status, 403);
  delete env.QUEST_OWNER_ID;
  assert.equal((await handle(request(), context)).status, 503);
  settingsOffline = false;
  autoconfirm = true;
  assert.equal((await handle(request(), context)).status, 503);
});

test("email ownership checks overlap and OpenAI waits for both confirmations", async t => {
  configure(t, { QUEST_OWNER_EMAIL: user.email, QUEST_OPENAI_API_KEY: openAiKey });
  const handle = await relay;
  const pending = new Map();
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (typeof url === "string" && url === "https://api.openai.com/v1/responses") {
      modelCalls++;
      return Promise.resolve(new Response(null, { status: 500 }));
    }
    assert.equal(url.origin, context.site.url);
    if (url.pathname.endsWith("/settings")) assert.equal(options.headers?.Authorization, undefined);
    return new Promise(resolve => pending.set(url.pathname, resolve));
  });
  const logs = t.mock.method(console, "info", () => {});
  const result = handle(request(), context);
  assert.equal(pending.size, 2);
  pending.get("/.netlify/identity/user")(Response.json(user));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(modelCalls, 0);
  pending.get("/.netlify/identity/settings")(Response.json({ autoconfirm: false }));
  const failedRead = await result;
  assert.equal(modelCalls, 1);
  assert.equal(failedRead.status, 502);
  assert.equal(failedRead.headers.get("Timing-Allow-Origin"), appOrigin);
  assert.equal(failedRead.headers.get("Access-Control-Expose-Headers"), "Server-Timing");
  assert.match(failedRead.headers.get("Server-Timing"), /^identity;dur=\d+, body;dur=\d+, model;dur=\d+$/);
  assert.equal(logs.mock.callCount(), 1);
  const [label, durations] = logs.mock.calls[0].arguments;
  assert.equal(label, "quest_read_ms");
  assert.deepEqual(Object.keys(durations), ["identity", "body", "model"]);
  assert.ok(Object.values(durations).every(value => Number.isInteger(value) && value >= 0));
});

test("invalid body types, dimensions and sizes are rejected before a model request", async t => {
  configure(t, { QUEST_OWNER_ID: user.id, QUEST_OPENAI_API_KEY: openAiKey });
  const handle = await relay;
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.href, context.site.url + "/.netlify/identity/user");
    return Response.json(user);
  });
  const send = async opts => (await handle(request(opts), context)).status;
  assert.equal(await send({ headers: { "Content-Type": "application/json" }, body: '{"model":"other"}' }), 415);
  assert.equal(await send({ body: Buffer.from("not a crop") }), 422);
  assert.equal(await send({ body: jpeg.subarray(0, -3) }), 422);
  const wide = Buffer.from(jpeg);
  const sof = wide.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof >= 0);
  wide.writeUInt16BE(1601, sof + 7);
  assert.equal(await send({ body: wide }), 422);
  assert.equal(await send({ body: Buffer.alloc(2 * 1024 * 1024 + 1) }), 413);
});

test("both GET and HEAD verify the owner without sending an image to OpenAI", async t => {
  configure(t, { QUEST_OWNER_ID: user.id, QUEST_OPENAI_API_KEY: openAiKey });
  const handle = await relay;
  const verify = t.mock.method(globalThis, "fetch", async url => {
    assert.equal(String(url), context.site.url + "/.netlify/identity/user");
    return Response.json(user);
  });
  for (const method of ["GET", "HEAD"]) {
    for (const origin of [appOrigin, context.site.url, null]) {
      const headers = { Authorization: identityAuth };
      if (origin) headers.Origin = origin;
      const check = new Request(context.site.url + "/api/quest-progress", { method, headers });
      const result = await handle(check, context);
      assert.equal(result.status, 204);
      assert.equal(result.body, null);
    }
    assert.equal((await handle(request({ method, headers: { Origin: "https://other.invalid" } }), context)).status, 403);
  }
  assert.equal(verify.mock.callCount(), 6);
});

test("a verified owner sends one fixed OCR request and receives validated cards and the legacy progress response", async t => {
  configure(t, { QUEST_OWNER_EMAIL: user.email, QUEST_OPENAI_API_KEY: openAiKey });
  const handle = await relay;
  let providerFailure = false;
  let screen = "progress";
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === context.site.url + "/.netlify/identity/user") return Response.json(user);
    if (String(url) === context.site.url + "/.netlify/identity/settings") return Response.json({ autoconfirm: false });
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.headers.Authorization, "Bearer " + openAiKey);
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-4.1-mini");
    assert.equal(body.store, false);
    assert.ok(body.max_output_tokens >= 1000);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.input[0].content[0].image_url, "data:image/jpeg;base64," + jpeg.toString("base64"));
    if (providerFailure) return new Response(openAiKey, { status: 500 });
    const card = { ok: true, goal: 10, yen: "¥200", bonus: [] };
    const cards = screen === "selection" ? [{ ...card, n: 2 }] : [{ ...card, done: 2, left: 8 }];
    const text = JSON.stringify({ screen, cards, period: null, bottom: screen === "selection" ? "visible" : null });
    return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
  });
  const result = await handle(request(), context);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  const sample = { label: "進行中のクエスト", completed: 2, tiers: [{ target: 10, reward: 200 }] };
  assert.deepEqual(await result.json(), { screen, periodText: null, candidates: [sample], skipped: 0, candidate: sample });
  assert.equal(fetch.mock.callCount(), 3);
  screen = "selection";
  const choices = await handle(request(), context);
  assert.deepEqual(await choices.json(), { screen, periodText: null, skipped: 0,
    candidates: [{ label: "クエスト2", tiers: [{ target: 10, reward: 200 }] }] });
  screen = "other";
  assert.equal((await handle(request(), context)).status, 422);
  providerFailure = true;
  const failure = await handle(request(), context);
  assert.equal(failure.status, 502);
  const { error } = await failure.json();
  assert.ok(error && !error.includes(openAiKey) && !error.includes(identityAuth));
});
