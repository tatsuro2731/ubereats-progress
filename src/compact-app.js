const {
  CONFIG,
  STORAGE_KEYS,
  calculateProgress,
  overlapDurationMs,
  progressTone,
  sessionUsedMsFromRemaining
} = UberProgressCore;
const LIMIT_MINUTES = CONFIG.workLimitMinutes;
const ORANGE_DELAY_LIMIT_MINUTES = CONFIG.orangeDelayLimitMinutes;
const MAX_REMAIN_INPUT_MINUTES = CONFIG.maxRemainingInputMinutes;
const STORAGE_KEY = STORAGE_KEYS.progress;
const LEGACY_CLOCK_KEY = STORAGE_KEYS.legacyClock;
const ENHANCED_CLOCK_KEY = STORAGE_KEYS.enhancedClock;
const COUNT_MODE = CONFIG.countMode;
const USAGE_MODE = CONFIG.usageMode;
const PACE_MODE_KEY_PREFIX = STORAGE_KEYS.paceModePrefix;
const $ = (id) => document.getElementById(id);

function addOptions(select, start, end, suffix = "", step = 1, pad = false) {
  for (let v = start; v <= end; v += step) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = `${pad ? String(v).padStart(2, "0") : v}${suffix}`;
    select.appendChild(opt);
  }
}

function setupOptions() {
  addOptions($("target"), 1, 80, "件");
  addOptions($("done"), 0, 80, "件");
  addOptions($("remainH"), 0, 12, "時間");
  addOptions($("remainM"), 0, 59, "分", 1, true);
}

function setDefaultValues() {
  $("target").value = "46";
  $("done").value = "0";
  $("remainH").value = "12";
  $("remainM").value = "0";
}

function n(id) {
  const value = parseFloat($(id).value);
  return Number.isFinite(value) ? value : 0;
}

function fmtMinutes(mins) {
  const abs = Math.round(Math.abs(mins));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h <= 0) return `${m}分`;
  return `${h}時間${m}分`;
}

function fmtPace(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return "-";
  return `${mins.toFixed(2)}分/件`;
}

function paceMode(cardId) {
  return localStorage.getItem(PACE_MODE_KEY_PREFIX + cardId) === "hourly" ? "hourly" : "minutes";
}

function fmtPaceCard(mins, cardId) {
  if (!Number.isFinite(mins) || mins <= 0) return "-";
  return paceMode(cardId) === "hourly" ? `${(60 / mins).toFixed(1)}件<span class="paceSuffix">/時</span>` : `${mins.toFixed(1)}分<span class="paceSuffix">/件</span>`;
}

function togglePaceDisplayMode(cardId) {
  const next = paceMode(cardId) === "hourly" ? "minutes" : "hourly";
  localStorage.setItem(PACE_MODE_KEY_PREFIX + cardId, next);
  calc();
}

function signed(value, unit, decimals = 1) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}${unit}`;
}

function save(options = {}) {
  let previous = {};
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) previous = stored;
  } catch (e) {}
  const data = {
    ...previous,
    target: $("target").value,
    done: $("done").value,
    remainH: $("remainH").value,
    remainM: $("remainM").value
  };
  if (typeof UberQuestStore !== "undefined") {
    if (!UberQuestStore.saveProgress(data, options)) { load(); return false; }
  } else localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  return true;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    Object.keys(data).forEach(id => {
      if ($(id) && data[id] !== undefined) $(id).value = data[id];
    });
    return true;
  } catch(e) { return false; }
}

function readEnhancedClock() {
  try {
    const data = JSON.parse(localStorage.getItem(ENHANCED_CLOCK_KEY) || "null");
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const remainingMs = Number(data.remainingMs);
    if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
    return { data, remainingMs };
  } catch (_) {
    return null;
  }
}

function effectiveEnhancedClock(enhanced, now = Date.now()) {
  const data = enhanced.data;
  const updatedAt = Number(data.updatedAt);
  const counting = data.countMode === COUNT_MODE && data.on && !data.paused && !data.breakOn && !data.sessionEndedAt;
  const elapsedMs = counting && Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt <= now
    ? Math.max(0, now - updatedAt)
    : 0;
  const consumedMs = Math.min(elapsedMs, enhanced.remainingMs);
  const remainingMs = enhanced.remainingMs - consumedMs;
  return {
    remainingMs,
    activeMs: sessionUsedMsFromRemaining(remainingMs, data.usageBaselineMs),
    exhausted: Boolean(counting && consumedMs >= enhanced.remainingMs)
  };
}

function compactSessionFlags(data, now = Date.now()) {
  const ended = Boolean(data.sessionEndedAt);
  const rawUpdatedAt = Number(data.updatedAt);
  const anchorAt = Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0 ? rawUpdatedAt : now;
  const storedBreakOn = Boolean(data.breakOn);
  const sessionStartAt = data.sessionStartAt || null;
  const paused = !ended && Boolean(sessionStartAt) && !storedBreakOn && Boolean(data.paused);
  const on = !ended && !paused && Boolean(data.on) && !storedBreakOn;
  const breakOn = !ended && Boolean(sessionStartAt) && !on && !paused;
  const automaticBreakStart = Math.max(Number(sessionStartAt) || anchorAt, anchorAt);
  const breakStartedAt = breakOn ? (storedBreakOn && data.breakStartedAt ? data.breakStartedAt : automaticBreakStart) : null;
  const otherCompanyOn = on && Boolean(data.otherCompanyOn);
  return {
    on,
    paused,
    resumeOtherCompany: paused && Boolean(data.resumeOtherCompany),
    breakOn,
    breakStartedAt,
    otherCompanyOn,
    otherCompanyStartedAt: otherCompanyOn ? (data.otherCompanyStartedAt || anchorAt) : null
  };
}

function migrateEnhancedClock(enhanced, now = Date.now()) {
  const wasContinuous = enhanced.data.countMode === COUNT_MODE;
  const flags = compactSessionFlags(enhanced.data, now);
  const flagsMatch = Boolean(enhanced.data.on) === flags.on
    && Boolean(enhanced.data.paused) === flags.paused
    && Boolean(enhanced.data.resumeOtherCompany) === flags.resumeOtherCompany
    && Boolean(enhanced.data.breakOn) === flags.breakOn
    && (enhanced.data.breakStartedAt || null) === flags.breakStartedAt
    && Boolean(enhanced.data.otherCompanyOn) === flags.otherCompanyOn
    && (enhanced.data.otherCompanyStartedAt || null) === flags.otherCompanyStartedAt;
  if (wasContinuous && enhanced.data.usageMode === USAGE_MODE && flagsMatch) return enhanced;
  const rawUpdatedAt = Number(enhanced.data.updatedAt);
  const updatedAt = wasContinuous && Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
    ? rawUpdatedAt
    : now;
  const state = {
    ...enhanced.data,
    countMode: COUNT_MODE,
    usageMode: USAGE_MODE,
    on: flags.on,
    paused: flags.paused,
    resumeOtherCompany: flags.resumeOtherCompany,
    remainingMs: enhanced.remainingMs,
    moving: false,
    activeMs: sessionUsedMsFromRemaining(enhanced.remainingMs, enhanced.data.usageBaselineMs),
    breakOn: flags.breakOn,
    breakStartedAt: flags.breakStartedAt,
    otherCompanyOn: flags.otherCompanyOn,
    otherCompanyStartedAt: flags.otherCompanyStartedAt,
    backgroundGap: null,
    lastBackfillMs: 0,
    lastBackfillAt: null,
    updatedAt
  };
  UberProgressCore.storeItems([
    [ENHANCED_CLOCK_KEY, JSON.stringify(state)],
    [LEGACY_CLOCK_KEY, JSON.stringify({
      on: state.on,
      baseRemain: state.remainingMs / 60000,
      baseAt: updatedAt
    })]
  ], localStorage, globalThis.alert);
  return { data: state, remainingMs: state.remainingMs };
}

function setRemainingEditDisabled(disabled) {
  $("remainH").disabled = disabled;
  $("remainM").disabled = disabled;
}

let displayedEnhancedClock = null;
function showEnhancedRemaining(refresh = true) {
  if (refresh) {
    const stored = readEnhancedClock();
    displayedEnhancedClock = stored ? migrateEnhancedClock(stored) : null;
  }
  const enhanced = displayedEnhancedClock;
  if (!enhanced) return false;
  const effective = effectiveEnhancedClock(enhanced);
  const minutes = Math.max(0, Math.min(Math.ceil(effective.remainingMs / 60000), MAX_REMAIN_INPUT_MINUTES));
  const hours = String(Math.floor(minutes / 60));
  const mins = String(minutes % 60);
  if ($("remainH").value !== hours) $("remainH").value = hours;
  if ($("remainM").value !== mins) $("remainM").value = mins;
  setRemainingEditDisabled(Boolean(enhanced.data.sessionEndedAt));
  return true;
}

function syncEnhancedRemainingFromControls({ resetEnded = false } = {}) {
  const now = Date.now();
  const remainingMs = Math.max(0, Math.min(n("remainH") * 60 + n("remainM"), MAX_REMAIN_INPUT_MINUTES)) * 60000;
  const stored = readEnhancedClock();
  const current = stored ? migrateEnhancedClock(stored, now) : null;
  const previous = current ? current.data : {};
  if (previous.sessionEndedAt && !resetEnded) {
    showEnhancedRemaining();
    return false;
  }
  const effective = current ? effectiveEnhancedClock(current, now) : { activeMs: 0, exhausted: false };
  const on = !resetEnded && (typeof previous.on === "boolean" ? previous.on : false) && !effective.exhausted;
  const updatedAt = Math.max(now, Number(previous.updatedAt) || 0);
  const sessionStartAt = resetEnded ? null : (previous.sessionStartAt || null);
  const paused = !resetEnded && Boolean(previous.paused);
  const breakOn = !resetEnded && Boolean(sessionStartAt) && !on && !paused;
  const rawUpdatedAt = Number(previous.updatedAt);
  const exhaustedAt = effective.exhausted && Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
    ? Math.min(now, rawUpdatedAt + current.remainingMs)
    : updatedAt;
  const breakStartedAt = breakOn ? (previous.breakOn && previous.breakStartedAt ? previous.breakStartedAt : exhaustedAt) : null;
  const breakSegments = resetEnded ? [] : (Array.isArray(previous.breakSegments) ? previous.breakSegments.map(segment => ({
    startAt: segment.startAt,
    endAt: segment.endAt === null ? null : segment.endAt
  })) : []);
  if (breakOn && !previous.breakOn) breakSegments.push({ startAt: breakStartedAt, endAt: null });
  const state = {
    ...previous,
    countMode: COUNT_MODE,
    usageMode: USAGE_MODE,
    on,
    remainingMs,
    paused,
    resumeOtherCompany: paused && Boolean(previous.resumeOtherCompany),
    moving: false,
    activeMs: sessionUsedMsFromRemaining(remainingMs, resetEnded ? 0 : previous.usageBaselineMs),
    usageBaselineMs: resetEnded ? 0 : Math.max(0, Number(previous.usageBaselineMs) || 0),
    sessionStartAt,
    sessionEndedAt: resetEnded ? null : (previous.sessionEndedAt || null),
    breakOn,
    breakStartedAt,
    breakMs: resetEnded ? 0 : Math.max(0, Number(previous.breakMs) || 0),
    breakSegments,
    legacyBreakMs: resetEnded ? 0 : Math.max(0, Number(previous.legacyBreakMs) || 0),
    legacyBreakExcludedMs: resetEnded ? 0 : Math.max(0, Number(previous.legacyBreakExcludedMs) || 0),
    otherCompanyOn: !resetEnded && on && Boolean(previous.otherCompanyOn),
    otherCompanyStartedAt: !resetEnded && on && previous.otherCompanyOn ? (previous.otherCompanyStartedAt || now) : null,
    otherCompanyMs: resetEnded ? 0 : Math.max(0, Number(previous.otherCompanyMs) || 0),
    otherCompanySegments: resetEnded ? [] : previous.otherCompanySegments,
    legacyOtherCompanyMs: resetEnded ? 0 : Math.max(0, Number(previous.legacyOtherCompanyMs) || 0),
    backgroundGap: null,
    lastBackfillMs: 0,
    lastBackfillAt: null,
    updatedAt
  };
  UberProgressCore.storeItems([
    [ENHANCED_CLOCK_KEY, JSON.stringify(state)],
    [LEGACY_CLOCK_KEY, JSON.stringify({
      on,
      baseRemain: remainingMs / 60000,
      baseAt: updatedAt
    })]
  ], localStorage, globalThis.alert);
  displayedEnhancedClock = { data: state, remainingMs: state.remainingMs };
  setRemainingEditDisabled(false);
  return true;
}

function compactSegmentDurationMs(segments, sessionStartAt, at) {
  const startLimit = Number.isFinite(Number(sessionStartAt)) ? Number(sessionStartAt) : at;
  return overlapDurationMs(segments, startLimit, at);
}

function stopEnhancedClockAtGoal() {
  const now = Date.now();
  const stored = readEnhancedClock();
  const enhanced = stored ? migrateEnhancedClock(stored, now) : null;
  if (!enhanced || !enhanced.data.on || enhanced.data.sessionEndedAt) return false;
  const effective = effectiveEnhancedClock(enhanced, now);
  const previous = enhanced.data;
  const rawUpdatedAt = Number(previous.updatedAt);
  const countedUntil = effective.exhausted && Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
    ? Math.min(now, rawUpdatedAt + enhanced.remainingMs)
    : now;
  const otherCompanySegments = Array.isArray(previous.otherCompanySegments)
    ? previous.otherCompanySegments.map(segment => ({
      startAt: segment.startAt,
      endAt: segment.endAt === null ? null : segment.endAt
    }))
    : [];
  if (previous.otherCompanyOn) {
    const rawStartedAt = Number(previous.otherCompanyStartedAt);
    const startedAt = Number.isFinite(rawStartedAt) && rawStartedAt > 0 ? rawStartedAt : countedUntil;
    const endedAt = Math.max(startedAt, countedUntil);
    const openSegment = [...otherCompanySegments].reverse().find(segment => segment.endAt === null);
    if (openSegment) openSegment.endAt = endedAt;
    else otherCompanySegments.push({ startAt: startedAt, endAt: endedAt });
  }
  const activeMs = sessionUsedMsFromRemaining(effective.remainingMs, previous.usageBaselineMs);
  const legacyOtherCompanyMs = Math.max(0, Number(previous.legacyOtherCompanyMs) || 0);
  const otherCompanyMs = Math.min(
    activeMs,
    legacyOtherCompanyMs + compactSegmentDurationMs(otherCompanySegments, previous.sessionStartAt, countedUntil)
  );
  const breakSegments = Array.isArray(previous.breakSegments)
    ? previous.breakSegments.map(segment => ({
      startAt: segment.startAt,
      endAt: segment.endAt === null ? null : segment.endAt
    }))
    : [];
  const breakOn = Boolean(previous.sessionStartAt);
  if (breakOn) breakSegments.push({ startAt: countedUntil, endAt: null });
  const updatedAt = Math.max(now, Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0);
  const state = {
    ...previous,
    countMode: COUNT_MODE,
    usageMode: USAGE_MODE,
    on: false,
    remainingMs: effective.remainingMs,
    moving: false,
    activeMs,
    breakOn,
    breakStartedAt: breakOn ? countedUntil : null,
    breakSegments,
    otherCompanyOn: false,
    otherCompanyStartedAt: null,
    otherCompanyMs,
    otherCompanySegments,
    backgroundGap: null,
    lastBackfillMs: 0,
    lastBackfillAt: null,
    updatedAt
  };
  UberProgressCore.storeItems([
    [ENHANCED_CLOCK_KEY, JSON.stringify(state)],
    [LEGACY_CLOCK_KEY, JSON.stringify({
      on: false,
      baseRemain: state.remainingMs / 60000,
      baseAt: updatedAt
    })]
  ], localStorage, globalThis.alert);
  showEnhancedRemaining();
  return true;
}

function setTone(slackMinutes, perOrder, remainingOrders) {
  const hero = $("hero");
  const main = $("slackMain");
  const sub = $("slackOrders");
  hero.classList.remove("good", "warn", "late", "bad");
  main.classList.remove("goodTxt", "warnTxt", "lateTxt", "badTxt");
  sub.classList.remove("goodTxt", "lateTxt", "badTxt");

  const tone = progressTone(slackMinutes, remainingOrders, ORANGE_DELAY_LIMIT_MINUTES, perOrder);
  hero.classList.add(tone);
  main.classList.add(`${tone}Txt`);
  sub.classList.add(tone === "warn" ? "goodTxt" : `${tone}Txt`);
}

function calc(shouldSave = true, countChange = false) {
  if (shouldSave && !countChange && typeof UberQuestStore !== "undefined") $("done").value = String(UberQuestStore.currentDone());
  const target = Math.max(n("target"), 1);
  const done = Math.max(n("done"), 0);
  let remainMinutes = Math.max(n("remainH") * 60 + n("remainM"), 0);
  let progress = calculateProgress({
    target,
    done,
    currentRemainingMinutes: remainMinutes,
    effectiveRemainingMinutes: remainMinutes,
    workLimitMinutes: LIMIT_MINUTES
  });
  const remainingOrders = progress.remainingOrders;
  if (remainingOrders === 0 && stopEnhancedClockAtGoal()) {
    remainMinutes = Math.max(n("remainH") * 60 + n("remainM"), 0);
    progress = calculateProgress({
      target,
      done,
      currentRemainingMinutes: remainMinutes,
      effectiveRemainingMinutes: remainMinutes,
      workLimitMinutes: LIMIT_MINUTES
    });
  }
  const perOrder = progress.targetPaceMinutes;
  const requiredMinutes = progress.requiredMinutes;
  const slackMinutes = progress.slackMinutes;
  const neededPace = progress.neededPaceMinutes;
  const deltaVsSchedule = progress.scheduleDeltaOrders;
  const completionRate = progress.completionRate;

  setTone(slackMinutes, perOrder, remainingOrders);
  $("heroDone").textContent = String(done);
  $("heroTarget").textContent = `/ ${target}`;

  if (remainingOrders === 0) {
    $("slackMain").textContent = "目標達成";
    $("slackOrders").textContent = `${done}件完了`;
    $("miniSummary").textContent = "お疲れさまです";
  } else {
    $("slackMain").textContent = `${fmtMinutes(slackMinutes)}${slackMinutes >= 0 ? "余裕" : "遅れ"}`;
    $("slackOrders").textContent = "";
    $("miniSummary").textContent = `残り${remainingOrders}件 / 残り${Math.floor(remainMinutes / 60)}時間${String(remainMinutes % 60).padStart(2, "0")}分`;
  }

  $("remainingOrders").textContent = `${remainingOrders}件`;
  $("neededPace").innerHTML = remainingOrders > 0 ? fmtPaceCard(neededPace, "need") : "達成済み";
  $("targetPace").innerHTML = fmtPaceCard(perOrder, "targetPace");
  $("requiredTime").textContent = fmtMinutes(requiredMinutes);
  $("availableTime").textContent = fmtMinutes(remainMinutes);
  $("scheduleDelta").textContent = signed(deltaVsSchedule, "件", 2);
  $("completionRate").textContent = `${completionRate.toFixed(1)}%`;

  if (shouldSave) save({ countChange });
}

setupOptions();
setDefaultValues();
load();
showEnhancedRemaining();

["target", "done"].forEach(id => $(id).addEventListener("change", () => calc(true, id === "done")));
["remainH", "remainM"].forEach(id => $(id).addEventListener("change", () => {
  if (!syncEnhancedRemainingFromControls()) {
    calc(false);
    return;
  }
  calc();
}));

document.querySelectorAll("[data-pace-card]").forEach(card => {
  card.addEventListener("click", () => togglePaceDisplayMode(card.dataset.paceCard));
  card.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    togglePaceDisplayMode(card.dataset.paceCard);
  });
});

$("plus").addEventListener("click", () => {
  const next = Math.min((typeof UberQuestStore !== "undefined" ? UberQuestStore.currentDone() : n("done")) + 1, 80);
  $("done").value = String(next);
  calc(true, true);
});

$("minus").addEventListener("click", () => {
  const next = Math.max((typeof UberQuestStore !== "undefined" ? UberQuestStore.currentDone() : n("done")) - 1, 0);
  $("done").value = String(next);
  calc(true, true);
});

$("reset").addEventListener("click", () => {
  if (!confirm("完了件数と残り時間をリセットしますか？")) return;
  if (typeof UberQuestStore !== "undefined" && !UberQuestStore.resetCounter()) return;
  $("done").value = "0";
  $("remainH").value = "12";
  $("remainM").value = "0";
  const current = readEnhancedClock();
  syncEnhancedRemainingFromControls({ resetEnded: Boolean(current && current.data.sessionEndedAt) });
  calc();
});

calc();

window.addEventListener("storage", event => {
  if (document.hidden) return;
  if (event.key === STORAGE_KEY) {
    load();
    showEnhancedRemaining();
    calc(false);
    return;
  }
  if (event.key !== ENHANCED_CLOCK_KEY || !showEnhancedRemaining()) return;
  calc(false);
});

function refreshCompactView() {
  if (document.hidden) return;
  load();
  showEnhancedRemaining();
  calc(false);
}
window.addEventListener("pageshow", refreshCompactView);
document.addEventListener("visibilitychange", refreshCompactView);

if (typeof window.setInterval === "function") {
  window.setInterval(() => {
    if (document.hidden) return;
    const before = `${$("remainH").value}:${$("remainM").value}`;
    if (showEnhancedRemaining(false) && before !== `${$("remainH").value}:${$("remainM").value}`) calc(false);
  }, 1000);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js?v=75").catch(() => {}));
}
