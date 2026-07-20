"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const ENHANCED_KEY = "ubereatsProgressMovementClockV1";
const WORK_LIMIT_MS = 720 * 60000;

function usedMs(remainingMs) {
  return Math.max(0, Math.min(WORK_LIMIT_MS - remainingMs, WORK_LIMIT_MS));
}

function localInput(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function instrumentedSessionUi() {
  const source = fs.readFileSync(path.join(ROOT, "app-session-ui-fix.js"), "utf8");
  const closeAt = source.lastIndexOf("})();");
  assert.ok(closeAt > 0);
  return source.slice(0, closeAt) + `
  globalThis.__sessionUiTestApi = { saveEnhancedState, breakOverlapMs, applyStartTime, clockUsedMs };
` + source.slice(closeAt);
}

function harness(clockState, now = 500000) {
  const values = new Map();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        textContent: "",
        hidden: false,
        inert: false,
        setAttribute() {},
        focus() {}
      });
    }
    return elements.get(id);
  };
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
      body: { classList: { remove() {} } },
      getElementById: element,
      addEventListener() {}
    },
    remain() { return clockState.remainingMs / 60000; },
    save() { saveCalls += 1; },
    calc() { calcCalls += 1; }
  });
  vm.runInContext(instrumentedSessionUi(), context, { filename: "app-session-ui-fix.js" });
  return {
    api: context.__sessionUiTestApi,
    values,
    element,
    saveCalls: () => saveCalls,
    calcCalls: () => calcCalls
  };
}

test("saving an edited start time preserves session state and clears legacy movement fields", () => {
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
  const expectedActiveMs = usedMs(state.remainingMs);

  app.api.saveEnhancedState();
  const saved = JSON.parse(app.values.get(ENHANCED_KEY));
  assert.equal(saved.sessionStartAt, 100000);
  assert.equal(saved.countMode, "continuous-v1");
  assert.equal(saved.usageMode, "remaining-v1");
  assert.deepEqual(saved.breakSegments, state.breakSegments);
  assert.equal(saved.legacyBreakMs, 4000);
  assert.equal(saved.backgroundGap, null);
  assert.equal(saved.lastBackfillMs, 0);
  assert.equal(saved.lastBackfillAt, null);
  assert.equal(saved.remainingMs, state.remainingMs);
  assert.equal(saved.activeMs, expectedActiveMs);
  assert.equal(state.activeMs, expectedActiveMs);
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
  assert.equal(saved.updatedAt, futureTick);
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

test("start-time validation uses linked remaining-clock usage instead of stale GPS active time", () => {
  const minute = 60000;
  const base = 1_700_000_040_000;
  const now = base + 300 * minute;
  const makeState = () => ({
    on: false,
    remainingMs: 500 * minute,
    activeMs: 75 * minute,
    sessionStartAt: base,
    lastTickAt: now,
    breakOn: false,
    breakStartedAt: null,
    breakMs: 60 * minute,
    breakSegments: [{ startAt: base + 60 * minute, endAt: base + 120 * minute }],
    legacyBreakMs: 0
  });

  const allowedState = makeState();
  const allowed = harness(allowedState, now);
  const allowedStart = base + 20 * minute;
  allowed.element("startTimeInput").value = localInput(allowedStart);
  allowed.api.applyStartTime();
  assert.equal(allowed.element("startTimeError").textContent, "");
  assert.equal(allowedState.sessionStartAt, allowedStart);
  assert.equal(allowedState.activeMs, 220 * minute);
  assert.equal(JSON.parse(allowed.values.get(ENHANCED_KEY)).activeMs, 220 * minute);

  const rejectedState = makeState();
  const rejected = harness(rejectedState, now);
  rejected.element("startTimeInput").value = localInput(base + 21 * minute);
  rejected.api.applyStartTime();
  assert.match(rejected.element("startTimeError").textContent, /開始時刻が遅すぎます/);
  assert.equal(rejectedState.sessionStartAt, base);
  assert.equal(rejected.values.has(ENHANCED_KEY), false);
});
