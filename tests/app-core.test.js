"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONFIG,
  STORAGE_KEYS,
  activeConstraint,
  calculateProgress,
  estimateFinish,
  formatDurationMs,
  normalizeSegments,
  overlapDurationMs,
  progressTone,
  relativeDayPrefix,
  resolveEndLimit,
  storeItems,
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

test("the finish estimate converts Uber time to the wall clock with the operation rate", () => {
  const minute = 60000;
  const at = new Date(2026, 8, 27, 15, 0).getTime();
  const inputs = { at, done: 20, remainingOrders: 20, usedMs: 255 * minute, elapsedMs: 300 * minute, remainingMs: 465 * minute };
  const estimate = estimateFinish(inputs);
  const progress = calculateProgress({ target: 40, done: 20, currentRemainingMinutes: 465, actualUsedMinutes: 255 });

  assert.equal(estimate.ready, true);
  assert.equal(estimate.rate, 0.85);
  assert.equal(estimate.paceMinutes, 15, "elapsed time without breaks ÷ done");
  assert.equal(estimate.finishAt, at + 300 * minute);
  assert.ok(Math.abs(estimate.finishAt - at - progress.minutesToTarget / estimate.rate * minute) < 1e-6, "actual pace ÷ operation rate");
  assert.equal(progress.minutesToTarget, 255, "the existing forecast still assumes an unstopped Uber clock");
  assert.equal(estimate.reachesLimit, false);
  assert.equal(estimate.displayAt, estimate.finishAt);

  const unstopped = estimateFinish({ ...inputs, usedMs: 300 * minute, remainingMs: 420 * minute });
  const unstoppedProgress = calculateProgress({ target: 40, done: 20, currentRemainingMinutes: 420, actualUsedMinutes: 300 });
  assert.equal(unstopped.rate, 1);
  assert.equal(unstopped.finishAt - at, unstoppedProgress.minutesToTarget * minute, "at 100% it matches the existing forecast");
});

test("the finish estimate stops at the earlier wall-clock limit", () => {
  const minute = 60000;
  const at = new Date(2026, 8, 27, 15, 0).getTime();
  const inputs = { at, done: 20, remainingOrders: 20, usedMs: 255 * minute, elapsedMs: 300 * minute, remainingMs: 200 * minute };

  const clock = estimateFinish(inputs);
  assert.equal(clock.reachesLimit, true, "255 Uber minutes are needed but 200 remain");
  assert.equal(clock.limitKind, "12h");
  assert.ok(Math.abs(clock.displayAt - (at + 200 * minute / 0.85)) < 1e-6, "the 12-hour clock empties remaining ÷ rate later");

  const endLimit = estimateFinish({ ...inputs, remainingMs: 465 * minute, endLimitAt: at + 120 * minute });
  assert.equal(endLimit.reachesLimit, true);
  assert.equal(endLimit.limitKind, "end");
  assert.equal(endLimit.displayAt, at + 120 * minute);

  // 300 Uber minutes last 375 minutes at 80%, so a 330-minute end limit comes first.
  const wallClock = estimateFinish({ at, done: 10, remainingOrders: 40, usedMs: 240 * minute, elapsedMs: 300 * minute, remainingMs: 300 * minute, endLimitAt: at + 330 * minute });
  assert.equal(wallClock.limitKind, "end");
  assert.equal(wallClock.displayAt, at + 330 * minute);

  const laterEnd = estimateFinish({ ...inputs, endLimitAt: at + 600 * minute });
  assert.equal(laterEnd.limitKind, "12h", "an end limit after the clock empties is not the limit");
  const pastEnd = estimateFinish({ ...inputs, remainingMs: 465 * minute, endLimitAt: at - minute });
  assert.equal(pastEnd.reachesLimit, false, "a passed end limit is reported by the caller");
  assert.equal(pastEnd.displayAt, at + 300 * minute);

  const empty = estimateFinish({ ...inputs, remainingMs: 0 });
  assert.equal(empty.reachesLimit, true);
  assert.equal(empty.displayAt, at);
  const achieved = estimateFinish({ ...inputs, remainingOrders: 0 });
  assert.equal(achieved.reachesLimit, false);
  assert.equal(achieved.displayAt, at);
});

test("the finish estimate waits for a delivery and measured Uber time", () => {
  const minute = 60000;
  const inputs = { at: 1_000_000, done: 5, remainingOrders: 10, usedMs: 50 * minute, elapsedMs: 60 * minute, remainingMs: 600 * minute };
  for (const missing of [{ done: 0 }, { usedMs: 0 }, { elapsedMs: 0 }, { done: undefined }]) {
    const estimate = estimateFinish({ ...inputs, ...missing });
    assert.equal(estimate.ready, false, JSON.stringify(missing));
    assert.ok(Number.isNaN(estimate.finishAt));
    assert.ok(Number.isNaN(estimate.displayAt));
    assert.equal(estimate.reachesLimit, false);
  }
  const overlapping = estimateFinish({ ...inputs, usedMs: 90 * minute });
  assert.equal(overlapping.rate, 1, "Uber time never exceeds the elapsed time");
  assert.equal(overlapping.finishAt, inputs.at + 120 * minute);
});

test("finish labels mark later calendar days", () => {
  const now = new Date(2026, 8, 27, 23, 30).getTime();
  assert.equal(relativeDayPrefix(new Date(2026, 8, 27, 23, 59).getTime(), now), "");
  assert.equal(relativeDayPrefix(new Date(2026, 8, 28, 0, 15).getTime(), now), "翌");
  assert.equal(relativeDayPrefix(new Date(2026, 8, 29, 9, 0).getTime(), now), "2日後");
  assert.equal(relativeDayPrefix(new Date(2026, 9, 1, 9, 0).getTime(), now), "4日後");
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

test("storeItems restores related keys and alerts once per failure streak", () => {
  const values = new Map([["a", "old-a"]]);
  let failKey = "b";
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem(key, value) {
      if (key === failKey) throw new Error("QuotaExceededError");
      values.set(key, String(value));
    },
    removeItem: key => values.delete(key)
  };
  const alerts = [];
  const notify = message => alerts.push(message);

  assert.equal(storeItems([["a", "new-a"], ["b", "new-b"]], storage, notify), false);
  assert.equal(values.get("a"), "old-a", "the first key is rolled back");
  assert.equal(values.has("b"), false);
  assert.equal(storeItems([["a", "new-a"], ["b", "new-b"]], storage, notify), false);
  assert.equal(alerts.length, 1, "repeated clock ticks alert only once");

  failKey = null;
  assert.equal(storeItems([["a", "new-a"], ["b", "new-b"]], storage, notify), true);
  assert.equal(values.get("b"), "new-b");
  failKey = "a";
  assert.equal(storeItems([["a", "x"]], storage, notify), false);
  assert.equal(alerts.length, 2, "a new failure after a success alerts again");
  assert.doesNotThrow(() => storeItems([["a", "x"]], { getItem() { throw new Error("denied"); } }, null));
});
