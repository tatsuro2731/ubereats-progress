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

function runCompact(initial = {}, now = Date.now()) {
  const storage = new MemoryStorage(initial);
  const elements = new Map();
  const intervals = [];
  let currentNow = now;
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
    },
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    }
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentNow])); }
    static now() { return currentNow; }
  }
  const context = vm.createContext({
    console,
    Date: FakeDate,
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
    setNow(value) { currentNow = value; },
    advanceTime(milliseconds) { currentNow += milliseconds; },
    runIntervals(delay) {
      for (const interval of intervals) {
        if (delay === undefined || interval.delay === delay) interval.callback();
      }
    },
    intervals,
    dispatchStorage(key) {
      for (const listener of windowListeners.get("storage") || []) listener({ key });
    }
  };
}

test("compact startup prefers enhanced remainingMs without rewriting the enhanced clock", () => {
  const enhanced = {
    countMode: "continuous-v1",
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
  }, 2000);

  assert.equal(app.element("remainH").value, "10");
  assert.equal(app.element("remainM").value, "13");
  assert.equal(app.storage.getItem(ENHANCED_KEY), enhancedJson, "startup calc must not round and overwrite exact seconds");

  const regular = JSON.parse(app.storage.getItem(DATA_KEY));
  assert.equal(regular.remainH, "10");
  assert.equal(regular.remainM, "13");
});

test("non-time controls never overwrite the enhanced remaining time", () => {
  const enhanced = { countMode: "continuous-v1", on: true, remainingMs: 32123456, activeMs: 9000, updatedAt: 123 };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(enhanced) }, 123);

  app.element("target").value = "55";
  app.element("target").dispatch("change");
  app.element("done").value = "17";
  app.element("done").dispatch("change");

  assert.deepEqual(JSON.parse(app.storage.getItem(ENHANCED_KEY)), enhanced);
});

test("an explicit compact time change syncs remainingMs while preserving ON and session state", () => {
  const enhanced = {
    countMode: "continuous-v1",
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
  const first = { countMode: "continuous-v1", on: false, remainingMs: 600000, activeMs: 1, updatedAt: 1 };
  const second = { countMode: "continuous-v1", on: true, remainingMs: 3723456, activeMs: 2, updatedAt: 2 };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(first) }, 2);
  const secondJson = JSON.stringify(second);

  app.storage.setItem(ENHANCED_KEY, secondJson);
  app.dispatchStorage(ENHANCED_KEY);

  assert.equal(app.element("remainH").value, "1");
  assert.equal(app.element("remainM").value, "3");
  assert.equal(app.storage.getItem(ENHANCED_KEY), secondJson);
});

test("compact rounds the minute-only countdown up without changing exact remainingMs", () => {
  const enhanced = { countMode: "continuous-v1", on: false, remainingMs: 10 * 60000 + 1000, activeMs: 12345, updatedAt: 1 };
  const enhancedJson = JSON.stringify(enhanced);
  const app = runCompact({ [ENHANCED_KEY]: enhancedJson });

  assert.equal(app.element("remainH").value, "0");
  assert.equal(app.element("remainM").value, "11");
  assert.match(app.element("miniSummary").textContent, /残り0時間11分$/);
  assert.equal(app.element("availableTime").textContent, "11分");
  assert.equal(app.storage.getItem(ENHANCED_KEY), enhancedJson);
});

test("compact displays the effective continuous countdown without rewriting its exact anchor", () => {
  const enhanced = {
    countMode: "continuous-v1",
    on: true,
    remainingMs: 10 * 60000,
    activeMs: 20000,
    sessionStartAt: 1000,
    breakOn: false,
    updatedAt: 100000
  };
  const enhancedJson = JSON.stringify(enhanced);
  const app = runCompact({ [ENHANCED_KEY]: enhancedJson }, 160000);

  assert.equal(app.element("remainH").value, "0");
  assert.equal(app.element("remainM").value, "9");
  assert.equal(app.storage.getItem(ENHANCED_KEY), enhancedJson);
});

test("a compact time edit settles continuous active time and starts a new anchor", () => {
  const app = runCompact({
    [ENHANCED_KEY]: JSON.stringify({
      countMode: "continuous-v1",
      on: true,
      remainingMs: 10 * 60000,
      activeMs: 20000,
      sessionStartAt: 1000,
      breakOn: false,
      updatedAt: 100000
    })
  }, 160000);

  app.element("remainH").value = "8";
  app.element("remainM").value = "17";
  app.element("remainM").dispatch("change");

  const saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.countMode, "continuous-v1");
  assert.equal(saved.remainingMs, (8 * 60 + 17) * 60000);
  assert.equal(saved.activeMs, 80000);
  assert.equal(saved.updatedAt, 160000);
  assert.equal(saved.on, true);
});

test("compact migrates an unmarked movement clock without retroactive consumption", () => {
  const now = 500000;
  const legacyMovementState = {
    on: true,
    remainingMs: 32123456,
    activeMs: 456789,
    sessionStartAt: 100000,
    sessionEndedAt: null,
    breakOn: false,
    breakStartedAt: 222222,
    breakMs: 12000,
    breakSegments: [{ startAt: 150000, endAt: 162000 }],
    moving: true,
    backgroundGap: {
      hiddenAt: 300000,
      movingBefore: true,
      activeMsAtHidden: 400000,
      resumeAt: 450000
    },
    lastBackfillMs: 50000,
    lastBackfillAt: 450000,
    updatedAt: 200000,
    futureField: { keep: true }
  };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(legacyMovementState) }, now);

  const migrated = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(migrated.countMode, "continuous-v1");
  assert.equal(migrated.remainingMs, legacyMovementState.remainingMs, "migration must not consume the old GPS anchor gap");
  assert.equal(migrated.activeMs, legacyMovementState.activeMs, "migration must not add retroactive active time");
  assert.equal(migrated.sessionStartAt, legacyMovementState.sessionStartAt);
  assert.equal(migrated.sessionEndedAt, null);
  assert.deepEqual(migrated.breakSegments, legacyMovementState.breakSegments);
  assert.deepEqual(migrated.futureField, legacyMovementState.futureField);
  assert.equal(migrated.moving, false);
  assert.equal(migrated.backgroundGap, null);
  assert.equal(migrated.lastBackfillMs, 0);
  assert.equal(migrated.lastBackfillAt, null);
  assert.equal(migrated.breakStartedAt, null);
  assert.equal(migrated.updatedAt, now);

  assert.deepEqual(JSON.parse(app.storage.getItem(LEGACY_KEY)), {
    on: true,
    baseRemain: legacyMovementState.remainingMs / 60000,
    baseAt: now
  });
});

test("the one-second refresh crosses a visible minute without persisting derived time", () => {
  const now = 100000;
  const enhanced = {
    countMode: "continuous-v1",
    on: true,
    remainingMs: 10 * 60000 + 500,
    activeMs: 20000,
    sessionStartAt: 1000,
    breakOn: false,
    updatedAt: now
  };
  const app = runCompact({
    [DATA_KEY]: JSON.stringify({ target: "46", done: "10", remainH: "0", remainM: "11" }),
    [ENHANCED_KEY]: JSON.stringify(enhanced)
  }, now);
  const enhancedAfterStartup = app.storage.getItem(ENHANCED_KEY);
  const dataAfterStartup = app.storage.getItem(DATA_KEY);

  assert.equal(app.element("remainM").value, "11");
  assert.ok(app.intervals.some(interval => interval.delay === 1000), "compact should register its one-second display refresh");

  app.advanceTime(1000);
  app.runIntervals(1000);

  assert.equal(app.element("remainM").value, "10");
  assert.equal(app.storage.getItem(ENHANCED_KEY), enhancedAfterStartup);
  assert.equal(app.storage.getItem(DATA_KEY), dataAfterStartup);
});

test("compact reset explicitly syncs 12 hours but does not silently toggle ON off", () => {
  const app = runCompact({
    [ENHANCED_KEY]: JSON.stringify({ countMode: "continuous-v1", on: true, remainingMs: 1000, activeMs: 55, sessionStartAt: 10, updatedAt: 20 })
  }, 20);

  app.element("reset").dispatch("click");
  const saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.remainingMs, 720 * 60000);
  assert.equal(saved.on, true);
  assert.equal(saved.activeMs, 55);
  assert.equal(saved.sessionStartAt, 10);
});
