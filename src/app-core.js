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

  let storageFailureShown = false;
  let storageFrozen = false;

  // While a backup is being restored the page is about to reload. Freezing
  // stops the running clock from writing its old in-memory state over the
  // restored data on its last tick or on pagehide.
  function setStorageFrozen(frozen) {
    storageFrozen = Boolean(frozen);
  }

  // Writes related keys together. On failure (quota, private mode) the keys are
  // restored, the caller keeps running on its in-memory state, and the user is
  // told once per failure streak instead of on every clock tick.
  function storeItems(pairs, storage = globalThis.localStorage, notify = globalThis.alert) {
    if (storageFrozen) return false;
    const previous = [];
    try {
      for (const [key, value] of pairs) {
        previous.push([key, storage.getItem(key)]);
        storage.setItem(key, value);
      }
      storageFailureShown = false;
      return true;
    } catch (_) {
      for (const [key, value] of previous.reverse()) {
        try {
          if (value === null) storage.removeItem(key);
          else storage.setItem(key, value);
        } catch (__) {}
      }
      if (!storageFailureShown && typeof notify === "function") {
        storageFailureShown = true;
        try { notify("記録を端末に保存できませんでした。空き容量やプライベートブラウズの設定を確認してください。画面の時計はこのまま動き続けます。"); } catch (__) {}
      }
      return false;
    }
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

  // Quest records are separate from the published progress/clock storage contract.
  const QUEST_STORAGE_KEY = "ubereatsProgressQuestV1";
  const DAY_MS = 86400000;
  function questDayKey(at, boundaryMinutes = 0) {
    return new Date(Number(at) + (540 - boundaryMinutes) * 60000).toISOString().slice(0, 10);
  }
  function questDayStart(day, boundaryMinutes = 0) {
    return Date.parse(`${day}T00:00:00+09:00`) + boundaryMinutes * 60000;
  }

  // Storage keeps an exclusive deadline. Forms show the last included minute,
  // so "03:59まで" includes 03:59:59.999 and the next period starts at 04:00.
  function questPeriodFields(quest) {
    const parts = at => new Date(at + 540 * 60000).toISOString().slice(0, 16).split("T");
    const start = parts(quest.startAt);
    const end = parts(quest.endAt - 1);
    return { startDate: start[0], startTime: start[1], endDate: end[0], endTime: end[1] };
  }

  function questPeriodTimes(fields, previous = null) {
    const before = previous ? questPeriodFields(previous) : null;
    const read = (prefix, offset) => before && fields[`${prefix}Date`] === before[`${prefix}Date`] && fields[`${prefix}Time`] === before[`${prefix}Time`]
      ? previous[`${prefix}At`]
      : Date.parse(`${fields[`${prefix}Date`]}T${fields[`${prefix}Time`]}:00+09:00`) + offset;
    // A no-op edit must not round or migrate existing timestamps or counts.
    return { startAt: read("start", 0), endAt: read("end", 60000) };
  }
  function questDateKeys(quest) {
    const dates = [];
    for (let at = questDayStart(questDayKey(quest.startAt, quest.boundaryMinutes), quest.boundaryMinutes); at < quest.endAt && dates.length < 36; at += DAY_MS) {
      dates.push(questDayKey(at, quest.boundaryMinutes));
    }
    return dates;
  }
  function createQuestState(done = 0, at = Date.now()) {
    return { version: 1, counter: { done, epoch: 0, startedAt: at }, sequence: 0, entries: [], quests: [], selectedId: null };
  }
  function currentQuest(quests, at = Date.now()) {
    const ordered = quests.slice().sort((a, b) => a.startAt - b.startAt);
    return ordered.find(quest => quest.startAt <= at && at < quest.endAt)
      || ordered.find(quest => at < quest.startAt)
      || ordered.at(-1);
  }
  function changeQuestCount(state, nextDone, { reset = false, at = Date.now() } = {}) {
    const next = { ...state, counter: { ...state.counter }, entries: state.entries.map(entry => ({ ...entry })) };
    const done = Math.max(0, Math.floor(finite(nextDone)));
    if (reset) {
      next.counter = { ...next.counter, done, epoch: next.counter.epoch + 1, startedAt: at };
      return next;
    }
    let delta = done - next.counter.done;
    if (delta > 0) {
      next.entries.push({ id: ++next.sequence, epoch: next.counter.epoch, at, quantity: delta });
    } else if (delta < 0) {
      // Undo deliveries at their original time, including corrections after midnight/deadline.
      for (let index = next.entries.length - 1; index >= 0 && delta < 0; index -= 1) {
        const entry = next.entries[index];
        if (entry.epoch !== next.counter.epoch || entry.quantity <= 0) continue;
        const undo = Math.min(entry.quantity, -delta);
        entry.quantity -= undo;
        delta += undo;
      }
      if (delta < 0) next.entries.push({ id: ++next.sequence, epoch: next.counter.epoch, at: next.counter.startedAt, quantity: delta });
    }
    next.counter.done = done;
    return next;
  }
  function validateQuest(quest, quests = []) {
    if (!quest || typeof quest !== "object" || Array.isArray(quest)) return "クエストの設定を確認してください。";
    if (!Number.isFinite(quest.startAt) || !Number.isFinite(quest.endAt) || quest.endAt <= quest.startAt) return "終了日時を開始日時より後にしてください。";
    if (!Number.isFinite(new Date(quest.startAt).getTime()) || !Number.isFinite(new Date(quest.endAt).getTime())) return "開始・終了日時を確認してください。";
    if (quest.endAt - quest.startAt > 35 * DAY_MS) return "期間は35日以内で指定してください。";
    if (!Array.isArray(quest.tiers) || !quest.tiers.length || quest.tiers.length > 5) return "報酬の段階は1〜5段階で登録してください。";
    let previous = 0;
    for (const tier of quest.tiers) {
      if (!tier || typeof tier !== "object") return "報酬の段階を確認してください。";
      if (!Number.isInteger(tier.target) || tier.target <= previous || tier.target > 9999) return "必要件数を1〜9999件の範囲で、前の段階より多くしてください。";
      if (!Number.isInteger(tier.reward) || tier.reward < 0 || tier.reward > 9999999) return "報酬は0〜9,999,999円の整数で入力してください。";
      previous = tier.target;
    }
    if (!Number.isInteger(quest.goalIndex) || quest.goalIndex < 0 || quest.goalIndex >= quest.tiers.length) return "狙う段階を選んでください。";
    if (!Number.isInteger(quest.boundaryMinutes) || quest.boundaryMinutes < 0 || quest.boundaryMinutes >= 1440) return "開始時刻を確認してください。";
    if (quests.some(other => other.id !== quest.id && other.startAt < quest.endAt && other.endAt > quest.startAt)) return "登録済みのクエストと期間が重なっています。既存のクエストを編集してください。";
    return "";
  }
  function questDailyCounts(quest, entries) {
    const counts = Object.fromEntries(questDateKeys(quest).map(day => [day, finite(quest.adjustments && quest.adjustments[day])]));
    for (const entry of entries) {
      if (entry.at < quest.startAt || entry.at >= quest.endAt) continue;
      const day = questDayKey(entry.at, quest.boundaryMinutes);
      counts[day] = (counts[day] || 0) + finite(entry.quantity);
    }
    return counts;
  }
  function alignQuestCounts(quest, entries, total, today, at = Date.now()) {
    if (![total, today].every(value => Number.isInteger(value) && value >= 0 && value <= 99999) || today > total) throw new Error("累計と今日の件数を確認してください。今日の件数は累計以下にします。");
    const counts = questDailyCounts(quest, entries);
    const day = questDayKey(at, quest.boundaryMinutes);
    const dates = Object.keys(counts);
    const includesToday = dates.includes(day) && at >= quest.startAt;
    if (!includesToday && today !== 0) throw new Error("期間外のクエストの今日分は0件にしてください。");
    const earlier = dates.filter(value => value < day);
    if (total !== today && !earlier.length) throw new Error("初日の累計件数は、今日の件数と同じにしてください。");
    const adjustments = { ...quest.adjustments };
    const setCount = (key, wanted) => {
      adjustments[key] = finite(adjustments[key]) + wanted - finite(counts[key]);
      counts[key] = wanted;
    };
    for (const key of dates) if (counts[key] < 0) setCount(key, 0);
    if (includesToday) setCount(day, today);
    let difference = total - Object.values(counts).reduce((sum, value) => sum + value, 0);
    const unverifiedDays = new Set(quest.unverifiedDays || []);
    // A cumulative import cannot establish which of several past days contained deliveries.
    if (difference !== 0 && earlier.length > 1) earlier.forEach(key => unverifiedDays.add(key));
    if (includesToday) unverifiedDays.delete(day);
    if (difference > 0 && earlier.length) setCount(earlier.at(-1), counts[earlier.at(-1)] + difference);
    else if (difference < 0) {
      for (const key of earlier.reverse()) {
        const remove = Math.min(counts[key], -difference);
        setCount(key, counts[key] - remove);
        difference += remove;
        if (!difference) break;
      }
    }
    return { ...quest, adjustments, unverifiedDays: [...unverifiedDays].sort() };
  }
  function questTierTotals(tiers) {
    let totalReward = 0;
    return tiers.map(tier => {
      totalReward += tier.reward;
      return { ...tier, totalReward, averageReward: totalReward / tier.target };
    });
  }
  function calculateQuest(quest, entries, at = Date.now(), displayDay) {
    const raw = questDailyCounts(quest, entries);
    const counts = Object.fromEntries(Object.entries(raw).map(([day, count]) => [day, Math.max(0, count)]));
    const dates = Object.keys(counts).sort();
    const day = questDayKey(at, quest.boundaryMinutes);
    const shownDay = displayDay && dates.includes(displayDay) ? displayDay : dates.includes(day) ? day : at < quest.startAt ? dates[0] : dates.at(-1);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const goal = quest.tiers[quest.goalIndex].target;
    const plannedReward = quest.tiers.slice(0, quest.goalIndex + 1).reduce((sum, tier) => sum + tier.reward, 0);
    const earnedReward = quest.tiers.reduce((sum, tier) => sum + (total >= tier.target ? tier.reward : 0), 0);
    const phase = at < quest.startAt ? "upcoming" : at >= quest.endAt ? "ended" : "active";
    // After the deadline use only rewards actually reached in the recorded count.
    const reachedIndex = quest.tiers.reduce((index, tier, current) => total >= tier.target ? current : index, -1);
    const allocationIndex = Math.max(quest.goalIndex, reachedIndex);
    const allocationGoal = phase === "ended" ? total : quest.tiers[allocationIndex].target;
    const allocationReward = phase === "ended" ? earnedReward : quest.tiers.slice(0, allocationIndex + 1).reduce((sum, tier) => sum + tier.reward, 0);
    const rate = allocationGoal > 0 ? allocationReward / allocationGoal : 0;
    let previous = 0;
    let allocation = 0;
    for (const key of dates) {
      const current = Math.min(allocationGoal, previous + counts[key]);
      if (key === shownDay) allocation = Math.round(current * rate) - Math.round(previous * rate);
      previous = current;
    }
    const remaining = Math.max(0, goal - total);
    const remainingDays = [...new Set(quest.workDays || dates)].filter(key => dates.includes(key) && key >= day).length;
    const worksToday = (quest.workDays || dates).includes(day);
    const dailyTarget = Math.ceil(Math.max(0, goal - total + (counts[day] || 0)) / Math.max(1, remainingDays));
    const additionalToday = phase === "active" && worksToday && remainingDays ? Math.max(0, dailyTarget - (counts[day] || 0)) : null;
    const nextTier = quest.tiers.find(tier => tier.target > total) || null;
    const salesValue = quest.sales && quest.sales[shownDay];
    const sales = Number.isInteger(salesValue) && salesValue >= 0 ? salesValue : null;
    const shownDayVerified = !(quest.unverifiedDays || []).includes(shownDay);
    return { dates, day, shownDay, shownDayVerified, counts, total, today: counts[day] || 0, shownCount: shownDayVerified ? counts[shownDay] || 0 : null, goal, plannedReward, earnedReward, phase, rate, allocationGoal, allocationReward, allocation: shownDayVerified ? allocation : null, remaining, remainingDays, worksToday, additionalToday, suggestedToday: additionalToday === null ? null : dailyTarget, nextTier, sales, estimatedSales: sales === null || !shownDayVerified ? null : sales + allocation };
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
    storeItems,
    setStorageFrozen,
    formatDurationMs,
    toLocalMinuteInputValue,
    timestamp,
    QUEST_STORAGE_KEY,
    questDayKey,
    questDayStart,
    questPeriodFields,
    questPeriodTimes,
    questDateKeys,
    createQuestState,
    currentQuest,
    changeQuestCount,
    validateQuest,
    questDailyCounts,
    alignQuestCounts,
    questTierTotals,
    calculateQuest
  });
});
