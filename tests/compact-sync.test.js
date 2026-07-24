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
const COUNT_MODE = "continuous-v1";
const USAGE_MODE = "remaining-v1";
const LIMIT_MS = 720 * 60000;
const usedMsFromRemaining = remainingMs => Math.max(0, Math.min(LIMIT_MS - remainingMs, LIMIT_MS));

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
    countMode: COUNT_MODE,
    usageMode: USAGE_MODE,
    on: true,
    remainingMs: (10 * 60 + 12) * 60000 + 34000,
    activeMs: usedMsFromRemaining((10 * 60 + 12) * 60000 + 34000),
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
  const remainingMs = 32123456;
  const enhanced = { countMode: COUNT_MODE, usageMode: USAGE_MODE, on: true, remainingMs, activeMs: usedMsFromRemaining(remainingMs), updatedAt: 123 };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(enhanced) }, 123);

  app.element("target").value = "55";
  app.element("target").dispatch("change");
  app.element("done").value = "17";
  app.element("done").dispatch("change");

  assert.deepEqual(JSON.parse(app.storage.getItem(ENHANCED_KEY)), enhanced);
});

test("an explicit compact time change syncs remainingMs while preserving ON and session state", () => {
  const enhanced = {
    countMode: COUNT_MODE,
    usageMode: USAGE_MODE,
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
  assert.equal(saved.usageMode, USAGE_MODE);
  assert.equal(saved.on, true, "editing compact time must not switch an active clock off");
  assert.equal(saved.activeMs, (720 - (8 * 60 + 17)) * 60000);
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
  const first = { countMode: COUNT_MODE, usageMode: USAGE_MODE, on: false, remainingMs: 600000, activeMs: usedMsFromRemaining(600000), updatedAt: 1 };
  const second = { countMode: COUNT_MODE, usageMode: USAGE_MODE, on: true, remainingMs: 3723456, activeMs: usedMsFromRemaining(3723456), updatedAt: 2 };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(first) }, 2);
  const secondJson = JSON.stringify(second);

  app.storage.setItem(ENHANCED_KEY, secondJson);
  app.dispatchStorage(ENHANCED_KEY);

  assert.equal(app.element("remainH").value, "1");
  assert.equal(app.element("remainM").value, "3");
  assert.equal(app.storage.getItem(ENHANCED_KEY), secondJson);
});

test("compact rounds the minute-only countdown up without changing exact remainingMs", () => {
  const remainingMs = 10 * 60000 + 1000;
  const enhanced = { countMode: COUNT_MODE, usageMode: USAGE_MODE, on: false, remainingMs, activeMs: usedMsFromRemaining(remainingMs), updatedAt: 1 };
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
    countMode: COUNT_MODE,
    usageMode: USAGE_MODE,
    on: true,
    remainingMs: 10 * 60000,
    activeMs: usedMsFromRemaining(10 * 60000),
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

test("an existing continuous clock gains canonical usage while its anchor still catches up for display", () => {
  const enhanced = {
    countMode: COUNT_MODE,
    on: true,
    remainingMs: (11 * 60 + 25) * 60000,
    activeMs: 90 * 1000,
    sessionStartAt: 1000,
    breakOn: false,
    updatedAt: 100000,
    futureField: { preserve: true }
  };
  const app = runCompact({ [ENHANCED_KEY]: JSON.stringify(enhanced) }, 160000);
  const migrated = JSON.parse(app.storage.getItem(ENHANCED_KEY));

  assert.equal(migrated.usageMode, USAGE_MODE);
  assert.equal(migrated.remainingMs, enhanced.remainingMs, "migration must keep the exact stored anchor value");
  assert.equal(migrated.activeMs, 35 * 60000);
  assert.equal(migrated.updatedAt, enhanced.updatedAt, "continuous clocks keep their original catch-up anchor");
  assert.deepEqual(migrated.futureField, enhanced.futureField);
  assert.equal(app.element("remainH").value, "11");
  assert.equal(app.element("remainM").value, "24", "one elapsed minute should be reflected without settling storage");
  assert.deepEqual(JSON.parse(app.storage.getItem(LEGACY_KEY)), {
    on: true,
    baseRemain: 11 * 60 + 25,
    baseAt: enhanced.updatedAt
  });
});

test("a compact time edit settles continuous active time and starts a new anchor", () => {
  const app = runCompact({
    [ENHANCED_KEY]: JSON.stringify({
      countMode: COUNT_MODE,
      usageMode: USAGE_MODE,
      on: true,
      remainingMs: 10 * 60000,
      activeMs: usedMsFromRemaining(10 * 60000),
      sessionStartAt: 1000,
      breakOn: false,
      updatedAt: 100000
    })
  }, 160000);

  app.element("remainH").value = "8";
  app.element("remainM").value = "17";
  app.element("remainM").dispatch("change");

  const saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.countMode, COUNT_MODE);
  assert.equal(saved.usageMode, USAGE_MODE);
  assert.equal(saved.remainingMs, (8 * 60 + 17) * 60000);
  assert.equal(saved.activeMs, (720 - (8 * 60 + 17)) * 60000);
  assert.equal(saved.updatedAt, 160000);
  assert.equal(saved.on, true);
});

test("compact time edits mirror canonical usage exactly in both directions and clamp above 12 hours", () => {
  const now = 300000;
  const app = runCompact({
    [ENHANCED_KEY]: JSON.stringify({
      countMode: COUNT_MODE,
      usageMode: USAGE_MODE,
      on: false,
      remainingMs: 10 * 60 * 60000,
      activeMs: 2 * 60 * 60000,
      sessionStartAt: 1000,
      breakOn: false,
      updatedAt: now,
      futureField: "keep"
    })
  }, now);

  app.element("remainH").value = "11";
  app.element("remainM").value = "25";
  app.element("remainM").dispatch("change");
  let saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.remainingMs, (11 * 60 + 25) * 60000);
  assert.equal(saved.activeMs, 35 * 60000, "adding remaining time must reduce canonical usage");

  app.element("remainH").value = "8";
  app.element("remainM").value = "0";
  app.element("remainH").dispatch("change");
  saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.remainingMs, 8 * 60 * 60000);
  assert.equal(saved.activeMs, 4 * 60 * 60000, "subtracting remaining time must increase canonical usage");

  app.element("remainH").value = "12";
  app.element("remainM").value = "30";
  app.element("remainM").dispatch("change");
  saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.remainingMs, (12 * 60 + 30) * 60000);
  assert.equal(saved.activeMs, 0, "remaining time above the 12-hour usage window must clamp usage to zero");
  assert.equal(saved.usageMode, USAGE_MODE);
  assert.equal(saved.futureField, "keep");
});

test("compact migrates an unmarked movement clock without retroactive consumption", () => {
  const now = 500000;
  const legacyMovementState = {
    on: true,
    remainingMs: (11 * 60 + 25) * 60000,
    activeMs: 90 * 1000,
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
  assert.equal(migrated.countMode, COUNT_MODE);
  assert.equal(migrated.usageMode, USAGE_MODE);
  assert.equal(migrated.remainingMs, legacyMovementState.remainingMs, "migration must not consume the old GPS anchor gap");
  assert.equal(migrated.activeMs, 35 * 60000, "canonical usage must mirror the raw 11h25 remaining value, not legacy GPS active time");
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
    countMode: COUNT_MODE,
    usageMode: USAGE_MODE,
    on: true,
    remainingMs: 10 * 60000 + 500,
    activeMs: usedMsFromRemaining(10 * 60000 + 500),
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

test("ended sessions reject compact time edits until reset", () => {
  const now = 100000;
  const futureAnchor = 200000;
  const enhanced = {
    countMode: COUNT_MODE,
    usageMode: USAGE_MODE,
    on: false,
    remainingMs: (8 * 60 + 15) * 60000,
    activeMs: (3 * 60 + 45) * 60000,
    sessionStartAt: 10000,
    sessionEndedAt: 90000,
    breakOn: false,
    otherCompanyOn: false,
    otherCompanyStartedAt: null,
    otherCompanyMs: 60000,
    otherCompanySegments: [{ startAt: 20000, endAt: 80000 }],
    legacyOtherCompanyMs: 0,
    updatedAt: futureAnchor,
    futureField: { keep: true }
  };
  const app = runCompact({
    [DATA_KEY]: JSON.stringify({ target: "46", done: "17", remainH: "8", remainM: "15" }),
    [ENHANCED_KEY]: JSON.stringify(enhanced)
  }, now);
  const enhancedBeforeEdit = app.storage.getItem(ENHANCED_KEY);
  const dataBeforeEdit = app.storage.getItem(DATA_KEY);

  assert.equal(app.element("remainH").disabled, true);
  assert.equal(app.element("remainM").disabled, true);
  app.element("remainH").value = "7";
  app.element("remainM").value = "0";
  app.element("remainM").dispatch("change");

  assert.equal(app.storage.getItem(ENHANCED_KEY), enhancedBeforeEdit);
  assert.equal(app.storage.getItem(DATA_KEY), dataBeforeEdit);
  assert.equal(app.element("remainH").value, "8");
  assert.equal(app.element("remainM").value, "15");

  app.element("reset").dispatch("click");
  const reset = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(reset.remainingMs, LIMIT_MS);
  assert.equal(reset.activeMs, 0);
  assert.equal(reset.on, false);
  assert.equal(reset.sessionStartAt, null);
  assert.equal(reset.sessionEndedAt, null);
  assert.equal(reset.otherCompanyOn, false);
  assert.equal(reset.otherCompanyStartedAt, null);
  assert.equal(reset.otherCompanyMs, 0);
  assert.deepEqual(reset.otherCompanySegments, []);
  assert.equal(reset.usageMode, USAGE_MODE);
  assert.equal(reset.updatedAt, futureAnchor, "reset must not move a future monotonic anchor backward");
  assert.deepEqual(reset.futureField, enhanced.futureField);
  assert.equal(app.element("remainH").disabled, false);
  assert.equal(app.element("remainM").disabled, false);
});

test("compact reset explicitly syncs 12 hours but does not silently toggle ON off", () => {
  const app = runCompact({
    [ENHANCED_KEY]: JSON.stringify({ countMode: COUNT_MODE, usageMode: USAGE_MODE, on: true, remainingMs: 1000, activeMs: usedMsFromRemaining(1000), sessionStartAt: 10, updatedAt: 20 })
  }, 20);

  app.element("reset").dispatch("click");
  const saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.remainingMs, 720 * 60000);
  assert.equal(saved.on, true);
  assert.equal(saved.activeMs, 0);
  assert.equal(saved.sessionStartAt, 10);
});

test("compact time edits preserve an active other-company category", () => {
  const now = 600000;
  const otherCompanySegments = [{ startAt: 500000, endAt: null }];
  const app = runCompact({
    [ENHANCED_KEY]: JSON.stringify({
      countMode: COUNT_MODE,
      usageMode: USAGE_MODE,
      on: true,
      remainingMs: 10 * 60 * 60000,
      activeMs: 2 * 60 * 60000,
      sessionStartAt: 100000,
      breakOn: false,
      otherCompanyOn: true,
      otherCompanyStartedAt: 500000,
      otherCompanyMs: 100000,
      otherCompanySegments,
      legacyOtherCompanyMs: 0,
      updatedAt: now
    })
  }, now);

  app.element("remainH").value = "9";
  app.element("remainM").value = "30";
  app.element("remainM").dispatch("change");

  const saved = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(saved.on, true);
  assert.equal(saved.otherCompanyOn, true);
  assert.equal(saved.otherCompanyStartedAt, 500000);
  assert.equal(saved.otherCompanyMs, 100000);
  assert.deepEqual(saved.otherCompanySegments, otherCompanySegments);
});
