"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const ENHANCED_KEY = "ubereatsProgressMovementClockV1";
const HISTORY_KEY = "ubereatsProgressWorkHistoryV1";
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
    setExactRemaining,
    enhancedToggleClock,
    toggleBreak,
    finishSession,
    sessionBreakMs,
    sessionElapsedMs,
    persistEnhancedClock,
    beginBackgroundGap,
    resumeBackgroundGap,
    renderEnhancedClock,
    remainingText,
    durationText,
    exhaustionText,
    getState: () => clockState,
    setState: value => { clockState = value; }
  };
`;
  return source.slice(0, closeAt) + exports + source.slice(closeAt);
}

function timerHarness(options = {}) {
  let now = options.now || 1_000_000;
  const initialEnhanced = options.enhanced || {
    countMode: "continuous-v1",
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
  let geolocationRequests = 0;
  const confirmMessages = [];
  const navigator = {
    geolocation: {
      watchPosition() {
        geolocationRequests += 1;
        throw new Error("continuous clock must not request geolocation");
      },
      clearWatch() {}
    }
  };
  const windowListeners = new Map();
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
    window: {
      addEventListener(type, listener) {
        const list = windowListeners.get(type) || [];
        list.push(listener);
        windowListeners.set(type, list);
      }
    },
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
    geolocationRequests: () => geolocationRequests,
    element,
    now: () => now,
    setNow(value) { now = value; },
    dispatchDocument(type) {
      for (const listener of documentListeners.get(type) || []) listener({ type });
    },
    dispatchWindow(type, extra = {}) {
      for (const listener of windowListeners.get(type) || []) listener({ type, ...extra });
    }
  };
}

function state(overrides = {}) {
  return {
    countMode: "continuous-v1",
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
  assert.match(app.element("movementDetail").textContent, /時間OFF中/);
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
  app.api.tickClock(400000);
  const afterGap = { ...app.api.getState() };
  assert.equal(afterGap.activeMs, 2500, "active time cannot exceed the time that was actually left");
  assert.equal(afterGap.remainingMs, 0);
  assert.equal(afterGap.on, false);

  app.api.tickClock(90000);
  const afterOldTime = app.api.getState();
  assert.equal(afterOldTime.lastTickAt, 400000, "an old timestamp must not rewind the clock cursor");
  assert.equal(afterOldTime.activeMs, afterGap.activeMs);
  assert.equal(afterOldTime.remainingMs, 0);
});

test("time ON continuously consumes elapsed seconds without requesting geolocation", () => {
  const app = timerHarness({ now: 100000 });
  app.api.setState(state({ lastTickAt: 100000 }));

  app.api.tickClock(159999);
  assert.equal(app.api.getState().remainingMs, 540001);
  assert.equal(app.api.getState().activeMs, 59999);
  app.api.tickClock(160000);
  assert.equal(app.api.getState().remainingMs, 540000);
  assert.equal(app.api.getState().activeMs, 60000);
  assert.equal(app.geolocationRequests(), 0);
});

test("time OFF and breaks pause the continuous countdown", () => {
  const app = timerHarness({ now: 100000 });

  app.api.setState(state({ on: false, lastTickAt: 100000 }));
  app.api.tickClock(160000);
  assert.equal(app.api.getState().remainingMs, 600000);
  assert.equal(app.api.getState().activeMs, 0);

  app.api.setState(state({ breakOn: true, breakStartedAt: 100000, lastTickAt: 100000 }));
  app.api.tickClock(220000);
  assert.equal(app.api.getState().remainingMs, 600000);
  assert.equal(app.api.getState().activeMs, 0);
  assert.equal(app.geolocationRequests(), 0);
});

test("the first time ON starts one session and later toggles keep its start", () => {
  const app = timerHarness({ now: 100000 });
  app.api.setState(state({ on: false, sessionStartAt: null, lastTickAt: 100000 }));

  app.setNow(200000);
  app.api.enhancedToggleClock();
  assert.equal(app.api.getState().on, true);
  assert.equal(app.api.getState().sessionStartAt, 200000);

  app.setNow(260000);
  app.api.enhancedToggleClock();
  assert.equal(app.api.getState().on, false);
  assert.equal(app.api.getState().activeMs, 60000);

  app.setNow(300000);
  app.api.enhancedToggleClock();
  assert.equal(app.api.getState().sessionStartAt, 200000);
  assert.equal(app.geolocationRequests(), 0);
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

test("background time is consumed exactly once while the clock is ON", () => {
  const app = timerHarness({ now: 100000 });
  app.api.setState(state({ lastTickAt: 100000 }));
  app.context.document.hidden = true;
  app.dispatchDocument("visibilitychange");

  app.setNow(120000);
  app.dispatchWindow("pagehide");
  assert.equal(app.api.getState().activeMs, 20000);
  assert.equal(app.api.getState().remainingMs, 580000);

  app.setNow(160000);
  app.context.document.hidden = false;
  app.dispatchDocument("visibilitychange");
  assert.equal(app.api.getState().activeMs, 60000);
  assert.equal(app.api.getState().remainingMs, 540000);

  app.dispatchDocument("visibilitychange");
  assert.equal(app.api.getState().activeMs, 60000, "a repeated foreground event must not consume the gap twice");
  assert.equal(app.api.getState().remainingMs, 540000);
  assert.equal(app.geolocationRequests(), 0);
});

test("main view adopts an exact compact-clock edit from the storage event", () => {
  const app = timerHarness({ now: 100000 });
  const external = state({
    on: false,
    remainingMs: 321234,
    activeMs: 98765,
    sessionStartAt: 5000,
    lastTickAt: undefined,
    updatedAt: 160000
  });
  const externalJson = JSON.stringify(external);

  app.setNow(160000);
  app.storage.setItem(ENHANCED_KEY, externalJson);
  app.dispatchWindow("storage", { key: ENHANCED_KEY, newValue: externalJson });

  assert.equal(app.api.getState().on, false);
  assert.equal(app.api.getState().remainingMs, 321234);
  assert.equal(app.api.getState().activeMs, 98765);
  assert.equal(app.api.getState().sessionStartAt, 5000);
  app.setNow(220000);
  app.api.tickClock();
  assert.equal(app.api.getState().remainingMs, 321234, "an imported OFF clock must stay paused");
});

test("main view ignores an older delayed clock update", () => {
  const app = timerHarness({ now: 200000 });
  app.api.setState(state({
    on: false,
    remainingMs: 500000,
    activeMs: 100000,
    lastTickAt: 200000,
    updatedAt: 200000
  }));
  const stale = state({
    on: true,
    remainingMs: 590000,
    activeMs: 10000,
    lastTickAt: undefined,
    updatedAt: 150000
  });
  const staleJson = JSON.stringify(stale);

  app.storage.setItem(ENHANCED_KEY, staleJson);
  app.dispatchWindow("storage", { key: ENHANCED_KEY, newValue: staleJson });

  assert.equal(app.api.getState().on, false);
  assert.equal(app.api.getState().remainingMs, 500000);
  assert.equal(app.api.getState().activeMs, 100000);
});

test("an explicit edit wins over a newer unpersisted display tick", () => {
  const app = timerHarness({ now: 200000 });
  app.api.setState(state({
    on: true,
    remainingMs: 500000,
    activeMs: 100000,
    lastTickAt: 200000,
    updatedAt: 100000
  }));
  const external = state({
    on: false,
    remainingMs: 321000,
    activeMs: 150000,
    lastTickAt: undefined,
    updatedAt: 150000
  });
  const externalJson = JSON.stringify(external);

  app.storage.setItem(ENHANCED_KEY, externalJson);
  app.dispatchWindow("storage", { key: ENHANCED_KEY, newValue: externalJson });

  assert.equal(app.api.getState().on, false);
  assert.equal(app.api.getState().remainingMs, 321000);
  assert.equal(app.api.getState().activeMs, 150000);
});

test("pageshow reloads a compact edit before resuming a BFCache-restored clock", () => {
  const app = timerHarness({ now: 100000 });
  const external = state({
    on: true,
    remainingMs: 300000,
    activeMs: 40000,
    sessionStartAt: 5000,
    lastTickAt: undefined,
    updatedAt: 150000
  });

  app.storage.setItem(ENHANCED_KEY, JSON.stringify(external));
  app.setNow(200000);
  app.dispatchWindow("pageshow");

  assert.equal(app.api.getState().remainingMs, 250000);
  assert.equal(app.api.getState().activeMs, 90000);
  assert.equal(app.api.getState().sessionStartAt, 5000);
  app.dispatchWindow("pageshow");
  assert.equal(app.api.getState().remainingMs, 250000, "repeated pageshow at the same instant must not double-count");
  assert.equal(app.api.getState().activeMs, 90000);
});

test("old movement state migrates without retroactively consuming its stored gap", () => {
  const app = timerHarness({
    now: 200000,
    enhanced: {
      on: true,
      remainingMs: 600000,
      activeMs: 12000,
      sessionStartAt: 1000,
      breakOn: false,
      backgroundGap: { hiddenAt: 100000, movingBefore: true, activeMsAtHidden: 12000, resumeAt: null },
      updatedAt: 100000
    }
  });

  assert.equal(app.api.getState().remainingMs, 600000);
  assert.equal(app.api.getState().activeMs, 12000);
  assert.equal(app.api.getState().backgroundGap, null);
  assert.equal(app.api.getState().countMode, "continuous-v1");
  assert.equal(JSON.parse(app.storage.getItem(ENHANCED_KEY)).countMode, "continuous-v1");
  assert.equal(app.geolocationRequests(), 0);
});

test("continuous state catches up once after a reload", () => {
  const app = timerHarness({
    now: 160000,
    enhanced: state({ remainingMs: 600000, activeMs: 20000, lastTickAt: undefined, updatedAt: 100000 })
  });

  assert.equal(app.api.getState().remainingMs, 540000);
  assert.equal(app.api.getState().activeMs, 80000);
  app.api.tickClock(160000);
  assert.equal(app.api.getState().remainingMs, 540000);
  assert.equal(app.api.getState().activeMs, 80000);
});

test("a future monotonic anchor does not double-count after the device clock moves backward", () => {
  const app = timerHarness({
    now: 100000,
    enhanced: state({ remainingMs: 600000, activeMs: 20000, lastTickAt: undefined, updatedAt: 200000 })
  });

  assert.equal(app.api.getState().remainingMs, 600000);
  assert.equal(JSON.parse(app.storage.getItem(ENHANCED_KEY)).updatedAt, 200000);
  app.setNow(150000);
  app.api.tickClock();
  assert.equal(app.api.getState().remainingMs, 600000);

  app.setNow(250000);
  app.api.tickClock();
  assert.equal(app.api.getState().remainingMs, 550000);
  assert.equal(app.api.getState().activeMs, 70000);
});

test("the use-up time stays fixed while counting and slides while paused", () => {
  const app = timerHarness({ now: 100000 });
  app.api.setState(state({ remainingMs: 600000, lastTickAt: 100000 }));
  const runningEnd = app.api.exhaustionText(100000);
  app.api.tickClock(160000);
  assert.equal(app.api.exhaustionText(160000), runningEnd);

  app.api.getState().on = false;
  assert.notEqual(app.api.exhaustionText(220000), runningEnd);
});

test("ending a session records once and freezes the continuous clock", () => {
  const app = timerHarness({ now: 200000 });
  app.api.setState(state({ remainingMs: 600000, activeMs: 0, sessionStartAt: 100000, lastTickAt: 100000 }));

  app.api.finishSession();
  const finished = { ...app.api.getState() };
  const history = JSON.parse(app.storage.getItem(HISTORY_KEY));
  assert.equal(history.length, 1);
  assert.equal(finished.on, false);
  assert.equal(finished.sessionEndedAt, 200000);
  assert.equal(finished.activeMs, 100000);

  app.setNow(400000);
  app.api.tickClock();
  app.api.finishSession();
  assert.equal(app.api.getState().remainingMs, finished.remainingMs);
  assert.equal(app.api.getState().activeMs, finished.activeMs);
  assert.equal(JSON.parse(app.storage.getItem(HISTORY_KEY)).length, 1);
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
