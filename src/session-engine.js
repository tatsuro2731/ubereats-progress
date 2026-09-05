(() => {
  "use strict";

  const {
    CONFIG,
    STORAGE_KEYS,
    breakDurationMs,
    clamp,
    finite,
    formatDurationMs,
    normalizeSegments,
    overlapDurationMs,
    sessionUsedMsFromRemaining,
    timestamp,
    toLocalMinuteInputValue: coreToLocalMinuteInputValue,
    usedMsFromRemaining
  } = UberProgressCore;
  const ENHANCED_CLOCK_KEY = STORAGE_KEYS.enhancedClock;
  const LEGACY_CLOCK_KEY = STORAGE_KEYS.legacyClock;
  const HISTORY_KEY = STORAGE_KEYS.history;
  const COUNT_MODE = CONFIG.countMode;
  const USAGE_MODE = CONFIG.usageMode;
  const WORK_LIMIT_MS = CONFIG.workLimitMs;
  const MAX_REMAIN_INPUT_MINUTES = CONFIG.maxRemainingInputMinutes;
  const SAVE_INTERVAL_MS = 5000;

  const legacyRemain = typeof remain === "function" ? remain() : manualRemain();
  let lastSavedAt = 0;
  let pendingConfirmAction = null;
  let confirmReturnFocus = null;
  let finalizingSession = false;
  let historyEndEditorState = null;

  function nowMs() { return Date.now(); }
  function totalClockUsedMs(remainingMs = clockState.remainingMs) {
    return usedMsFromRemaining(remainingMs, WORK_LIMIT_MS);
  }

  function usageBaselineMs(remainingMs = clockState.remainingMs) {
    return clamp(finite(clockState && clockState.usageBaselineMs, 0), 0, WORK_LIMIT_MS);
  }

  function clockUsedMs(remainingMs = clockState.remainingMs) {
    return sessionUsedMsFromRemaining(remainingMs, usageBaselineMs(remainingMs));
  }

  function syncClockUsage() {
    clockState.usageMode = USAGE_MODE;
    clockState.activeMs = clockUsedMs(clockState.remainingMs);
    return clockState.activeMs;
  }

  function defaultEnhancedState() {
    const now = nowMs();
    const remainingMs = Math.max(0, legacyRemain * 60000);
    const startsSession = Boolean(clockState && clockState.on);
    const initialBaselineMs = startsSession ? usedMsFromRemaining(remainingMs, WORK_LIMIT_MS) : 0;
    return {
      countMode: COUNT_MODE,
      usageMode: USAGE_MODE,
      on: Boolean(clockState && clockState.on),
      remainingMs,
      baseRemain: Math.max(0, legacyRemain),
      baseAt: now,
      lastTickAt: now,
      moving: false,
      activeMs: Math.max(0, usedMsFromRemaining(remainingMs, WORK_LIMIT_MS) - initialBaselineMs),
      usageBaselineMs: initialBaselineMs,
      sessionStartAt: startsSession ? now : null,
      sessionEndedAt: null,
      breakOn: false,
      breakStartedAt: null,
      breakMs: 0,
      breakSegments: [],
      legacyBreakMs: 0,
      legacyBreakExcludedMs: 0,
      otherCompanyOn: false,
      otherCompanyStartedAt: null,
      otherCompanyMs: 0,
      otherCompanySegments: [],
      legacyOtherCompanyMs: 0,
      backgroundGap: null,
      lastBackfillMs: 0,
      lastBackfillAt: null,
      updatedAt: now
    };
  }

  function normalizeBreakSegments(value, breakOn, breakStartedAt, now) {
    return normalizeSegments(value, {
      active: breakOn,
      activeStartedAt: breakStartedAt,
      at: now,
      maxSegments: 200
    });
  }

  function normalizeState(data) {
    const fallback = defaultEnhancedState();
    const now = nowMs();
    const remainingMs = finite(data && data.remainingMs, fallback.remainingMs);
    const sessionStartAt = data && data.sessionStartAt ? finite(data.sessionStartAt, now) : null;
    const rawSessionEndedAt = data && data.sessionEndedAt ? finite(data.sessionEndedAt, NaN) : NaN;
    const sessionEndedAt = sessionStartAt && Number.isFinite(rawSessionEndedAt) && rawSessionEndedAt >= sessionStartAt
      ? rawSessionEndedAt
      : null;
    const stateAt = sessionEndedAt || now;
    const isContinuousState = Boolean(data && data.countMode === COUNT_MODE);
    const rawUpdatedAt = finite(data && data.updatedAt, now);
    const resumeAt = isContinuousState && rawUpdatedAt > 0 ? rawUpdatedAt : now;
    const storedBreakOn = Boolean(data && data.breakOn);
    const clockOn = !sessionEndedAt && Boolean(data && data.on) && !storedBreakOn;
    const breakOn = !sessionEndedAt && Boolean(sessionStartAt) && !clockOn;
    const automaticBreakStart = Math.max(finite(sessionStartAt, resumeAt), resumeAt);
    const storedBreakStartedAt = finite(data && data.breakStartedAt, NaN);
    const breakStartedAt = breakOn && Number.isFinite(storedBreakStartedAt) && storedBreakStartedAt > 0
      ? Math.max(finite(sessionStartAt, storedBreakStartedAt), storedBreakStartedAt)
      : breakOn
        ? automaticBreakStart
        : null;
    const hasBreakSegments = Boolean(data && Array.isArray(data.breakSegments));
    const otherCompanyOn = clockOn && Boolean(data && data.otherCompanyOn);
    const otherCompanyStartedAt = otherCompanyOn ? finite(data && data.otherCompanyStartedAt, stateAt) : null;
    const otherCompanyStateAt = !clockOn && breakOn ? breakStartedAt : stateAt;
    const hasOtherCompanySegments = Boolean(data && Array.isArray(data.otherCompanySegments));
    const rawUsedMs = usedMsFromRemaining(remainingMs, WORK_LIMIT_MS);
    const usageBaselineMs = clamp(finite(data && data.usageBaselineMs, 0), 0, WORK_LIMIT_MS);
    return {
      countMode: COUNT_MODE,
      usageMode: USAGE_MODE,
      on: clockOn,
      remainingMs: clamp(remainingMs, 0, MAX_REMAIN_INPUT_MINUTES * 60000),
      baseRemain: remainingMs / 60000,
      baseAt: now,
      lastTickAt: resumeAt,
      moving: false,
      activeMs: Math.max(0, rawUsedMs - usageBaselineMs),
      usageBaselineMs,
      sessionStartAt,
      sessionEndedAt,
      breakOn,
      breakStartedAt,
      breakMs: Math.max(0, finite(data && data.breakMs, 0)),
      breakSegments: normalizeBreakSegments(data && data.breakSegments, breakOn, breakStartedAt, stateAt),
      legacyBreakMs: hasBreakSegments ? Math.max(0, finite(data && data.legacyBreakMs, 0)) : Math.max(0, finite(data && data.breakMs, 0)),
      legacyBreakExcludedMs: Math.max(0, finite(data && data.legacyBreakExcludedMs, 0)),
      otherCompanyOn,
      otherCompanyStartedAt,
      otherCompanyMs: Math.max(0, finite(data && data.otherCompanyMs, 0)),
      otherCompanySegments: normalizeBreakSegments(data && data.otherCompanySegments, otherCompanyOn, otherCompanyStartedAt, otherCompanyStateAt),
      legacyOtherCompanyMs: hasOtherCompanySegments
        ? Math.max(0, finite(data && data.legacyOtherCompanyMs, 0))
        : Math.max(0, finite(data && data.otherCompanyMs, 0)),
      backgroundGap: null,
      lastBackfillMs: 0,
      lastBackfillAt: null,
      updatedAt: resumeAt
    };
  }

  function loadEnhancedClock() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ENHANCED_CLOCK_KEY) || "null");
      clockState = parsed ? normalizeState(parsed) : defaultEnhancedState();
    } catch (_) {
      clockState = defaultEnhancedState();
    }
    if (clockState.breakOn && !clockState.breakStartedAt) clockState.breakStartedAt = nowMs();
    if (clockState.breakOn && Array.isArray(clockState.breakSegments)) {
      const openSegment = [...clockState.breakSegments].reverse().find(segment => segment.endAt === null);
      if (openSegment) clockState.breakStartedAt = openSegment.startAt;
    }
    if (clockState.otherCompanyOn && !clockState.otherCompanyStartedAt) clockState.otherCompanyStartedAt = nowMs();
    if (clockState.otherCompanyOn && Array.isArray(clockState.otherCompanySegments)) {
      const openSegment = [...clockState.otherCompanySegments].reverse().find(segment => segment.endAt === null);
      if (openSegment) clockState.otherCompanyStartedAt = openSegment.startAt;
    }
  }

  function adoptStoredClock(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const externalAt = finite(data.updatedAt, NaN);
    const localAt = finite(clockState && clockState.updatedAt, 0);
    if (!Number.isFinite(externalAt) || externalAt <= 0 || externalAt < localAt) return false;
    clockState = normalizeState(data);
    clockState.backgroundGap = null;
    lastSavedAt = nowMs();
    return true;
  }

  function reconcileStoredClock() {
    try {
      const stored = JSON.parse(localStorage.getItem(ENHANCED_CLOCK_KEY) || "null");
      return adoptStoredClock(stored);
    } catch (_) {
      return false;
    }
  }

  function serializableState() {
    syncClockUsage();
    clockState.otherCompanyMs = otherCompanyDurationMs();
    return {
      countMode: COUNT_MODE,
      usageMode: USAGE_MODE,
      on: clockState.on,
      remainingMs: clockState.remainingMs,
      activeMs: clockState.activeMs,
      usageBaselineMs: usageBaselineMs(),
      sessionStartAt: clockState.sessionStartAt,
      sessionEndedAt: clockState.sessionEndedAt || null,
      breakOn: clockState.breakOn,
      breakStartedAt: clockState.breakStartedAt,
      breakMs: clockState.breakMs,
      breakSegments: Array.isArray(clockState.breakSegments) ? clockState.breakSegments.map(segment => ({
        startAt: segment.startAt,
        endAt: segment.endAt === null ? null : segment.endAt
      })) : [],
      legacyBreakMs: Math.max(0, finite(clockState.legacyBreakMs, 0)),
      legacyBreakExcludedMs: Math.max(0, finite(clockState.legacyBreakExcludedMs, 0)),
      otherCompanyOn: Boolean(clockState.otherCompanyOn),
      otherCompanyStartedAt: clockState.otherCompanyStartedAt || null,
      otherCompanyMs: Math.max(0, finite(clockState.otherCompanyMs, 0)),
      otherCompanySegments: Array.isArray(clockState.otherCompanySegments) ? clockState.otherCompanySegments.map(segment => ({
        startAt: segment.startAt,
        endAt: segment.endAt === null ? null : segment.endAt
      })) : [],
      legacyOtherCompanyMs: Math.max(0, finite(clockState.legacyOtherCompanyMs, 0)),
      backgroundGap: null,
      lastBackfillMs: 0,
      lastBackfillAt: null,
      updatedAt: Math.max(0, finite(clockState.updatedAt, nowMs()))
    };
  }

  function persistEnhancedClock(force = false) {
    const now = nowMs();
    const sessionStartAdjusted = reconcileSessionStartWithUsage(now);
    if (!force && !sessionStartAdjusted && now - lastSavedAt < SAVE_INTERVAL_MS) return;
    lastSavedAt = now;
    const anchorAt = Math.max(now, finite(clockState.lastTickAt, now));
    clockState.countMode = COUNT_MODE;
    syncClockUsage();
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.baseAt = anchorAt;
    clockState.updatedAt = anchorAt;
    localStorage.setItem(ENHANCED_CLOCK_KEY, JSON.stringify(serializableState()));
    localStorage.setItem(LEGACY_CLOCK_KEY, JSON.stringify({
      on: clockState.on,
      baseRemain: clockState.remainingMs / 60000,
      baseAt: now
    }));
    if (typeof setRemain === "function") setRemain(clockState.remainingMs / 60000);
    if (typeof save === "function") save();
  }

  function tickClock(at = nowMs()) {
    const requestedAt = finite(at, nowMs());
    const previous = finite(clockState.lastTickAt, requestedAt);
    const effectiveAt = Math.max(previous, requestedAt);
    const delta = effectiveAt - previous;
    clockState.lastTickAt = effectiveAt;
    const counting = clockState.on && !clockState.breakOn && !clockState.sessionEndedAt;
    let countedUntil = effectiveAt;
    if (counting && delta > 0) {
      const consumed = Math.min(delta, Math.max(0, clockState.remainingMs));
      clockState.remainingMs -= consumed;
      countedUntil = previous + consumed;
    }
    syncClockUsage();
    clockState.moving = false;
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.baseAt = effectiveAt;
    if (clockState.remainingMs <= 0 && clockState.on) {
      closeActiveOtherCompany(countedUntil);
      clockState.on = false;
      startActiveBreak(countedUntil);
      clockState.moving = false;
      persistEnhancedClock(true);
    } else {
      persistEnhancedClock(false);
    }
  }

  function beginBackgroundGap() {
    const at = nowMs();
    tickClock(at);
    clockState.backgroundGap = null;
    persistEnhancedClock(true);
  }

  function resumeBackgroundGap() {
    const at = nowMs();
    tickClock(at);
    clockState.backgroundGap = null;
    persistEnhancedClock(true);
  }

  function remainingText(ms) {
    return formatDurationMs(ms, "ceil");
  }

  function durationText(ms) {
    return formatDurationMs(ms, "floor");
  }

  function sessionMetricAt(at = nowMs()) {
    const requestedAt = finite(at, nowMs());
    const endedAt = clockState.sessionEndedAt ? finite(clockState.sessionEndedAt, NaN) : NaN;
    return Number.isFinite(endedAt) ? Math.min(requestedAt, endedAt) : requestedAt;
  }

  function sessionBreakMs(at = nowMs()) {
    at = sessionMetricAt(at);
    const sessionStart = clockState.sessionStartAt ? finite(clockState.sessionStartAt, at) : at;
    return breakDurationMs(clockState, sessionStart, at);
  }

  function segmentDurationMs(segments, at = nowMs()) {
    at = sessionMetricAt(at);
    const sessionStart = clockState.sessionStartAt ? finite(clockState.sessionStartAt, at) : at;
    return overlapDurationMs(segments, sessionStart, at);
  }

  function otherCompanyDurationMs(at = nowMs()) {
    const segments = Array.isArray(clockState.otherCompanySegments) ? clockState.otherCompanySegments : [];
    const segmentedMs = segmentDurationMs(segments, at);
    return Math.max(0, finite(clockState.legacyOtherCompanyMs, 0)) + segmentedMs;
  }

  function otherCompanyUsedMs(at = nowMs(), totalUsedMs = clockUsedMs()) {
    return clamp(otherCompanyDurationMs(at), 0, Math.max(0, totalUsedMs));
  }

  function uberUsedMs(at = nowMs(), totalUsedMs = clockUsedMs()) {
    return Math.max(0, totalUsedMs - otherCompanyUsedMs(at, totalUsedMs));
  }

  function sessionElapsedMs(at = nowMs()) {
    if (!clockState.sessionStartAt) return 0;
    at = sessionMetricAt(at);
    return Math.max(0, at - clockState.sessionStartAt - sessionBreakMs(at));
  }

  function reconcileSessionStartWithUsage(at = nowMs()) {
    if (!clockState.sessionStartAt) return false;
    const metricAt = sessionMetricAt(at);
    const usedMs = clockUsedMs();
    let changed = false;

    // Moving the start earlier can expose an older recorded break segment,
    // so repeat until the start, break total, and linked usage are stable.
    for (let attempt = 0; attempt < 205; attempt += 1) {
      const currentStartAt = finite(clockState.sessionStartAt, metricAt);
      const requiredStartAt = metricAt - usedMs - sessionBreakMs(metricAt);
      const nextStartAt = Math.max(1, requiredStartAt);
      if (nextStartAt >= currentStartAt) break;
      clockState.sessionStartAt = nextStartAt;
      changed = true;
    }
    return changed;
  }

  function operationRate(at = nowMs()) {
    const elapsed = sessionElapsedMs(at);
    return elapsed > 0 ? clamp(clockUsedMs() / elapsed * 100, 0, 100) : 0;
  }

  function currentStatus() {
    if (clockState.sessionEndedAt) return { text: "稼働終了", sub: "履歴に保存済み", mode: "ended" };
    if (clockState.on && clockState.otherCompanyOn) return { text: "他社稼働中", sub: "残り時間も計測中", mode: "otherCompany" };
    if (clockState.breakOn) return { text: "休憩中", sub: "休憩中", mode: "break" };
    if (!clockState.on) return { text: "停止中", sub: "開始する", mode: "off" };
    return { text: "カウント中", sub: "止める", mode: "counting" };
  }

  function exhaustionText(at = nowMs()) {
    if (clockState.sessionEndedAt) return "終了済み";
    if (clockState.remainingMs <= 0) return "使い切り 到達";
    const now = new Date(at);
    const end = new Date(at + clockState.remainingMs);
    const label = end.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `使い切り ${end.toDateString() !== now.toDateString() ? "翌" : ""}${label}`;
  }

  function renderEnhancedClock() {
    tickClock();
    const status = currentStatus();
    const button = $("countToggle");
    const sub = $("countSub");
    const dot = $("countDot");
    const panel = $("countPanel");
    const ended = Boolean(clockState.sessionEndedAt);
    const counting = clockState.on && !clockState.breakOn && !ended;
    $("countRemain").textContent = `残り ${remainingText(clockState.remainingMs)}`;
    $("countStatus").textContent = ended ? "稼働終了・保存済み"
      : counting ? (clockState.otherCompanyOn ? "時間ON・他社稼働中" : "時間ON・計測中")
      : clockState.breakOn ? "時間OFF・休憩中" : "時間OFF・未開始";
    $("countEndClock").textContent = exhaustionText();
    $("countEndClock").classList.toggle("run", counting);
    button.classList.toggle("off", clockState.on);
    button.firstChild.nodeValue = ended ? "稼働終了済み" : clockState.on ? "時間をOFF" : "時間をON";
    sub.textContent = ended ? "履歴に保存済み" : clockState.on ? status.sub : clockState.breakOn ? "休憩中" : "開始する";
    button.disabled = ended;
    button.setAttribute("aria-disabled", String(ended));
    ["remainMinus", "remainPlus", "remainH", "remainM"].forEach(id => {
      const control = $(id);
      if (!control) return;
      control.disabled = ended;
      control.setAttribute("aria-disabled", String(ended));
    });
    dot.classList.toggle("stop", !counting);
    panel.classList.toggle("run", counting);
    const detail = $("movementDetail");
    if (detail) detail.textContent = ended
      ? "稼働終了・履歴に保存済み"
      : clockState.on && clockState.otherCompanyOn
        ? "他社稼働中も残り時間をカウントしています"
        : clockState.on
          ? "移動・停車にかかわらず連続でカウントします"
          : clockState.breakOn
            ? "時間OFFのため休憩を記録中です"
            : "時間OFF中は残り時間を止めています";
    renderSessionPanel();
  }

  function enhancedToggleClock() {
    if (clockState.sessionEndedAt) return;
    const wasOn = Boolean(clockState.on);
    tickClock();
    const now = nowMs();
    if (wasOn) {
      closeActiveOtherCompany(now);
      clockState.on = false;
      startActiveBreak(now);
    } else {
      closeActiveBreak(now);
      clockState.on = true;
      if (!clockState.sessionStartAt) {
        clockState.sessionStartAt = now;
        clockState.usageBaselineMs = totalClockUsedMs();
      }
    }
    clockState.lastTickAt = Math.max(finite(clockState.lastTickAt, 0), now);
    clockState.backgroundGap = null;
    persistEnhancedClock(true);
    calc();
    renderEnhancedClock();
  }

  function setExactRemainingMs(milliseconds) {
    if (clockState.sessionEndedAt) {
      if (typeof setRemain === "function") setRemain(clockState.remainingMs / 60000);
      return false;
    }
    tickClock();
    clockState.remainingMs = clamp(milliseconds, 0, MAX_REMAIN_INPUT_MINUTES * 60000);
    syncClockUsage();
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.lastTickAt = Math.max(finite(clockState.lastTickAt, 0), nowMs());
    persistEnhancedClock(true);
    return true;
  }

  function setExactRemaining(minutes) {
    return setExactRemainingMs(minutes * 60000);
  }

  function toggleOtherCompany() {
    if (clockState.sessionEndedAt || !clockState.on) return;
    tickClock();
    const now = nowMs();
    if (!clockState.sessionStartAt) {
      clockState.sessionStartAt = now;
      clockState.usageBaselineMs = totalClockUsedMs();
    }
    closeActiveBreak(now);
    if (!Array.isArray(clockState.otherCompanySegments)) clockState.otherCompanySegments = [];
    if (clockState.otherCompanyOn) {
      closeActiveOtherCompany(now);
    } else {
      clockState.otherCompanyOn = true;
      clockState.otherCompanyStartedAt = now;
      clockState.otherCompanySegments.push({ startAt: now, endAt: null });
      clockState.backgroundGap = null;
    }
    clockState.lastTickAt = Math.max(finite(clockState.lastTickAt, 0), now);
    clockState.otherCompanyMs = otherCompanyDurationMs(now);
    persistEnhancedClock(true);
    renderEnhancedClock();
  }

  function history() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  function saveHistory(items) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 30)));
      return true;
    } catch (_) {
      alert("履歴を保存できませんでした。端末の空き容量を確認してください。");
      return false;
    }
  }

  function sessionSnapshot(at) {
    reconcileSessionStartWithUsage(at);
    const target = Math.max(1, finite(n("target"), 1));
    const done = Math.max(0, finite(n("done"), 0));
    const remainingMs = Math.max(0, finite(clockState.remainingMs, 0));
    const usedMs = clockUsedMs(remainingMs);
    const otherUsedMs = otherCompanyUsedMs(at, usedMs);
    const uberWorkMs = Math.max(0, usedMs - otherUsedMs);
    const actualPaceMinutes = done > 0 && usedMs > 0 ? usedMs / 60000 / done : null;
    const workTypes = [];
    if (uberWorkMs > 0) workTypes.push("uber");
    if (otherUsedMs > 0) workTypes.push("otherCompany");
    return {
      id: `${at}-${Math.random().toString(36).slice(2, 7)}`,
      date: new Date(clockState.sessionStartAt).toISOString(),
      startedAt: clockState.sessionStartAt,
      endedAt: at,
      recordedAt: at,
      target,
      done,
      completed: done >= target,
      progressRate: clamp(done / target * 100, 0, 999),
      remainingMs,
      usedMs,
      uberUsedMs: uberWorkMs,
      otherCompanyMs: otherUsedMs,
      totalActiveMs: usedMs,
      workTypes,
      endedFromState: currentStatus().mode,
      usageMode: USAGE_MODE,
      activeMs: usedMs,
      elapsedMs: sessionElapsedMs(at),
      breakMs: sessionBreakMs(at),
      rate: operationRate(at),
      actualPaceMinutes,
      hourlyRate: actualPaceMinutes ? 60 / actualPaceMinutes : null,
      endLimitTime: $("endLimit").value || ""
    };
  }

  function recordSession(showMessage = true, at = nowMs()) {
    at = finite(at, nowMs());
    tickClock(at);
    if (!clockState.sessionStartAt) {
      if (showMessage) alert("開始時刻がまだありません。時間ONで計測を開始してください。");
      return false;
    }
    const item = sessionSnapshot(at);
    const items = history();
    items.unshift(item);
    if (!saveHistory(items)) return false;
    renderHistory();
    if (showMessage) alert("今日の稼働記録を保存しました。");
    return item;
  }

  function closeActiveBreak(at) {
    if (!clockState.breakOn) return;
    if (!Array.isArray(clockState.breakSegments)) clockState.breakSegments = [];
    const startedAt = finite(clockState.breakStartedAt, at);
    const openSegment = [...clockState.breakSegments].reverse().find(segment => segment.endAt === null);
    if (openSegment) openSegment.endAt = at;
    else clockState.breakSegments.push({ startAt: startedAt, endAt: at });
    clockState.breakMs += Math.max(0, at - startedAt);
    clockState.breakStartedAt = null;
    clockState.breakOn = false;
  }

  function startActiveBreak(at) {
    if (!clockState.sessionStartAt || clockState.sessionEndedAt || clockState.breakOn) return;
    if (!Array.isArray(clockState.breakSegments)) clockState.breakSegments = [];
    const startedAt = Math.max(finite(clockState.sessionStartAt, at), finite(at, nowMs()));
    clockState.breakOn = true;
    clockState.breakStartedAt = startedAt;
    clockState.breakSegments.push({ startAt: startedAt, endAt: null });
    clockState.backgroundGap = null;
  }

  function closeActiveOtherCompany(at) {
    if (!clockState.otherCompanyOn) return;
    if (!Array.isArray(clockState.otherCompanySegments)) clockState.otherCompanySegments = [];
    const startedAt = finite(clockState.otherCompanyStartedAt, at);
    const openSegment = [...clockState.otherCompanySegments].reverse().find(segment => segment.endAt === null);
    if (openSegment) openSegment.endAt = at;
    else clockState.otherCompanySegments.push({ startAt: startedAt, endAt: at });
    clockState.otherCompanyStartedAt = null;
    clockState.otherCompanyOn = false;
    clockState.otherCompanyMs = otherCompanyDurationMs(at);
  }

  function finishSession() {
    if (finalizingSession || !clockState.sessionStartAt || clockState.sessionEndedAt) return;
    finalizingSession = true;
    const at = nowMs();
    tickClock(at);
    const saved = recordSession(false, at);
    if (!saved) {
      finalizingSession = false;
      return;
    }
    closeActiveBreak(at);
    closeActiveOtherCompany(at);
    clockState.on = false;
    clockState.moving = false;
    clockState.backgroundGap = null;
    clockState.sessionEndedAt = at;
    clockState.lastTickAt = at;
    clockState.baseAt = at;
    persistEnhancedClock(true);
    save();
    calc();
    renderEnhancedClock();
    finalizingSession = false;
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return "未開始";
    return new Date(timestamp).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function formatTime(timestamp) {
    if (!timestamp) return "--:--";
    return new Date(timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function historyIdentity(item, index) {
    if (item && item.id !== undefined && item.id !== null && String(item.id)) return `id:${String(item.id)}`;
    return `legacy:${finite(item && item.startedAt)}:${finite(item && item.recordedAt)}:${finite(item && item.done)}:${finite(item && item.target)}:${finite(item && item.activeMs)}:${index}`;
  }

  function historyUsedMs(item) {
    const storedUsed = finite(item && item.usedMs, NaN);
    if (Number.isFinite(storedUsed) && storedUsed >= 0) return clamp(storedUsed, 0, WORK_LIMIT_MS);
    const remainingMs = finite(item && item.remainingMs, NaN);
    if (Number.isFinite(remainingMs) && remainingMs >= 0) return usedMsFromRemaining(remainingMs, WORK_LIMIT_MS);
    return clamp(finite(item && item.activeMs, 0), 0, WORK_LIMIT_MS);
  }

  function historyOtherCompanyMs(item) {
    return clamp(finite(item && item.otherCompanyMs, 0), 0, historyUsedMs(item));
  }

  function historyUberUsedMs(item) {
    const total = historyUsedMs(item);
    const stored = finite(item && item.uberUsedMs, NaN);
    if (Number.isFinite(stored) && stored >= 0) return clamp(stored, 0, total);
    return Math.max(0, total - historyOtherCompanyMs(item));
  }

  function historyWorkTypeLabel(item) {
    const uberMs = historyUberUsedMs(item);
    const otherMs = historyOtherCompanyMs(item);
    if (uberMs > 0 && otherMs > 0) return "Uber＋他社";
    if (otherMs > 0) return "他社のみ";
    if (uberMs > 0) return "Uber";
    return "計測なし";
  }

  function historyEndStateLabel(item) {
    const labels = {
      counting: "時間ON",
      otherCompany: "他社稼働中",
      off: "時間OFF",
      break: "休憩中"
    };
    return labels[item && item.endedFromState] || "";
  }

  function historyRate(item) {
    const elapsedMs = finite(item && item.elapsedMs, NaN);
    if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
      return clamp(historyUsedMs(item) / elapsedMs * 100, 0, 100);
    }
    return clamp(finite(item && item.rate, 0), 0, 100);
  }

  function historyPace(item) {
    const stored = finite(item && item.actualPaceMinutes, NaN);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const done = Math.max(0, finite(item && item.done, 0));
    if (!done) return NaN;
    const usedMs = historyUsedMs(item);
    return usedMs > 0 ? usedMs / 60000 / done : NaN;
  }

  function historyTimestamp(value, fallback = NaN) {
    return timestamp(value, fallback);
  }

  function historyStartAt(item) {
    const startedAt = historyTimestamp(item && item.startedAt, NaN);
    return Number.isFinite(startedAt) ? startedAt : historyTimestamp(item && item.date, NaN);
  }

  function historyEndAt(item) {
    const endedAt = historyTimestamp(item && item.endedAt, NaN);
    return Number.isFinite(endedAt) ? endedAt : historyTimestamp(item && item.recordedAt, NaN);
  }

  function reconcileHistoryItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const startedAt = historyStartAt(item);
    const endedAt = historyEndAt(item);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) return item;
    const breakMs = Math.max(0, finite(item.breakMs, 0));
    const usedMs = historyUsedMs(item);
    const elapsedMs = Math.max(0, endedAt - startedAt - breakMs);
    if (usedMs <= elapsedMs) return item;

    const adjustedStartAt = Math.max(1, endedAt - breakMs - usedMs);
    const adjustedElapsedMs = Math.max(0, endedAt - adjustedStartAt - breakMs);
    const adjusted = {
      ...item,
      startedAt: adjustedStartAt,
      elapsedMs: adjustedElapsedMs,
      rate: adjustedElapsedMs > 0 ? clamp(usedMs / adjustedElapsedMs * 100, 0, 100) : 0
    };
    if (Object.prototype.hasOwnProperty.call(item, "date")) {
      adjusted.date = new Date(adjustedStartAt).toISOString();
    }
    return adjusted;
  }

  function historyEndEditError(item, endedAt, now = nowMs()) {
    if (!Number.isFinite(endedAt)) return "終了日時を入力してください。";
    const startedAt = historyStartAt(item);
    if (!Number.isFinite(startedAt)) return "開始日時がない履歴は修正できません。";
    if (endedAt > now) return "終了日時を現在より後には設定できません。";
    if (endedAt <= startedAt) return "終了日時は開始日時より後にしてください。";
    const breakMs = Math.max(0, finite(item && item.breakMs, 0));
    if (endedAt - startedAt < breakMs) return "終了日時が早すぎます。開始から休憩時間分を確保してください。";
    if (endedAt - startedAt - breakMs < historyUsedMs(item)) return "終了日時が早すぎます。記録済みの稼働時間を収めてください。";
    return "";
  }

  function recalculateHistoryEnd(item, endedAt) {
    const startedAt = historyStartAt(item);
    const breakMs = Math.max(0, finite(item && item.breakMs, 0));
    const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, endedAt - startedAt - breakMs) : 0;
    const usedMs = historyUsedMs(item);
    return {
      ...item,
      endedAt,
      elapsedMs,
      rate: elapsedMs > 0 ? clamp(usedMs / elapsedMs * 100, 0, 100) : 0
    };
  }

  function toLocalMinuteInputValue(timestamp) {
    return coreToLocalMinuteInputValue(timestamp);
  }

  function closeHistoryEndEditor(restoreFocus = true) {
    const layer = $("historyEndEditorLayer");
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    $("appRoot").inert = false;
    document.body.classList.remove("historyEndEditorOpen");
    const state = historyEndEditorState;
    historyEndEditorState = null;
    if (restoreFocus && state && state.source && state.source.isConnected && !state.source.disabled) {
      state.source.focus({ preventScroll: true });
    }
  }

  function openHistoryEndEditor(index, source) {
    const items = history();
    const item = items[index];
    const layer = $("historyEndEditorLayer");
    const input = $("historyEndInput");
    const error = $("historyEndError");
    if (!item || !layer || !layer.hidden || !input || !error) return;
    const startedAt = historyStartAt(item);
    const endedAt = historyEndAt(item);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
      alert("開始日時または終了日時を読み取れないため、この履歴は修正できません。");
      return;
    }
    const breakMs = Math.max(0, finite(item.breakMs, 0));
    input.value = toLocalMinuteInputValue(endedAt);
    const earliestEndAt = startedAt + breakMs + historyUsedMs(item);
    input.min = toLocalMinuteInputValue(Math.ceil(Math.max(startedAt + 1, earliestEndAt) / 60000) * 60000);
    input.max = toLocalMinuteInputValue(nowMs());
    error.textContent = "";
    historyEndEditorState = {
      index,
      identity: historyIdentity(item, index),
      initialAt: endedAt,
      source
    };
    layer.hidden = false;
    $("appRoot").inert = true;
    document.body.classList.add("historyEndEditorOpen");
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  }

  function applyHistoryEndEdit() {
    const state = historyEndEditorState;
    const input = $("historyEndInput");
    const error = $("historyEndError");
    if (!state || !input || !error) return;
    const items = history();
    let targetIndex = state.index;
    if (!items[targetIndex] || historyIdentity(items[targetIndex], targetIndex) !== state.identity) {
      targetIndex = items.findIndex((candidate, candidateIndex) => historyIdentity(candidate, candidateIndex) === state.identity);
    }
    if (targetIndex < 0) {
      error.textContent = "対象の履歴が見つかりません。履歴を開き直してください。";
      return;
    }
    const item = items[targetIndex];
    if (input.value === toLocalMinuteInputValue(state.initialAt)) {
      closeHistoryEndEditor();
      return;
    }
    const endedAt = historyTimestamp(input.value, NaN);
    const validationError = historyEndEditError(item, endedAt);
    if (validationError) {
      error.textContent = validationError;
      return;
    }
    items[targetIndex] = recalculateHistoryEnd(item, endedAt);
    if (!saveHistory(items)) return;
    closeHistoryEndEditor(false);
    renderHistory();
    setTimeout(() => {
      const button = $("workHistoryList").querySelector(`.workHistoryEdit[data-history-index="${targetIndex}"]`);
      (button || $("workHistoryTitle")).focus({ preventScroll: true });
    }, 0);
  }

  function closeWorkConfirm(restoreFocus = true) {
    const layer = $("workConfirmLayer");
    if (!layer || layer.hidden) return;
    layer.hidden = true;
    $("appRoot").inert = false;
    document.body.classList.remove("workConfirmOpen");
    pendingConfirmAction = null;
    const target = confirmReturnFocus;
    confirmReturnFocus = null;
    if (restoreFocus && target && target.isConnected && !target.disabled) target.focus({ preventScroll: true });
  }

  function openWorkConfirm({ title, description, rows, actionLabel, source, onConfirm, mode = "end" }) {
    const layer = $("workConfirmLayer");
    if (!layer || !layer.hidden || typeof onConfirm !== "function") return;
    $("workConfirmTitle").textContent = title;
    $("workConfirmDescription").textContent = description;
    const summary = $("workConfirmSummary");
    summary.replaceChildren();
    rows.forEach(row => {
      const item = document.createElement("div");
      const label = document.createElement("span");
      const value = document.createElement("strong");
      label.textContent = row.label;
      value.textContent = row.value;
      item.append(label, value);
      summary.appendChild(item);
    });
    const submit = $("workConfirmSubmit");
    submit.textContent = actionLabel;
    submit.classList.toggle("delete", mode === "delete");
    submit.disabled = false;
    confirmReturnFocus = source || document.activeElement;
    pendingConfirmAction = onConfirm;
    layer.hidden = false;
    $("appRoot").inert = true;
    document.body.classList.add("workConfirmOpen");
    setTimeout(() => $("workConfirmCancel").focus({ preventScroll: true }), 0);
  }

  function requestSessionFinish(source) {
    if (!clockState.sessionStartAt || clockState.sessionEndedAt) return;
    const at = nowMs();
    tickClock(at);
    const totalUsed = clockUsedMs();
    const otherUsed = otherCompanyUsedMs(at, totalUsed);
    openWorkConfirm({
      title: "稼働を終了しますか？",
      description: "現在の件数と稼働指標を履歴に保存し、時間計測を停止します。目標未達でも記録されます。",
      rows: [
        { label: "完了件数", value: `${Math.max(0, n("done"))} / ${Math.max(1, n("target"))}件` },
        { label: "Uber稼働", value: durationText(Math.max(0, totalUsed - otherUsed)) },
        { label: "他社稼働", value: durationText(otherUsed) },
        { label: "休憩", value: durationText(sessionBreakMs(at)) },
        { label: "経過（休憩除く）", value: durationText(sessionElapsedMs(at)) },
        { label: "実稼働率", value: `${operationRate(at).toFixed(1)}%` }
      ],
      actionLabel: "終了して記録",
      source,
      onConfirm: finishSession
    });
  }

  function requestHistoryDelete(index, source) {
    const items = history();
    const item = items[index];
    if (!item) return;
    const identity = historyIdentity(item, index);
    const done = Math.max(0, finite(item.done, 0));
    const target = Math.max(0, finite(item.target, 0));
    openWorkConfirm({
      title: "この履歴を削除しますか？",
      description: "選択した稼働記録だけを削除します。この操作は元に戻せません。",
      rows: [
        { label: "開始日時", value: formatDateTime(item.startedAt || item.date) },
        { label: "完了件数", value: target ? `${done} / ${target}件` : `${done}件` },
        { label: "Uber稼働", value: durationText(historyUberUsedMs(item)) },
        { label: "他社稼働", value: durationText(historyOtherCompanyMs(item)) }
      ],
      actionLabel: "1件削除",
      source,
      mode: "delete",
      onConfirm: () => {
        const current = history();
        let targetIndex = index;
        if (!current[targetIndex] || historyIdentity(current[targetIndex], targetIndex) !== identity) {
          targetIndex = current.findIndex((candidate, candidateIndex) => historyIdentity(candidate, candidateIndex) === identity);
        }
        if (targetIndex < 0) return;
        current.splice(targetIndex, 1);
        if (saveHistory(current)) renderHistory();
      }
    });
  }

  function renderHistory() {
    const box = $("workHistoryList");
    if (!box) return;
    const storedItems = history();
    let adjusted = false;
    const reconciledItems = storedItems.map(item => {
      const reconciled = reconcileHistoryItem(item);
      if (reconciled !== item) adjusted = true;
      return reconciled;
    });
    if (adjusted) saveHistory(reconciledItems);
    const items = reconciledItems.slice(0, 5);
    box.innerHTML = items.length ? items.map((item, index) => {
      const done = Math.max(0, finite(item.done, 0));
      const target = Math.max(0, finite(item.target, 0));
      const progress = target ? `${Math.round(clamp(done / target * 100, 0, 999))}%達成` : "目標記録なし";
      const pace = historyPace(item);
      const uberMs = historyUberUsedMs(item);
      const otherMs = historyOtherCompanyMs(item);
      const rate = historyRate(item);
      const endedAt = historyEndAt(item);
      const endedState = historyEndStateLabel(item);
      return `
        <div class="workHistoryItem" role="listitem">
          <div class="workHistoryMain"><strong>${formatDateTime(item.startedAt || item.date)}〜${formatTime(endedAt)}</strong><small>${target ? `${done} / ${target}件` : `${done}件`} · ${progress} · ${historyWorkTypeLabel(item)}${endedState ? ` · 終了時${endedState}` : ""}</small><div class="workHistoryMeta">Uber ${durationText(uberMs)} · 他社 ${durationText(otherMs)}<br>経過 ${durationText(finite(item.elapsedMs, 0))} · 休憩 ${durationText(finite(item.breakMs, 0))}<br>実稼働率 ${rate.toFixed(1)}% · 平均 ${Number.isFinite(pace) ? `${pace.toFixed(2)}分/件` : "計測なし"}</div></div>
          <div class="workHistoryActions">
            <button class="workHistoryEdit" type="button" data-history-index="${index}" aria-label="${formatDateTime(item.startedAt || item.date)}開始の履歴の終了日時を修正" aria-haspopup="dialog">修正</button>
            <button class="workHistoryDelete" type="button" data-history-index="${index}" aria-label="${formatDateTime(item.startedAt || item.date)}開始の履歴を削除">削除</button>
          </div>
        </div>`;
    }).join("") : '<div class="workHistoryEmpty">保存した履歴はまだありません</div>';
  }

  function renderSessionPanel() {
    const panel = $("workSessionPanel");
    if (!panel) return;
    const at = nowMs();
    reconcileSessionStartWithUsage(at);
    const ended = Boolean(clockState.sessionEndedAt);
    const totalUsed = clockUsedMs();
    const otherUsed = otherCompanyUsedMs(at, totalUsed);
    const uberUsed = Math.max(0, totalUsed - otherUsed);
    $("workStartTime").textContent = clockState.sessionStartAt ? formatDateTime(clockState.sessionStartAt) : "未開始";
    $("workActiveTime").textContent = durationText(totalUsed);
    $("workUberTime").textContent = durationText(uberUsed);
    $("workOtherCompanyTime").textContent = durationText(otherUsed);
    $("workElapsedTime").textContent = durationText(sessionElapsedMs(at));
    $("workRate").textContent = `${operationRate(at).toFixed(1)}%`;
    $("workBreakTime").textContent = durationText(sessionBreakMs(at));
    const otherCompanyDisabled = !clockState.on || !clockState.sessionStartAt || ended;
    $("otherCompanyToggle").textContent = clockState.otherCompanyOn ? "他社稼働 ON" : "他社稼働 OFF";
    $("otherCompanyToggle").setAttribute("aria-pressed", String(clockState.otherCompanyOn));
    $("otherCompanyToggle").classList.toggle("active", clockState.otherCompanyOn);
    $("otherCompanyToggle").disabled = otherCompanyDisabled;
    $("otherCompanyToggle").setAttribute("aria-disabled", String(otherCompanyDisabled));
    $("otherCompanyToggle").setAttribute("aria-label", clockState.otherCompanyOn ? "他社稼働の記録を終了" : "他社稼働の記録を開始");
    $("finishWork").textContent = ended ? "稼働終了済み" : "稼働終了";
    $("finishWork").disabled = !clockState.sessionStartAt || ended;
    $("finishWork").setAttribute("aria-disabled", String(!clockState.sessionStartAt || ended));
    $("workSessionNotice").hidden = !ended;
    if (ended) $("workSessionNotice").textContent = `${formatDateTime(clockState.sessionEndedAt)}に終了・履歴へ保存済み。次の稼働前に進捗をリセットしてください。`;
    const editButton = $("editStartTime");
    if (editButton) {
      editButton.disabled = !clockState.sessionStartAt || ended;
      editButton.setAttribute("aria-disabled", String(!clockState.sessionStartAt || ended));
    }
    const breakEditButton = $("editBreakTime");
    if (breakEditButton) {
      breakEditButton.disabled = !clockState.sessionStartAt || ended;
      breakEditButton.setAttribute("aria-disabled", String(!clockState.sessionStartAt || ended));
    }
  }

  function injectUi() {
    const style = document.createElement("style");
    style.textContent = `
      .movementDetail{margin-top:8px;color:#8fa6ba;font-size:11px;line-height:1.45;text-align:center}
      .workSessionPanel{margin:12px 0;padding:16px;border:1px solid #28506c;border-radius:24px;background:linear-gradient(155deg,rgba(9,29,43,.96),rgba(4,18,30,.94));box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 10px 26px rgba(0,0,0,.17)}
      .workSessionHead{display:grid;grid-template-columns:minmax(0,1fr);gap:9px}.workSessionTitle{margin:0;font-size:18px}.workSessionStart{color:#8fa6ba;font-size:11px;text-align:left}.workSessionStart strong{display:block;margin-top:2px;color:#e7f2fb;font-size:13px}
      .workSessionGrid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:13px}.workSessionStat{grid-column:span 2;min-width:0;padding:11px 8px;border:1px solid rgba(59,91,116,.5);border-radius:16px;background:rgba(3,18,27,.58)}.workSessionStat.mainStat{grid-column:span 3}.workSessionStat span{display:block;color:#8fa6ba;font-size:9.5px;font-weight:750}.workSessionStat strong{display:block;margin-top:4px;font-size:17px;white-space:nowrap}.workSessionStat.primary{border-color:rgba(52,230,123,.36);background:rgba(18,76,52,.18)}.workSessionStat.primary strong{color:#68ef9b}.workSessionStat.otherStat{border-color:rgba(32,213,218,.28);background:rgba(16,74,84,.13)}.workSessionStat.otherStat strong{color:#7ce9ec}.workSessionStatLabel{display:flex!important;min-width:0;align-items:center;justify-content:space-between;gap:4px}.editBreakTime{flex:0 0 auto;min-height:23px;padding:3px 7px;border:1px solid #356786;border-radius:8px;background:rgba(12,54,79,.56);color:#89c8ee;font-size:8.5px;line-height:1;box-shadow:none}
      .workSessionActions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:11px}.workSessionActions button{min-height:48px;padding:10px;border:1px solid #365b75;border-radius:15px;background:linear-gradient(180deg,#143047,#0a2134);font-size:13px}.workSessionActions .otherCompanyToggle.active{border-color:#20d5da;background:rgba(16,94,101,.34);color:#7cf2f4;box-shadow:0 0 18px rgba(32,213,218,.10)}.workSessionActions .finishWork{border-color:rgba(255,102,114,.68);background:linear-gradient(180deg,#b73545,#7f1f30);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 7px 18px rgba(103,19,33,.22)}
      .workSessionActions button:disabled,.toggleBtn:disabled,.editStartTime:disabled,.editBreakTime:disabled{opacity:.46;filter:none;cursor:default;transform:none;box-shadow:none}.workSessionNotice{margin-top:9px;padding:9px 11px;border:1px solid rgba(52,230,123,.32);border-radius:13px;background:rgba(24,92,59,.16);color:#86edaa;font-size:10px;line-height:1.45}.workSessionNotice[hidden]{display:none}
      .workHistory{margin-top:13px;padding-top:12px;border-top:1px solid rgba(69,99,122,.38)}.workHistoryTitle{margin:0 0 8px;color:#b9c9d7;font-size:11px}.workHistoryItem{display:grid;grid-template-columns:minmax(0,1fr) 44px;align-items:center;gap:9px;margin-top:7px;padding:10px;border:1px solid rgba(59,91,116,.34);border-radius:15px;background:rgba(3,18,27,.44)}.workHistoryItem:first-child{margin-top:0}.workHistoryMain{min-width:0}.workHistoryMain strong,.workHistoryMain small{display:block}.workHistoryMain strong{overflow:hidden;color:#e7f0f7;font-size:11.5px;text-overflow:ellipsis;white-space:nowrap}.workHistoryMain small{margin-top:2px;color:#91a5b7;font-size:9.5px}.workHistoryMeta{margin-top:5px;color:#718ba1;font-size:8.8px;line-height:1.45}.workHistoryActions{display:grid;gap:6px}.workHistoryEdit,.workHistoryDelete{display:grid;width:44px;min-height:38px;padding:0;place-items:center;border-radius:12px;font-size:10px}.workHistoryEdit{border:1px solid rgba(61,149,255,.52);background:rgba(24,92,164,.20);color:#83beff}.workHistoryDelete{border:1px solid rgba(255,102,114,.42);background:rgba(105,26,39,.18);color:#ff9ba3}.workHistoryEdit:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}.workHistoryDelete:focus-visible{outline:2px solid #ff7d89;outline-offset:2px}.workHistoryEmpty{padding:10px 0;color:#71869a;font-size:10px}
      .workConfirmLayer{position:fixed;z-index:120;inset:0;display:grid;place-items:center;padding:max(12px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom))}.workConfirmLayer[hidden]{display:none}.workConfirmBackdrop{position:absolute;inset:0;background:rgba(0,5,12,.80);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}.workConfirmDialog{position:relative;width:min(100%,430px);max-height:min(88dvh,560px);padding:18px;overflow:auto;border:1px solid #3b5368;border-radius:24px;background:radial-gradient(circle at 50% -10%,rgba(255,102,114,.10),transparent 38%),linear-gradient(160deg,#0b2536,#04131f);box-shadow:0 26px 72px rgba(0,0,0,.62),inset 0 1px 0 rgba(255,255,255,.06);outline:none;-webkit-overflow-scrolling:touch}.workConfirmDialog h3{margin:0;color:#f7f9fc;font-size:20px;letter-spacing:-.025em}.workConfirmDialog p{margin:6px 0 14px;color:#93a8ba;font-size:11px;line-height:1.55}.workConfirmSummary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.workConfirmSummary>div{min-width:0;padding:10px;border:1px solid rgba(72,105,130,.42);border-radius:14px;background:rgba(3,18,28,.64)}.workConfirmSummary span,.workConfirmSummary strong{display:block}.workConfirmSummary span{color:#849aac;font-size:9px}.workConfirmSummary strong{overflow:hidden;margin-top:3px;color:#eef4f8;font-size:14px;text-overflow:ellipsis;white-space:nowrap}.workConfirmActions{display:grid;grid-template-columns:1fr 1.2fr;gap:9px;margin-top:15px}.workConfirmActions button{min-height:50px;padding:11px;border:1px solid #365b75;border-radius:15px;background:linear-gradient(180deg,#143047,#0a2134);font-size:13px}.workConfirmActions .workConfirmSubmit{border-color:rgba(255,102,114,.72);background:linear-gradient(180deg,#c13b4c,#851f31)}.workConfirmActions .workConfirmSubmit.delete{background:linear-gradient(180deg,#a52c3b,#701925)}.workConfirmActions button:disabled{opacity:.5}.workConfirmOpen{overflow:hidden}
      .historyEndEditorDialog{border-color:#285e85;background:radial-gradient(circle at 50% -10%,rgba(61,149,255,.12),transparent 40%),linear-gradient(160deg,#0a2436,#04131f)}.historyEndEditorDialog input{display:block;width:100%;max-width:100%;min-width:0;min-height:56px;padding:11px 9px;border:1px solid #2a5878;border-radius:15px;background:#061522;color:#f4f8fb;font-size:clamp(15px,4.8vw,17px);color-scheme:dark}.historyEndError{min-height:20px;margin:7px 1px 0;color:#ff8a94;font-size:10px;line-height:1.4}.historyEndEditorActions{margin-top:10px}.historyEndEditorActions .applyHistoryEnd{border-color:#2f8bff;background:linear-gradient(180deg,#1769c4,#0a4b9e)}.historyEndEditorOpen{overflow:hidden}
      @media(max-width:390px){.workSessionPanel{padding:13px}.workSessionGrid{gap:7px}.workSessionStat{padding:10px 6px}.workSessionStat strong{font-size:clamp(12px,3.7vw,15px)}.workSessionActions{grid-template-columns:1fr}.workHistoryItem{grid-template-columns:minmax(0,1fr) 44px}.workConfirmDialog{padding:15px}.workConfirmSummary strong{font-size:13px}}
      @media(max-width:350px){.workConfirmSummary{grid-template-columns:1fr}.workConfirmActions{grid-template-columns:1fr 1fr}.workHistoryMain strong{white-space:normal}}
    `;
    document.head.appendChild(style);

    const detail = document.createElement("div");
    detail.id = "movementDetail";
    detail.className = "movementDetail";
    $("countPanel").appendChild(detail);

    const panel = document.createElement("section");
    panel.id = "workSessionPanel";
    panel.className = "workSessionPanel";
    panel.tabIndex = -1;
    panel.innerHTML = `
      <div class="workSessionHead"><div><h2 class="workSessionTitle">稼働計測</h2><div class="movementDetail">時間ONをUber／他社、時間OFFを休憩として記録します</div></div><div class="workSessionStart">開始時刻<strong id="workStartTime">未開始</strong></div></div>
      <div class="workSessionActions"><button id="otherCompanyToggle" class="otherCompanyToggle" type="button" aria-pressed="false">他社稼働 OFF</button><button id="finishWork" class="finishWork" type="button">稼働終了</button></div>
      <div id="workSessionNotice" class="workSessionNotice" role="status" aria-live="polite" hidden></div>
      <details class="sessionDetails"><summary>稼働の内訳・履歴</summary>
      <div class="workSessionGrid">
        <div class="workSessionStat mainStat primary"><span>Uber稼働</span><strong id="workUberTime">0時間00分</strong></div>
        <div class="workSessionStat mainStat otherStat"><span>他社稼働</span><strong id="workOtherCompanyTime">0時間00分</strong></div>
        <div class="workSessionStat breakStat"><span class="workSessionStatLabel">休憩<button id="editBreakTime" class="editBreakTime" type="button" aria-label="休憩時間を修正" aria-haspopup="dialog" disabled>修正</button></span><strong id="workBreakTime">0時間00分</strong></div>
        <div class="workSessionStat"><span>経過（休憩除く）</span><strong id="workElapsedTime">0時間00分</strong></div>
        <div class="workSessionStat"><span>実稼働率</span><strong id="workRate">0.0%</strong></div>
      </div>
      <strong hidden id="workActiveTime">0時間00分</strong>
      <div class="workHistory"><h3 id="workHistoryTitle" class="workHistoryTitle" tabindex="-1">最近の履歴</h3><div id="workHistoryList" role="list"></div></div></details>`;
    $("todaySummary").before(panel);
    const otherDock = $("otherCompanyDock");
    if (otherDock) otherDock.appendChild($("otherCompanyToggle"));
    $("otherCompanyToggle").onclick = toggleOtherCompany;
    $("finishWork").onclick = event => requestSessionFinish(event.currentTarget);
    $("workHistoryList").onclick = event => {
      const editButton = event.target.closest(".workHistoryEdit");
      if (editButton) {
        openHistoryEndEditor(Number(editButton.dataset.historyIndex), editButton);
        return;
      }
      const deleteButton = event.target.closest(".workHistoryDelete");
      if (deleteButton) requestHistoryDelete(Number(deleteButton.dataset.historyIndex), deleteButton);
    };

    const confirmLayer = document.createElement("div");
    confirmLayer.id = "workConfirmLayer";
    confirmLayer.className = "workConfirmLayer";
    confirmLayer.hidden = true;
    confirmLayer.innerHTML = `
      <div id="workConfirmBackdrop" class="workConfirmBackdrop"></div>
      <section id="workConfirmDialog" class="workConfirmDialog" role="dialog" aria-modal="true" aria-labelledby="workConfirmTitle" aria-describedby="workConfirmDescription" tabindex="-1">
        <h3 id="workConfirmTitle">確認</h3>
        <p id="workConfirmDescription"></p>
        <div id="workConfirmSummary" class="workConfirmSummary"></div>
        <div class="workConfirmActions"><button id="workConfirmCancel" type="button">キャンセル</button><button id="workConfirmSubmit" class="workConfirmSubmit" type="button">実行する</button></div>
      </section>`;
    document.body.appendChild(confirmLayer);
    $("workConfirmCancel").onclick = () => closeWorkConfirm();
    $("workConfirmBackdrop").onclick = () => closeWorkConfirm();
    $("workConfirmSubmit").onclick = () => {
      const action = pendingConfirmAction;
      if (!action) return;
      const returnTarget = confirmReturnFocus;
      $("workConfirmSubmit").disabled = true;
      closeWorkConfirm(false);
      action();
      setTimeout(() => {
        const target = returnTarget && returnTarget.isConnected && !returnTarget.disabled
          ? returnTarget
          : (clockState.sessionEndedAt ? $("workSessionPanel") : $("workHistoryTitle"));
        if (target) target.focus({ preventScroll: true });
      }, 0);
    };
    confirmLayer.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWorkConfirm();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...$("workConfirmDialog").querySelectorAll("button:not([disabled]),[tabindex]:not([tabindex='-1'])")].filter(element => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    const historyEndLayer = document.createElement("div");
    historyEndLayer.id = "historyEndEditorLayer";
    historyEndLayer.className = "workConfirmLayer historyEndEditorLayer";
    historyEndLayer.hidden = true;
    historyEndLayer.innerHTML = `
      <div id="historyEndEditorBackdrop" class="workConfirmBackdrop"></div>
      <section id="historyEndEditorDialog" class="workConfirmDialog historyEndEditorDialog" role="dialog" aria-modal="true" aria-labelledby="historyEndEditorTitle" aria-describedby="historyEndEditorDescription" tabindex="-1">
        <h3 id="historyEndEditorTitle">履歴の終了日時を修正</h3>
        <p id="historyEndEditorDescription">実際に稼働を終えた日時へ合わせます。経過時間と実稼働率も自動で再計算します。</p>
        <input id="historyEndInput" type="datetime-local" step="60" aria-label="履歴の終了日時">
        <div id="historyEndError" class="historyEndError" aria-live="polite"></div>
        <div class="workConfirmActions historyEndEditorActions"><button id="cancelHistoryEnd" type="button">キャンセル</button><button id="applyHistoryEnd" class="applyHistoryEnd" type="button">変更する</button></div>
      </section>`;
    document.body.appendChild(historyEndLayer);
    $("cancelHistoryEnd").onclick = () => closeHistoryEndEditor();
    $("historyEndEditorBackdrop").onclick = () => closeHistoryEndEditor();
    $("applyHistoryEnd").onclick = applyHistoryEndEdit;
    historyEndLayer.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHistoryEndEditor();
        return;
      }
      if (event.key === "Enter" && event.target === $("historyEndInput")) {
        event.preventDefault();
        applyHistoryEndEdit();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...$("historyEndEditorDialog").querySelectorAll("button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])")].filter(element => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    const desc = $("countPanel").querySelector(".desc");
    const hint = $("countPanel").querySelector(".hint");
    if (desc) desc.textContent = "時間ON中は移動・停車やUber／他社にかかわらず連続で減少します。内部では秒単位で計算し、画面には分単位で表示します。";
    if (hint) hint.textContent = "時間OFFで休憩を自動記録します。他社稼働は時間ON中だけ切り替えられます。−／＋で1分ずつ補正できます。";
    $("helpText").textContent = "時間ON中は残り稼働時間を連続で減らし、時間OFFへ切り替えると休憩を自動開始します。時間ONへ戻すと休憩は自動終了します。稼働開始前・稼働終了後のOFF時間は休憩に含めません。他社稼働は時間ON中だけON／OFFでき、他社稼働中も残り時間は減ります。残り時間の補正で記録済み稼働が経過を上回る場合は、開始時刻を必要分だけ前へ自動調整します。履歴ではUber稼働と分けて記録します。案件の有無や移動状態は自動判定しません。";
  }

  loadEnhancedClock();

  remain = function() {
    tickClock();
    return clockState.remainingMs / 60000;
  };
  syncClock = function() {
    setExactRemaining(manualRemain());
  };
  saveClock = function() { persistEnhancedClock(true); };
  loadClock = function() { loadEnhancedClock(); };
  stopClock = function(remaining) {
    setExactRemaining(remaining);
    const at = nowMs();
    closeActiveOtherCompany(at);
    clockState.on = false;
    startActiveBreak(at);
    clockState.lastTickAt = Math.max(finite(clockState.lastTickAt, 0), at);
    persistEnhancedClock(true);
    save();
  };
  toggleClock = enhancedToggleClock;
  renderClock = function() { renderEnhancedClock(); };
  countEndLabel = function() { return exhaustionText(); };
  window.uberProgressSessionMetrics = function() {
    const at = nowMs();
    return {
      started: Boolean(clockState.sessionStartAt),
      elapsedText: durationText(sessionElapsedMs(at)),
      rate: operationRate(at)
    };
  };

  injectUi();
  $("countToggle").onclick = enhancedToggleClock;

  adjustRemain = function(delta) {
    if (clockState.sessionEndedAt) {
      setRemain(clockState.remainingMs / 60000);
      renderEnhancedClock();
      return;
    }
    tickClock();
    clockState.remainingMs = clamp(clockState.remainingMs + finite(delta, 0) * 60000, 0, MAX_REMAIN_INPUT_MINUTES * 60000);
    syncClockUsage();
    clockState.baseRemain = clockState.remainingMs / 60000;
    persistEnhancedClock(true);
    setRemain(clockState.remainingMs / 60000);
    save();
    calc();
    renderEnhancedClock();
  };

  $("reset").onclick = function() {
    if (!confirm("完了件数・残り時間・終了上限・今日の稼働計測をリセットしますか？")) return;
    const hadSession = Boolean(!clockState.sessionEndedAt && clockState.sessionStartAt && (clockUsedMs() > 0 || n("done") > 0));
    if (hadSession && confirm("リセット前に今日の稼働記録を保存しますか？")) recordSession(false);
    $("done").value = "0";
    $("remainH").value = "12";
    $("remainM").value = "0";
    $("endLimit").value = "";
    const now = nowMs();
    clockState = {
      countMode: COUNT_MODE,
      usageMode: USAGE_MODE,
      on: false,
      remainingMs: WORK_LIMIT_MS,
      baseRemain: CONFIG.workLimitMinutes,
      baseAt: now,
      lastTickAt: now,
      moving: false,
      activeMs: 0,
      usageBaselineMs: 0,
      sessionStartAt: null,
      sessionEndedAt: null,
      breakOn: false,
      breakStartedAt: null,
      breakMs: 0,
      breakSegments: [],
      legacyBreakMs: 0,
      legacyBreakExcludedMs: 0,
      otherCompanyOn: false,
      otherCompanyStartedAt: null,
      otherCompanyMs: 0,
      otherCompanySegments: [],
      legacyOtherCompanyMs: 0,
      backgroundGap: null,
      lastBackfillMs: 0,
      lastBackfillAt: null,
      updatedAt: now
    };
    persistEnhancedClock(true);
    save();
    calc();
    renderEnhancedClock();
  };

  clockState.backgroundGap = null;
  renderHistory();
  calc();
  renderEnhancedClock();

  setInterval(() => {
    tickClock();
    calc();
    renderEnhancedClock();
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) beginBackgroundGap();
    else {
      reconcileStoredClock();
      resumeBackgroundGap();
      calc();
    }
    renderEnhancedClock();
  });
  window.addEventListener("storage", event => {
    if (event.key !== ENHANCED_CLOCK_KEY || !event.newValue) return;
    try {
      if (localStorage.getItem(ENHANCED_CLOCK_KEY) !== event.newValue) return;
      const external = JSON.parse(event.newValue);
      if (!adoptStoredClock(external)) return;
      calc();
      renderEnhancedClock();
    } catch (_) {}
  });
  window.addEventListener("pageshow", () => {
    reconcileStoredClock();
    resumeBackgroundGap();
    calc();
    renderEnhancedClock();
  });
  window.addEventListener("pagehide", () => {
    beginBackgroundGap();
  });
})();
