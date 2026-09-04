(function exposeUberProgressCore(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.UberProgressCore = api;
})(typeof globalThis === "object" ? globalThis : this, function createUberProgressCore() {
  "use strict";

  const CONFIG = Object.freeze({
    workLimitMinutes: 720,
    workLimitMs: 720 * 60000,
    maxRemainingInputMinutes: 720 + 59,
    recoveryPaceMinutes: 10,
    orangeDelayLimitMinutes: 18,
    pastEndLimitThresholdMs: 6 * 60 * 60000,
    countMode: "continuous-v1",
    usageMode: "remaining-v1"
  });

  const STORAGE_KEYS = Object.freeze({
    progress: "ubereatsProgressFixed12Data",
    legacyClock: "ubereatsProgressClockState",
    enhancedClock: "ubereatsProgressMovementClockV1",
    history: "ubereatsProgressWorkHistoryV1",
    paceModePrefix: "ubereatsProgressPaceDisplayMode:"
  });

  function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function usedMsFromRemaining(remainingMs, limitMs = CONFIG.workLimitMs) {
    const limit = Math.max(0, finite(limitMs, CONFIG.workLimitMs));
    const remaining = Math.max(0, finite(remainingMs, limit));
    return clamp(limit - remaining, 0, limit);
  }

  function sessionUsedMsFromRemaining(remainingMs, baselineMs = 0) {
    return Math.max(0, usedMsFromRemaining(remainingMs) - clamp(finite(baselineMs, 0), 0, CONFIG.workLimitMs));
  }

  function calculateProgress({
    target,
    done,
    currentRemainingMinutes,
    effectiveRemainingMinutes = currentRemainingMinutes,
    actualUsedMinutes,
    workLimitMinutes = CONFIG.workLimitMinutes
  }) {
    const normalizedTarget = Math.max(1, finite(target, 1));
    const normalizedDone = Math.max(0, finite(done, 0));
    const currentRemaining = Math.max(0, finite(currentRemainingMinutes, 0));
    const effectiveRemaining = Math.max(0, finite(effectiveRemainingMinutes, currentRemaining));
    const workLimit = Math.max(0, finite(workLimitMinutes, CONFIG.workLimitMinutes));
    const remainingOrders = Math.max(normalizedTarget - normalizedDone, 0);
    const usedMinutes = Math.max(0, workLimit - currentRemaining);
    const measuredUsedMinutes = clamp(finite(actualUsedMinutes, usedMinutes), 0, usedMinutes);
    const availableBudgetMinutes = usedMinutes + effectiveRemaining;
    const targetPaceMinutes = availableBudgetMinutes / normalizedTarget;
    const requiredMinutes = remainingOrders * targetPaceMinutes;
    const slackMinutes = effectiveRemaining - requiredMinutes;
    const neededPaceMinutes = remainingOrders > 0 ? effectiveRemaining / remainingOrders : 0;
    const actualPaceMinutes = normalizedDone > 0 && measuredUsedMinutes > 0 ? measuredUsedMinutes / normalizedDone : NaN;
    const minutesToTarget = Number.isFinite(actualPaceMinutes) ? actualPaceMinutes * remainingOrders : NaN;
    const completionRate = clamp(normalizedDone / normalizedTarget * 100, 0, 100);
    const attainableCount = Number.isFinite(actualPaceMinutes) && actualPaceMinutes > 0
      ? normalizedDone + Math.floor(effectiveRemaining / actualPaceMinutes)
      : NaN;
    const projectedCount = Number.isFinite(actualPaceMinutes) && actualPaceMinutes > 0
      ? normalizedDone + effectiveRemaining / actualPaceMinutes
      : NaN;
    const scheduledDoneNow = targetPaceMinutes > 0 ? usedMinutes / targetPaceMinutes : 0;

    return Object.freeze({
      target: normalizedTarget,
      done: normalizedDone,
      remainingOrders,
      currentRemainingMinutes: currentRemaining,
      effectiveRemainingMinutes: effectiveRemaining,
      usedMinutes,
      actualUsedMinutes: measuredUsedMinutes,
      availableBudgetMinutes,
      targetPaceMinutes,
      requiredMinutes,
      slackMinutes,
      neededPaceMinutes,
      actualPaceMinutes,
      minutesToTarget,
      completionRate,
      attainableCount,
      projectedCount,
      scheduledDoneNow,
      scheduleDeltaOrders: normalizedDone - scheduledDoneNow
    });
  }

  function progressTone(
    slackMinutes,
    remainingOrders,
    orangeLimit = CONFIG.orangeDelayLimitMinutes,
    goodThreshold = 15
  ) {
    const slack = finite(slackMinutes, 0);
    if (finite(remainingOrders, 0) === 0 || slack >= finite(goodThreshold, 15)) return "good";
    if (slack >= 0) return "warn";
    return Math.round(Math.abs(slack)) <= orangeLimit ? "late" : "bad";
  }

  function clockLabel(timestamp) {
    return new Date(timestamp).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function resolveEndLimit(value, nowValue = Date.now()) {
    if (!value) return null;
    const [hours, minutes] = String(value).split(":").map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    const now = new Date(nowValue);
    const end = new Date(nowValue);
    end.setHours(hours, minutes, 0, 0);
    if (end <= now) {
      if (now - end <= CONFIG.pastEndLimitThresholdMs) {
        return { minutes: 0, date: end, over: true, label: clockLabel(end) };
      }
      end.setDate(end.getDate() + 1);
    }
    return {
      minutes: Math.max(0, Math.floor((end - now) / 60000)),
      date: end,
      over: false,
      label: `${end.toDateString() !== now.toDateString() ? "翌" : ""}${clockLabel(end)}`
    };
  }

  function activeConstraint(remainingMinutes, endLimit) {
    const remaining = Math.max(0, finite(remainingMinutes, 0));
    if (!endLimit) {
      return { minutes: remaining, label: "12時間制限", kind: "12h", endOn: false, endMinutes: null, endLabel: "", over: false };
    }
    const limitMinutes = Math.max(0, finite(endLimit.minutes ?? endLimit.m, 0));
    if (endLimit.over) {
      return { minutes: 0, label: `${endLimit.label}上限`, kind: "end", endOn: true, endMinutes: 0, endLabel: endLimit.label, over: true };
    }
    if (limitMinutes < remaining) {
      return { minutes: limitMinutes, label: `${endLimit.label}上限`, kind: "end", endOn: true, endMinutes: limitMinutes, endLabel: endLimit.label, over: false };
    }
    return { minutes: remaining, label: "12時間制限", kind: "12h", endOn: true, endMinutes: limitMinutes, endLabel: endLimit.label, over: false };
  }

  function segmentBounds(segment) {
    if (Array.isArray(segment)) return [segment[0], segment[1]];
    if (!segment || typeof segment !== "object") return [NaN, NaN];
    return [
      segment.startAt ?? segment.startedAt ?? segment.start,
      segment.endAt ?? segment.endedAt ?? segment.end
    ];
  }

  function overlapDurationMs(segments, startAt, endAt = Date.now()) {
    const startLimit = finite(startAt, NaN);
    const endLimit = finite(endAt, NaN);
    if (!Number.isFinite(startLimit) || !Number.isFinite(endLimit) || endLimit <= startLimit) return 0;

    const intervals = (Array.isArray(segments) ? segments : []).map(segment => {
      const [rawStart, rawEnd] = segmentBounds(segment);
      const start = finite(rawStart, NaN);
      const end = rawEnd === null || rawEnd === undefined ? endLimit : finite(rawEnd, NaN);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const overlapStart = Math.max(startLimit, start);
      const overlapEnd = Math.min(endLimit, end);
      return overlapEnd > overlapStart ? [overlapStart, overlapEnd] : null;
    }).filter(Boolean).sort((left, right) => left[0] - right[0]);

    let total = 0;
    let mergedStart = null;
    let mergedEnd = null;
    for (const [start, end] of intervals) {
      if (mergedStart === null) {
        mergedStart = start;
        mergedEnd = end;
      } else if (start <= mergedEnd) {
        mergedEnd = Math.max(mergedEnd, end);
      } else {
        total += mergedEnd - mergedStart;
        mergedStart = start;
        mergedEnd = end;
      }
    }
    if (mergedStart !== null) total += mergedEnd - mergedStart;
    return Math.max(0, total);
  }

  function breakDurationMs(state, startAt, endAt = Date.now()) {
    if (!state) return 0;
    const hasSegments = Array.isArray(state.breakSegments);
    const segments = hasSegments ? state.breakSegments : [];
    const legacyMs = Math.max(0, finite(state.legacyBreakMs, 0), hasSegments ? 0 : finite(state.breakMs, 0));
    const excludedMs = clamp(finite(state.legacyBreakExcludedMs, 0), 0, legacyMs);
    const ranges = !segments.length && state.breakOn && state.breakStartedAt
      ? [{ startAt: state.breakStartedAt, endAt: null }]
      : segments;
    return legacyMs - excludedMs + overlapDurationMs(ranges, startAt, endAt);
  }

  function normalizeSegments(value, { active = false, activeStartedAt = null, at = Date.now(), maxSegments = 200 } = {}) {
    const normalizedAt = finite(at, Date.now());
    const segments = (Array.isArray(value) ? value : []).map(segment => {
      const [rawStart, rawEnd] = segmentBounds(segment);
      const startAt = finite(rawStart, NaN);
      const endAt = rawEnd === null || rawEnd === undefined ? null : finite(rawEnd, NaN);
      if (!Number.isFinite(startAt) || startAt <= 0) return null;
      if (endAt !== null && (!Number.isFinite(endAt) || endAt < startAt)) return null;
      return { startAt, endAt };
    }).filter(Boolean).sort((left, right) => left.startAt - right.startAt).slice(-Math.max(1, maxSegments));

    let keptOpen = false;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (segments[index].endAt !== null) continue;
      if (active && !keptOpen) keptOpen = true;
      else segments[index].endAt = normalizedAt;
    }
    if (active && !keptOpen) {
      segments.push({ startAt: finite(activeStartedAt, normalizedAt), endAt: null });
    }
    return segments;
  }

  function formatDurationMs(milliseconds, rounding = "floor") {
    const rawMinutes = Math.max(0, finite(milliseconds, 0)) / 60000;
    const totalMinutes = rounding === "ceil" ? Math.ceil(rawMinutes) : Math.floor(rawMinutes);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}時間${String(minutes).padStart(2, "0")}分`;
  }

  function toLocalMinuteInputValue(timestamp) {
    const date = new Date(timestamp);
    const pad = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function timestamp(value, fallback = NaN) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    if (typeof value !== "string" || !value.trim()) return fallback;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return Object.freeze({
    CONFIG,
    STORAGE_KEYS,
    finite,
    clamp,
    usedMsFromRemaining,
    sessionUsedMsFromRemaining,
    calculateProgress,
    progressTone,
    clockLabel,
    resolveEndLimit,
    activeConstraint,
    overlapDurationMs,
    breakDurationMs,
    normalizeSegments,
    formatDurationMs,
    toLocalMinuteInputValue,
    timestamp
  });
});
