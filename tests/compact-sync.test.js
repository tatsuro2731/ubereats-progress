"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const ENHANCED_KEY = "ubereatsProgressMovementClockV1";
const DATA_KEY = "ubereatsProgressFixed12Data";
const LEGACY_KEY = "ubereatsProgressClockState";

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.dataset = {};
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  appendChild() {}
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, ...extra };
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }
}

function compactScript() {
  const html = fs.readFileSync(path.join(ROOT, "compact.html"), "utf8");
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(inline.length, 1, "compact.html should have one inline application script");
  return inline[0][1];
}

function runCompact(initial = {}) {
  const storage = new MemoryStorage(initial);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const windowListeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const list = windowListeners.get(type) || [];
      list.push(listener);
      windowListeners.set(type, list);
    }
  };
  const context = vm.createContext({
    console,
    localStorage: storage,
    navigator: {},
    window,
    confirm: () => true,
    document: {
      getElementById: element,
      createElement: () => new FakeElement(),
      querySelectorAll: () => []
    }
  });
  vm.runInContext(compactScript(), context, { filename: "compact.html" });
  return {
    storage,
    element,
    dispatchStorage(key) {
      for (const listener of windowListeners.get("storage") || []) listener({ key });
    }
  };
}

test("compact startup prefers enhanced remainingMs without rewriting the enhanced clock", () => {
  const enhanced = {
    on: true,
    remainingMs: (10 * 60 + 12) * 60000 + 34000,
    activeMs: 987654,
    sessionStartAt: 1000,
    breakOn: false,
    breakStartedAt: null,
    breakMs: 1234,
    updatedAt: 2000,
    futureField: "preserve-me"
  };
  const enhancedJson = JSON.stringify(enhanced);
  const app = runCompact({
    [DATA_KEY]: JSON.stringify({ target: "46", done: "10", remainH: "3", remainM: "1" }),
    [ENHANCED_KEY]: enhancedJson
  });

  assert.equal(app.element("remainH").value, "10");
  assert.equal(app.element("remainM").value, "13");
  assert.equal(app.storage.getItem(ENHANCED_KEY), enhancedJson, "startup calc must not round and overwrite exact seconds");

  const regular = JSON.parse(app.storage.getItem(DATA_KEY));
  assert.equal(regular.remainH, "10");
  assert.equal(regular.remainM, "13");
});

test("non-time controls never overwrite the enhanced remaining time", () => {
  const enhanced = { on: true, remainingMs: 32123456, activeMs: 9000, updatedAt: 123 };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(enhanced) });

  app.element("target").value = "55";
  app.element("target").dispatch("change");
  app.element("done").value = "17";
  app.element("done").dispatch("change");

  assert.deepEqual(JSON.parse(app.storage.getItem(ENHANCED_KEY)), enhanced);
});

test("an explicit compact time change syncs remainingMs while preserving ON and session state", () => {
  const enhanced = {
    on: true,
    remainingMs: 40000000,
    activeMs: 456789,
    sessionStartAt: 1700000000000,
    breakOn: true,
    breakStartedAt: 1700000100000,
    breakMs: 22000,
    updatedAt: 1700000200000,
    futureField: 42
  };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(enhanced) });

  app.element("remainH").value = "8";
  app.element("remainM").value = "17";
  app.element("remainM").dispatch("change");

  const saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.remainingMs, (8 * 60 + 17) * 60000);
  assert.equal(saved.on, true, "editing compact time must not switch an active clock off");
  assert.equal(saved.activeMs, enhanced.activeMs);
  assert.equal(saved.sessionStartAt, enhanced.sessionStartAt);
  assert.equal(saved.breakOn, true);
  assert.equal(saved.breakStartedAt, enhanced.breakStartedAt);
  assert.equal(saved.breakMs, enhanced.breakMs);
  assert.equal(saved.futureField, 42);
  assert.ok(saved.updatedAt >= enhanced.updatedAt);

  const legacy = JSON.parse(app.storage.getItem(LEGACY_KEY));
  assert.equal(legacy.on, true);
  assert.equal(legacy.baseRemain, 8 * 60 + 17);
});

test("compact follows enhanced-clock storage updates without writing back a rounded clock", () => {
  const first = { on: false, remainingMs: 600000, activeMs: 1, updatedAt: 1 };
  const second = { on: true, remainingMs: 3723456, activeMs: 2, updatedAt: 2 };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(first) });
  const secondJson = JSON.stringify(second);

  app.storage.setItem(ENHANCED_KEY, secondJson);
  app.dispatchStorage(ENHANCED_KEY);

  assert.equal(app.element("remainH").value, "1");
  assert.equal(app.element("remainM").value, "2");
  assert.equal(app.storage.getItem(ENHANCED_KEY), secondJson);
});

test("compact reset explicitly syncs 12 hours but does not silently toggle ON off", () => {
  const app = runCompact({
    [ENHANCED_KEY]: JSON.stringify({ on: true, remainingMs: 1000, activeMs: 55, sessionStartAt: 10, updatedAt: 20 })
  });

  app.element("reset").dispatch("click");
  const saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.remainingMs, 720 * 60000);
  assert.equal(saved.on, true);
  assert.equal(saved.activeMs, 55);
  assert.equal(saved.sessionStartAt, 10);
});

