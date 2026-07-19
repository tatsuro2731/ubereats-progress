"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const ENHANCED_KEY = "ubereatsProgressMovementClockV1";
const DATA_KEY = "ubereatsProgressFixed12Data";

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.dataset = {};
    this.firstChild = { nodeValue: "" };
    this.style = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  appendChild() {}
  before() {}
  querySelector() { return null; }
  setAttribute() {}
  addEventListener() {}
  focus() {}
}

function instrumentedSource() {
  const source = fs.readFileSync(path.join(ROOT, "app-enhancements.js"), "utf8");
  const closeAt = source.lastIndexOf("})();");
  assert.ok(closeAt > 0, "app-enhancements.js must end in an IIFE");
  const exports = `
  globalThis.__timerTestApi = {
    tickClock,
    handlePosition,
    setExactRemaining,
    toggleBreak,
    sessionBreakMs,
    sessionElapsedMs,
    persistEnhancedClock,
    beginBackgroundGap,
    resumeBackgroundGap,
    applyBackgroundBackfill,
    renderEnhancedClock,
    remainingText,
    durationText,
    getState: () => clockState,
    setState: value => { clockState = value; },
    getEvidenceUntil: () => movementEvidenceUntil,
    setEvidenceUntil: value => { movementEvidenceUntil = value; },
    getLastPosition: () => lastPosition,
    setLastPosition: value => { lastPosition = value; }
  };
`;
  return source.slice(0, closeAt) + exports + source.slice(closeAt);
}

function timerHarness(options = {}) {
  let now = options.now || 1_000_000;
  const initialEnhanced = options.enhanced || {
    on: false,
    remainingMs: 720 * 60000,
    activeMs: 0,
    sessionStartAt: null,
    breakOn: false,
    breakStartedAt: null,
    breakMs: 0,
    breakSegments: [],
    updatedAt: now
  };
  const storage = new MemoryStorage({
    [DATA_KEY]: JSON.stringify(options.regular || { target: "46", done: "0", remainH: "1", remainM: "0" }),
    [ENHANCED_KEY]: JSON.stringify(initialEnhanced)
  });
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const regular = options.regular || { target: "46", done: "0", remainH: "1", remainM: "0" };
  Object.entries(regular).forEach(([id, value]) => { element(id).value = String(value); });

  const documentListeners = new Map();
  const document = {
    hidden: false,
    readyState: "loading",
    head: new FakeElement("head"),
    body: new FakeElement("body"),
    createElement: () => new FakeElement(),
    getElementById: element,
    addEventListener(type, listener) {
      const list = documentListeners.get(type) || [];
      list.push(listener);
      documentListeners.set(type, list);
    }
  };
  let nextWatchId = 1;
  const confirmMessages = [];
  const navigator = {
    geolocation: {
      watchPosition() { return nextWatchId++; },
      clearWatch() {}
    }
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }

  const context = vm.createContext({
    console,
    Date: FakeDate,
    Math,
    JSON,
    localStorage: storage,
    document,
    navigator,
    window: { addEventListener() {} },
    alert() {},
    confirm(message) { confirmMessages.push(String(message)); return true; },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: callback => { callback(); return 1; },
    clearTimeout() {},
    MAX_REMAIN_INPUT_MINUTES: 779,
    CLOCK_KEY: "ubereatsProgressClockState",
    clockState: { on: false, baseRemain: 720, baseAt: now },
    remain: () => Number(element("remainH").value || 0) * 60 + Number(element("remainM").value || 0),
    manualRemain: () => Number(element("remainH").value || 0) * 60 + Number(element("remainM").value || 0),
    setRemain(minutes) {
      const rounded = Math.max(0, Math.ceil(minutes));
      element("remainH").value = String(Math.floor(rounded / 60));
      element("remainM").value = String(rounded % 60);
    },
    n: id => Number(element(id).value || 0),
    $: element,
    calc() {},
    save() {
      const previous = JSON.parse(storage.getItem(DATA_KEY) || "{}");
      storage.setItem(DATA_KEY, JSON.stringify({
        ...previous,
        remainH: element("remainH").value,
        remainM: element("remainM").value
      }));
    },
    adjustRemain() {}
  });
  vm.runInContext(instrumentedSource(), context, { filename: "app-enhancements.js" });
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "app-enhancements-fix.js"), "utf8"),
    context,
    { filename: "app-enhancements-fix.js" }
  );
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "app-session-ui-fix.js"), "utf8"),
    context,
    { filename: "app-session-ui-fix.js" }
  );

  return {
    api: context.__timerTestApi,
    context,
    storage,
    confirmMessages,
    element,
    now: () => now,
    setNow(value) { now = value; },
    dispatchDocument(type) {
      for (const listener of documentListeners.get(type) || []) listener({ type });
    }
  };
}

function state(overrides = {}) {
  return {
    on: true,
    remainingMs: 600000,
    baseRemain: 10,
    baseAt: 100000,
    lastTickAt: 100000,
    moving: false,
    activeMs: 0,
    sessionStartAt: 1000,
    breakOn: false,
    breakStartedAt: null,
    breakMs: 0,
    breakSegments: [],
    updatedAt: 100000,
    ...overrides
  };
}

function position(at, latitude, longitude, speed = null, accuracy = 5) {
  return { timestamp: at, coords: { latitude, longitude, speed, accuracy } };
}

test("±1 minute keeps the existing seconds exactly", () => {
  const initial = state({ on: false, remainingMs: 10 * 60000 + 30500, lastTickAt: 1_000_000 });
  const app = timerHarness({ now: 1_000_000, enhanced: initial });

  app.context.adjustRemain(1);
  assert.equal(app.api.getState().remainingMs, 11 * 60000 + 30500);
  app.context.adjustRemain(-1);
  assert.equal(app.api.getState().remainingMs, 10 * 60000 + 30500);
});

test("remaining time is shown only to minutes while keeping millisecond precision", () => {
  const initial = state({
    on: false,
    remainingMs: 10 * 60000 + 30500,
    activeMs: 2 * 60000 + 45500,
    sessionStartAt: null,
    lastTickAt: 1_000_000
  });
  const app = timerHarness({ now: 1_000_000, enhanced: initial });

  app.api.renderEnhancedClock();

  assert.equal(app.element("countRemain").textContent, "残り 0時間11分");
  assert.doesNotMatch(app.element("countRemain").textContent, /秒/);
  assert.equal(app.api.remainingText(1), "0時間01分", "a non-zero remainder must not display as zero minutes");
  assert.equal(app.api.getState().remainingMs, 10 * 60000 + 30500);
  assert.equal(app.api.getState().activeMs, 2 * 60000 + 45500);
});

test("work-session durations are shown only to completed minutes without rounding engine data", () => {
  const initial = state({
    on: false,
    remainingMs: 20 * 60000 + 12345,
    activeMs: 2 * 60000 + 45500,
    sessionStartAt: 640001,
    lastTickAt: 1_000_000,
    lastBackfillMs: 30500,
    lastBackfillAt: 1_000_000
  });
  const app = timerHarness({ now: 1_000_000, enhanced: initial });

  app.api.renderEnhancedClock();

  assert.equal(app.element("workActiveTime").textContent, "0時間02分");
  assert.equal(app.element("workElapsedTime").textContent, "0時間05分");
  assert.equal(app.element("workBreakTime").textContent, "0時間00分");
  for (const id of ["workActiveTime", "workElapsedTime", "workBreakTime"]) {
    assert.doesNotMatch(app.element(id).textContent, /秒/, `${id} must not expose seconds`);
  }
  assert.match(app.element("movementDetail").textContent, /1分未満/);
  assert.doesNotMatch(app.element("movementDetail").textContent, /秒/);
  assert.equal(app.api.durationText(59999), "0時間00分");
  assert.equal(app.api.getState().remainingMs, 20 * 60000 + 12345);
  assert.equal(app.api.getState().activeMs, 2 * 60000 + 45500);
});

test("normal persistence mirrors enhanced remaining time into regular saved controls", () => {
  const initial = state({ on: false, remainingMs: 10 * 60000 + 30500, lastTickAt: 1_000_000 });
  const app = timerHarness({ now: 1_000_000, enhanced: initial, regular: { remainH: "1", remainM: "2" } });

  app.api.persistEnhancedClock(true);
  const regular = JSON.parse(app.storage.getItem(DATA_KEY));
  assert.equal(regular.remainH, "0");
  assert.equal(regular.remainM, "11");
});

test("active deltas are capped and timestamps never move backward", () => {
  const app = timerHarness({ now: 100000 });
  app.api.setState(state({ remainingMs: 2500 }));
  app.api.setEvidenceUntil(104000);
  app.api.tickClock(400000);
  const afterGap = { ...app.api.getState() };
  assert.equal(afterGap.activeMs, 2500, "active time cannot exceed the time that was actually left");
  assert.equal(afterGap.remainingMs, 0);
  assert.equal(afterGap.on, false);

  app.api.tickClock(90000);
  const afterOldTime = app.api.getState();
  assert.equal(afterOldTime.lastTickAt, 400000, "an old GPS timestamp must not rewind the clock cursor");
  assert.equal(afterOldTime.activeMs, afterGap.activeMs);
  assert.equal(afterOldTime.remainingMs, 0);
});

test("small GPS drift cannot start the movement clock", () => {
  for (const reportedSpeed of [null, 1.0]) {
    const app = timerHarness({ now: 100000 });
    app.api.setState(state({ lastTickAt: 100000 }));
    app.api.handlePosition(position(100000, 34.700000, 135.200000, 0));
    app.setNow(101000);
    app.api.handlePosition(position(101000, 34.700009, 135.200000, reportedSpeed));

    assert.equal(app.api.getEvidenceUntil(), 0);
    assert.equal(app.api.getState().moving, false);
    assert.equal(app.api.getState().activeMs, 0);
  }
});

test("stale and out-of-order GPS fixes cannot rewind or consume the clock", () => {
  const app = timerHarness({ now: 200000 });
  app.api.setState(state({ lastTickAt: 200000 }));
  app.api.handlePosition(position(180000, 34.7, 135.2, 10));
  assert.equal(app.api.getLastPosition(), null);
  assert.equal(app.api.getState().lastTickAt, 200000);
  assert.equal(app.api.getState().remainingMs, 600000);

  app.api.handlePosition(position(200000, 34.7, 135.2, 0));
  assert.ok(app.api.getLastPosition());
  app.api.handlePosition(position(199999, 34.7002, 135.2, 10));
  assert.equal(app.api.getLastPosition().at, 200000);
  assert.equal(app.api.getState().lastTickAt, 200000);
  assert.equal(app.api.getState().remainingMs, 600000);
});

test("OFF and break states reject late movement callbacks", () => {
  for (const mode of [
    { on: false, breakOn: false },
    { on: true, breakOn: true, breakStartedAt: 90000 }
  ]) {
    const app = timerHarness({ now: 100000 });
    app.api.setState(state(mode));
    app.api.handlePosition(position(100000, 34.7, 135.2, 0));
    app.setNow(101000);
    app.api.handlePosition(position(101000, 34.7002, 135.2, 10));
    assert.equal(app.api.getEvidenceUntil(), 0);
    assert.equal(app.api.getState().activeMs, 0);
    assert.equal(app.api.getState().remainingMs, 600000);
  }
});

test("a break cannot start before the work session has started", () => {
  const app = timerHarness({ now: 100000 });
  app.api.setState(state({
    on: false,
    sessionStartAt: null,
    breakOn: false,
    breakStartedAt: null,
    breakSegments: []
  }));

  app.api.toggleBreak();
  assert.equal(app.api.getState().breakOn, false);
  assert.equal(app.api.getState().breakStartedAt, null);
  assert.equal(app.api.getState().breakSegments.length, 0);
});

test("session elapsed time subtracts only breaks overlapping the edited start time", () => {
  const app = timerHarness({ now: 10000 });
  app.api.setState(state({
    sessionStartAt: 5000,
    lastTickAt: 10000,
    breakMs: 2000,
    breakSegments: [
      { startAt: 1000, endAt: 2000 },
      { startAt: 6000, endAt: 8000 },
      { startAt: 7000, endAt: 9000 }
    ]
  }));

  assert.equal(app.api.sessionBreakMs(10000), 3000, "overlapping break records must be counted once");
  assert.equal(app.api.sessionElapsedMs(10000), 2000);
});

test("two stationary samples confirm a stop before the movement hold expires", () => {
  const app = timerHarness({ now: 100000 });
  app.api.setState(state({ lastTickAt: 100000 }));
  app.api.handlePosition(position(100000, 34.700000, 135.200000, 0));
  app.setNow(101000);
  app.api.handlePosition(position(101000, 34.700100, 135.200000, 5));
  const evidenceAfterMove = app.api.getEvidenceUntil();
  assert.ok(evidenceAfterMove > 101000);

  app.setNow(102000);
  app.api.handlePosition(position(102000, 34.700100, 135.200000, 0));
  assert.equal(app.api.getEvidenceUntil(), evidenceAfterMove, "one sample is not enough to confirm a stop");

  app.setNow(103000);
  app.api.handlePosition(position(103000, 34.700100, 135.200000, 0));
  assert.equal(app.api.getEvidenceUntil(), 0);
  assert.equal(app.api.getState().moving, false);
});

test("background recovery backfills once only after movement is confirmed again", () => {
  const app = timerHarness({ now: 100000 });
  app.api.setState(state());
  app.api.setEvidenceUntil(104000);
  app.context.document.hidden = true;
  app.dispatchDocument("visibilitychange");
  assert.equal(app.api.getState().backgroundGap.movingBefore, true);

  app.setNow(160000);
  app.context.document.hidden = false;
  app.dispatchDocument("visibilitychange");
  assert.equal(app.api.getState().activeMs, 0, "resuming alone is not enough evidence to backfill");

  app.setNow(161000);
  app.api.handlePosition(position(161000, 34.7, 135.2, 5));
  const once = { ...app.api.getState() };
  assert.equal(once.activeMs, 60000);
  assert.equal(once.remainingMs, 540000);
  assert.equal(once.lastBackfillMs, 60000);
  assert.equal(once.backgroundGap, null);

  app.setNow(162000);
  app.api.handlePosition(position(162000, 34.7001, 135.2, 5));
  assert.equal(app.api.getState().lastBackfillMs, 60000);
  assert.equal(app.api.getState().activeMs, once.activeMs + 1000, "the second fix may count live movement but not the gap again");
  assert.equal(app.api.getState().remainingMs, once.remainingMs - 1000);
});

test("reset clears every timer, break, and background field in memory and storage", () => {
  const app = timerHarness({ now: 300000 });
  app.element("done").value = "12";
  app.element("endLimit").value = "22:00";
  app.api.setState(state({
    remainingMs: 123456,
    activeMs: 99999,
    sessionStartAt: 1000,
    breakOn: true,
    breakStartedAt: 250000,
    breakMs: 50000,
    breakSegments: [{ startAt: 250000, endAt: null }],
    legacyBreakMs: 2000,
    backgroundGap: { hiddenAt: 290000, movingBefore: true, activeMsAtHidden: 99999, resumeAt: null },
    lastBackfillMs: 3000,
    lastBackfillAt: 295000
  }));

  app.element("reset").onclick();
  assert.equal(app.confirmMessages.length, 2, "the compatibility script must not replace the two-step reset transaction");
  assert.match(app.confirmMessages[0], /稼働計測をリセット/);
  assert.match(app.confirmMessages[1], /稼働記録を保存/);
  const reset = app.api.getState();
  assert.equal(reset.on, false);
  assert.equal(reset.remainingMs, 720 * 60000);
  assert.equal(reset.activeMs, 0);
  assert.equal(reset.sessionStartAt, null);
  assert.equal(reset.breakOn, false);
  assert.equal(reset.breakStartedAt, null);
  assert.equal(reset.breakMs, 0);
  assert.equal(reset.breakSegments.length, 0);
  assert.equal(reset.backgroundGap, null);
  assert.equal(reset.lastBackfillMs, 0);
  assert.equal(reset.lastBackfillAt, null);
  assert.equal(app.element("done").value, "0");
  assert.equal(app.element("endLimit").value, "");

  const persisted = JSON.parse(app.storage.getItem(ENHANCED_KEY));
  assert.equal(persisted.remainingMs, 720 * 60000);
  assert.equal(persisted.activeMs, 0);
  assert.deepEqual(persisted.breakSegments, []);
  assert.equal(persisted.backgroundGap, null);
});
