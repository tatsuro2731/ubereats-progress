"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const ENHANCED_KEY = "ubereatsProgressMovementClockV1";

function instrumentedSessionUi() {
  const source = fs.readFileSync(path.join(ROOT, "app-session-ui-fix.js"), "utf8");
  const closeAt = source.lastIndexOf("})();");
  assert.ok(closeAt > 0);
  return source.slice(0, closeAt) + `
  globalThis.__sessionUiTestApi = { saveEnhancedState, breakOverlapMs };
` + source.slice(closeAt);
}

function harness(clockState, now = 500000) {
  const values = new Map();
  let saveCalls = 0;
  let calcCalls = 0;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    console,
    Date: FakeDate,
    clockState,
    CLOCK_KEY: "ubereatsProgressClockState",
    localStorage: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value))
    },
    document: {
      readyState: "loading",
      getElementById() { return null; },
      addEventListener() {}
    },
    save() { saveCalls += 1; },
    calc() { calcCalls += 1; }
  });
  vm.runInContext(instrumentedSessionUi(), context, { filename: "app-session-ui-fix.js" });
  return {
    api: context.__sessionUiTestApi,
    values,
    saveCalls: () => saveCalls,
    calcCalls: () => calcCalls
  };
}

test("saving an edited start time preserves all timer-engine state", () => {
  const state = {
    on: true,
    remainingMs: 12345678,
    activeMs: 7654321,
    sessionStartAt: 100000,
    breakOn: false,
    breakStartedAt: null,
    breakMs: 30000,
    breakSegments: [
      { startAt: 200000, endAt: 210000 },
      { startAt: 300000, endAt: 320000 }
    ],
    legacyBreakMs: 4000,
    backgroundGap: {
      hiddenAt: 450000,
      movingBefore: true,
      activeMsAtHidden: 7600000,
      resumeAt: 490000
    },
    lastBackfillMs: 40000,
    lastBackfillAt: 490500,
    updatedAt: 499000
  };
  const app = harness(state);

  app.api.saveEnhancedState();
  const saved = JSON.parse(app.values.get(ENHANCED_KEY));
  assert.equal(saved.sessionStartAt, 100000);
  assert.deepEqual(saved.breakSegments, state.breakSegments);
  assert.equal(saved.legacyBreakMs, 4000);
  assert.deepEqual(saved.backgroundGap, state.backgroundGap);
  assert.equal(saved.lastBackfillMs, 40000);
  assert.equal(saved.lastBackfillAt, 490500);
  assert.equal(saved.remainingMs, state.remainingMs);
  assert.equal(saved.activeMs, state.activeMs);
  assert.equal(saved.updatedAt, 500000);
  assert.equal(app.saveCalls(), 1);
  assert.equal(app.calcCalls(), 1);
});

test("saving an edited start time never moves lastTickAt backward", () => {
  const futureTick = 600000;
  const state = {
    on: true,
    remainingMs: 12345678,
    activeMs: 7654321,
    sessionStartAt: 100000,
    lastTickAt: futureTick,
    breakOn: false,
    breakStartedAt: null,
    breakMs: 0,
    breakSegments: [],
    legacyBreakMs: 0,
    backgroundGap: null,
    lastBackfillMs: 0,
    lastBackfillAt: null
  };
  const app = harness(state, 500000);

  app.api.saveEnhancedState();

  assert.equal(state.lastTickAt, futureTick);
  const saved = JSON.parse(app.values.get(ENHANCED_KEY));
  assert.equal(saved.updatedAt, 500000);
});

test("start-time validation computes the union of overlapping break segments", () => {
  const app = harness({
    breakMs: 999999,
    legacyBreakMs: 500,
    breakOn: false,
    breakSegments: [
      { startAt: 90000, endAt: 110000 },
      { startAt: 105000, endAt: 120000 },
      { startAt: 300000, endAt: 310000 }
    ]
  });

  assert.equal(app.api.breakOverlapMs(100000, 200000), 20500);
});
