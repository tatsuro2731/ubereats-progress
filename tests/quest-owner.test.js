"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const relay = "https://ubereats-quest-reader.netlify.app";
const readUrl = relay + "/api/quest-progress";
const imageUrl = "data:image/jpeg;base64,/9j/2Q==";
const sample = { label: "進行中のクエスト", completed: 1, tiers: [{ target: 10, reward: 100 }] };

function setup(t) {
  const values = new Map();
  const routes = [];
  const calls = [];
  const replacements = [];
  const requests = [];
  const globals = {
    window: {},
    location: { hash: "", pathname: "/ubereats-progress/", search: "", assign: url => routes.push(new URL(url)) },
    history: { replaceState: (...args) => replacements.push(args) },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (!requests.length) throw new Error("Unexpected request to " + url);
      return requests.shift();
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  delete require.cache[require.resolve("../src/quest-owner.js")];
  require("../src/quest-owner.js");
  return { owner: window.UberQuestOwner, routes, values, calls, requests, replacements };
}

async function callback(owner, routes) {
  await owner.signIn();
  const next = routes[0];
  assert.equal(next.origin, relay);
  const start = new URLSearchParams(next.hash.slice(1));
  const request = { state: start.get("quest-start"), publicKey: start.get("peer"), started: Date.now() };
  const { sealCredential } = await import("../src/quest-owner-transfer.mjs");
  const reply = await sealCredential(request, "synthetic-refresh-token");
  assert.ok(!String(reply).includes("synthetic"));
  location.hash = "#" + reply;
}

const exchange = () => Response.json({ access_token: "test-access", refresh_token: "test-renewed", expires_in: 3600 });

test("opening the picker renews an expired session without uploading and an immediate read shares that refresh", async t => {
  const { owner, values, calls, requests } = setup(t);
  const key = "questOwnerIdentity.v1";
  owner.prepareRead();
  assert.equal(calls.length, 0);
  values.set(key, JSON.stringify({ access: "old", refresh: "test-refresh", expires: 0 }));
  let finishRefresh;
  requests.push(new Promise(resolve => { finishRefresh = resolve; }));
  owner.prepareRead();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.url), [relay + "/.netlify/identity/token"]);
  const result = { screen: "progress", periodText: null, candidates: [sample], skipped: 0 };
  requests.push(Response.json(result));
  const reading = owner.read({ imageUrl });
  finishRefresh(exchange());
  assert.deepEqual(await reading, result);
  assert.deepEqual(calls.map(call => call.url), [relay + "/.netlify/identity/token", readUrl]);
  assert.equal(calls[1].headers.Authorization, "Bearer test-access");
});

test("owner login returns to the same browser, verifies ownership before sending one JPEG, and forgets a rejected session", async t => {
  const { owner, calls, requests, replacements, routes } = setup(t);
  assert.equal(await owner.init(), false);
  assert.equal(owner.hasSession(), false);
  await callback(owner, routes);
  requests.push(exchange(), new Response(null, { status: 204 }));
  assert.equal(await owner.init(), true);
  assert.equal(replacements[0][2], "/ubereats-progress/");
  assert.equal(calls[0].url, relay + "/.netlify/identity/token");
  assert.equal(calls[0].body.get("refresh_token"), "synthetic-refresh-token");
  assert.equal(calls[1].method, "GET");
  assert.ok(owner.hasSession());
  const result = { screen: "progress", periodText: null, candidates: [sample], skipped: 0 };
  requests.push(Response.json(result));
  const signal = new AbortController().signal;
  assert.deepEqual(await owner.read({ imageUrl, signal }), result);
  const uploaded = calls[2];
  assert.equal(uploaded.url, readUrl);
  assert.equal(uploaded.headers.Authorization, "Bearer test-access");
  assert.equal(uploaded.headers["Content-Type"], "image/jpeg");
  assert.deepEqual(Array.from(uploaded.body), [255, 216, 255, 217]);
  assert.equal(uploaded.credentials, "omit");
  requests.push(Response.json({}, { status: 401 }), new Response(null, { status: 204 }));
  await assert.rejects(owner.read({ imageUrl, signal }), /本人確認/);
  assert.equal(owner.hasSession(), false);
  assert.equal(calls.filter(c => c.url === readUrl && c.method === "POST").length, 2);
});

test("callback from a different start cannot overwrite a session or send an image", async t => {
  const { owner, routes, calls } = setup(t);
  await callback(owner, routes);
  const bad = new URLSearchParams(location.hash.slice(1));
  bad.set("quest-finish", "some-other-request");
  location.hash = "#" + bad;
  await assert.rejects(owner.init(), /本人確認/);
  assert.equal(owner.hasSession(), false);
  assert.equal(calls.length, 0);
});

test("a rejected owner check leaves automatic OCR disabled", async t => {
  const { owner, routes, requests, calls } = setup(t);
  await callback(owner, routes);
  requests.push(exchange(), new Response(null, { status: 403 }));
  await assert.rejects(owner.init(), /本人確認/);
  assert.equal(owner.hasSession(), false);
  assert.equal(calls.filter(c => c.url === readUrl && c.method === "POST").length, 0);
});

test("the return credential is unreadable with a different private key or modified state", async () => {
  const { startTransfer, openCredential, sealCredential, isCurrent } = await import("../src/quest-owner-transfer.mjs");
  const original = await startTransfer();
  const other = await startTransfer();
  const reply = await sealCredential(original, "test-only-value");
  assert.equal(await openCredential(original, reply), "test-only-value");
  await assert.rejects(openCredential({ ...original, privateKey: other.privateKey }, reply));
  assert.equal(isCurrent({ ...original, started: Date.now() - 601000 }), false);
  reply.set("quest-finish", other.state);
  await assert.rejects(openCredential(original, reply));
});
