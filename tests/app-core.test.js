"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONFIG,
  STORAGE_KEYS,
  activeConstraint,
  calculateProgress,
  formatDurationMs,
  normalizeSegments,
  overlapDurationMs,
  progressTone,
  resolveEndLimit,
  timestamp,
  usedMsFromRemaining
} = require("../src/app-core.js");

test("the core keeps the deployed constants and storage contracts", () => {
  assert.equal(CONFIG.workLimitMinutes, 720);
  assert.equal(CONFIG.maxRemainingInputMinutes, 779);
  assert.equal(CONFIG.orangeDelayLimitMinutes, 18);
  assert.deepEqual(STORAGE_KEYS, {
    progress: "ubereatsProgressFixed12Data",
    legacyClock: "ubereatsProgressClockState",
    enhancedClock: "ubereatsProgressMovementClockV1",
    history: "ubereatsProgressWorkHistoryV1",
    paceModePrefix: "ubereatsProgressPaceDisplayMode:"
  });
});

test("progress calculation reproduces the fixed-12-hour model", () => {
  const result = calculateProgress({
    target: 46,
    done: 10,
    currentRemainingMinutes: 612,
    effectiveRemainingMinutes: 612
  });

  assert.equal(result.remainingOrders, 36);
  assert.equal(result.usedMinutes, 108);
  assert.equal(result.targetPaceMinutes, 720 / 46);
  assert.equal(result.requiredMinutes, 36 * 720 / 46);
  assert.ok(Math.abs(result.slackMinutes - 48.52173913043475) < 1e-9);
  assert.equal(result.neededPaceMinutes, 17);
  assert.equal(result.actualPaceMinutes, 10.8);
  assert.equal(result.attainableCount, 66);
});

test("an earlier end limit changes only the effective delivery budget", () => {
  const result = calculateProgress({
    target: 40,
    done: 10,
    currentRemainingMinutes: 540,
    effectiveRemainingMinutes: 300
  });

  assert.equal(result.usedMinutes, 180);
  assert.equal(result.availableBudgetMinutes, 480);
  assert.equal(result.targetPaceMinutes, 12);
  assert.equal(result.requiredMinutes, 360);
  assert.equal(result.slackMinutes, -60);
  assert.equal(result.neededPaceMinutes, 10);
});

test("edited work changes actual forecasts while preserving progress and end-limit formulas", () => {
  const inputs = { target: 40, done: 20, currentRemainingMinutes: 480, effectiveRemainingMinutes: 60 };
  const original = calculateProgress(inputs);
  const edited = calculateProgress({ ...inputs, actualUsedMinutes: 120 });
  for (const key of ["usedMinutes", "availableBudgetMinutes", "targetPaceMinutes", "requiredMinutes", "slackMinutes", "neededPaceMinutes", "completionRate", "scheduledDoneNow"]) {
    assert.equal(edited[key], original[key], `${key} must retain the existing delivery-budget meaning`);
  }
  assert.equal(edited.actualPaceMinutes, 6);
  assert.equal(edited.minutesToTarget, 120);
  assert.equal(edited.attainableCount, 30);
  assert.equal(edited.projectedCount, 30);
  const unmeasured = calculateProgress({ ...inputs, actualUsedMinutes: 0 });
  assert.ok(Number.isNaN(unmeasured.actualPaceMinutes));
  assert.ok(Number.isNaN(unmeasured.projectedCount));
});

test("progress tone keeps 18 minutes orange and changes at 19", () => {
  assert.equal(progressTone(-18, 10), "late");
  assert.equal(progressTone(-19, 10), "bad");
  assert.equal(progressTone(0, 10), "warn");
  assert.equal(progressTone(15, 10), "good");
  assert.equal(progressTone(14, 10, 18, 12), "good");
  assert.equal(progressTone(11, 10, 18, 12), "warn");
  assert.equal(progressTone(-100, 0), "good");
});

test("end-limit resolution preserves the six-hour past-time rule", () => {
  const now = new Date(2026, 7, 18, 10, 0, 0, 0).getTime();
  const recentPast = resolveEndLimit("08:00", now);
  assert.equal(recentPast.over, true);
  assert.equal(recentPast.minutes, 0);

  const nextDay = resolveEndLimit("01:00", now);
  assert.equal(nextDay.over, false);
  assert.equal(nextDay.minutes, 15 * 60);

  const endConstraint = activeConstraint(600, nextDay);
  assert.equal(endConstraint.kind, "12h");
  assert.equal(endConstraint.minutes, 600);

  const sameDay = resolveEndLimit("14:00", now);
  const shortConstraint = activeConstraint(700, sameDay);
  assert.equal(shortConstraint.kind, "end");
  assert.equal(shortConstraint.minutes, 4 * 60);
});

test("overlap duration merges intersecting segments and clips the window", () => {
  const segments = [
    { startAt: 90, endAt: 130 },
    { startAt: 120, endAt: 150 },
    [170, 190],
    { startedAt: 180, endedAt: 220 },
    { startAt: 240, endAt: null }
  ];
  assert.equal(overlapDurationMs(segments, 100, 250), 110);
});

test("segment normalization closes duplicate open ranges and keeps one active range", () => {
  const result = normalizeSegments([
    { startAt: 100, endAt: null },
    { startAt: 200, endAt: null },
    { startAt: 50, endAt: 80 },
    { startAt: -1, endAt: 20 }
  ], { active: true, activeStartedAt: 200, at: 300 });

  assert.deepEqual(result, [
    { startAt: 50, endAt: 80 },
    { startAt: 100, endAt: 300 },
    { startAt: 200, endAt: null }
  ]);
});

test("time and history helpers retain exact engine semantics", () => {
  assert.equal(usedMsFromRemaining(600 * 60000), 120 * 60000);
  assert.equal(usedMsFromRemaining(800 * 60000), 0);
  assert.equal(usedMsFromRemaining(-1), CONFIG.workLimitMs);
  assert.equal(formatDurationMs(61.9 * 60000), "1時間01分");
  assert.equal(formatDurationMs(61.1 * 60000, "ceil"), "1時間02分");
  assert.equal(timestamp("2026-08-18T10:30"), new Date("2026-08-18T10:30").getTime());
});
