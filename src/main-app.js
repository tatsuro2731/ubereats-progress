const {
  CONFIG,
  STORAGE_KEYS,
  activeConstraint: resolveActiveConstraint,
  calculateProgress,
  progressTone,
  sessionUsedMsFromRemaining,
  resolveEndLimit
} = UberProgressCore;
const WORK_LIMIT_MINUTES = CONFIG.workLimitMinutes;
const MAX_REMAIN_INPUT_MINUTES = CONFIG.maxRemainingInputMinutes;
const RECOVERY_PACE_MINUTES = CONFIG.recoveryPaceMinutes;
const ORANGE_DELAY_LIMIT_MINUTES = CONFIG.orangeDelayLimitMinutes;
const STORAGE_KEY = STORAGE_KEYS.progress;
const CLOCK_KEY = STORAGE_KEYS.legacyClock;
const PACE_MODE_KEY_PREFIX = STORAGE_KEYS.paceModePrefix;
const $ = id => document.getElementById(id);
// Skip equal DOM writes so timer refreshes do not replace nodes or trigger layout.
const renderedMarkup = new WeakMap();
function setText(element, value) {
  renderedMarkup.delete(element);
  const text = String(value);
  if (element.textContent !== text) element.textContent = text;
}
function setMarkup(element, value) {
  if (renderedMarkup.get(element) === value) return;
  element.innerHTML = value;
  renderedMarkup.set(element, value);
}
function setAttributeIfChanged(element, name, value) {
  const text = String(value);
  if (element.getAttribute && element.getAttribute(name) === text) return;
  element.setAttribute(name, text);
}
const LEGACY_DEFAULT_CARDS = ["remaining", "need", "eta", "safe", "project12", "targetPace"];
const DEFAULT_CARDS = ["actualPace", "need", "remaining", "eta", "elapsed", "workRate"];
const FOUR_CARD_DEFAULTS = ["actualPace", "need", "eta", "workRate"];
const CARD_OPTIONS = [
  ["remaining", "進捗件数"],
  ["need", "必要ペース"],
  ["eta", "終了予測"],
  ["actualPace", "実績ペース"],
  ["safe", "狙える件数"],
  ["targetPace", "目標ペース"],
  ["project12", "上限まで走ると"],
  ["constraint", "制約条件"],
  ["elapsed", "経過時間（休憩除く）"],
  ["workRate", "稼働率"]
];
let clockState = { on: false, baseRemain: 0, baseAt: Date.now() };
let cardCount = 6;
let cards = [...DEFAULT_CARDS];
let cardOrderMode = false;
let cardDrag = null;
let settingsReturnFocus = null;
let settingsSwipe = null;
let settingsSwipeTimer = null;

const SETTINGS_SWIPE_START_DISTANCE = 8;
const SETTINGS_SWIPE_FLICK_DISTANCE = 28;
const SETTINGS_SWIPE_FLICK_VELOCITY = 0.55;

function settingsSwipeEventTime(event) {
  const value = Number(event.timeStamp);
  return Number.isFinite(value) ? value : Date.now();
}

function settingsSwipeReducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function settingsSwipeSheetHeight() {
  const sheet = $("settingsDialog");
  const rect = sheet.getBoundingClientRect ? sheet.getBoundingClientRect() : null;
  return Math.max(1, Number(rect && rect.height) || sheet.offsetHeight || document.documentElement.clientHeight || 800);
}

function settingsSwipeCloseDistance(sheetHeight = settingsSwipeSheetHeight()) {
  return Math.min(120, Math.max(72, sheetHeight * 0.12));
}

function requestSettingsSwipeFrame(callback) {
  return window.requestAnimationFrame && window.cancelAnimationFrame
    ? window.requestAnimationFrame(callback)
    : setTimeout(callback, 16);
}

function cancelSettingsSwipeFrame(swipe) {
  if (!swipe || swipe.frameId === null) return;
  if (window.requestAnimationFrame && window.cancelAnimationFrame) window.cancelAnimationFrame(swipe.frameId);
  else clearTimeout(swipe.frameId);
  swipe.frameId = null;
}

function renderSettingsSwipe(swipe) {
  if (!swipe || settingsSwipe !== swipe) return;
  swipe.frameId = null;
  $("settingsDialog").style.setProperty("transform", `translate3d(0,${swipe.offset}px,0)`);
}

function scheduleSettingsSwipeRender(swipe) {
  if (!swipe || swipe.frameId !== null) return;
  swipe.frameId = requestSettingsSwipeFrame(() => renderSettingsSwipe(swipe));
}

function releaseSettingsSwipePointer(swipe) {
  if (!swipe || !swipe.area || !swipe.area.releasePointerCapture) return;
  try {
    if (!swipe.area.hasPointerCapture || swipe.area.hasPointerCapture(swipe.pointerId)) swipe.area.releasePointerCapture(swipe.pointerId);
  } catch (_) {}
}

function clearSettingsSwipeState() {
  const swipe = settingsSwipe;
  settingsSwipe = null;
  cancelSettingsSwipeFrame(swipe);
  releaseSettingsSwipePointer(swipe);
  $("settingsDialog").classList.remove("settingsDragging");
}

function resetSettingsSwipeVisuals() {
  clearSettingsSwipeState();
  if (settingsSwipeTimer !== null) clearTimeout(settingsSwipeTimer);
  settingsSwipeTimer = null;
  $("settingsLayer").classList.remove("settingsSwipeSettling");
  $("settingsDialog").style.removeProperty("--settings-drag-y");
  $("settingsDialog").style.removeProperty("transform");
  $("settingsBackdrop").style.removeProperty("opacity");
}

function settleSettingsSwipe(close) {
  const layer = $("settingsLayer");
  const sheet = $("settingsDialog");
  const backdrop = $("settingsBackdrop");
  const sheetHeight = settingsSwipe ? settingsSwipe.sheetHeight : settingsSwipeSheetHeight();
  clearSettingsSwipeState();
  layer.classList.add("settingsSwipeSettling");
  sheet.style.setProperty("transform", close ? `translate3d(0,${sheetHeight + 32}px,0)` : "translate3d(0,0,0)");
  backdrop.style.setProperty("opacity", close ? "0" : "1");

  const complete = () => {
    settingsSwipeTimer = null;
    if (close) setSettingsOpen(false);
    else resetSettingsSwipeVisuals();
  };
  if (settingsSwipeReducedMotion()) complete();
  else settingsSwipeTimer = setTimeout(complete, 230);
}

function startSettingsSwipe(event) {
  const layer = $("settingsLayer");
  if (layer.hidden || settingsSwipe || layer.classList.contains("settingsSwipeSettling")) return;
  if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
  if (!Number.isFinite(Number(event.clientX)) || !Number.isFinite(Number(event.clientY))) return;
  if (event.target.closest && event.target.closest("button,a,input,select,textarea,[role='button']")) return;

  resetSettingsSwipeVisuals();
  const area = $("settingsDragArea");
  const at = settingsSwipeEventTime(event);
  const sheetHeight = settingsSwipeSheetHeight();
  settingsSwipe = {
    area,
    pointerId: event.pointerId,
    startX: Number(event.clientX),
    startY: Number(event.clientY),
    startAt: at,
    lastY: Number(event.clientY),
    lastAt: at,
    lastMotionAt: at,
    sheetHeight,
    closeDistance: settingsSwipeCloseDistance(sheetHeight),
    velocityY: 0,
    offset: 0,
    frameId: null,
    active: false
  };
  if (area.setPointerCapture) {
    try { area.setPointerCapture(event.pointerId); } catch (_) {}
  }
}

function continueSettingsSwipe(event) {
  const swipe = settingsSwipe;
  if (!swipe || event.pointerId !== swipe.pointerId) return;
  let point = event;
  if (event.getCoalescedEvents) {
    const points = event.getCoalescedEvents();
    if (points && points.length) point = points[points.length - 1];
  }
  const x = Number(point.clientX);
  const y = Number(point.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = x - swipe.startX;
  const rawY = y - swipe.startY;
  if (!swipe.active) {
    if (Math.hypot(dx, rawY) < SETTINGS_SWIPE_START_DISTANCE) return;
    if (rawY <= 0 || Math.abs(dx) > rawY) {
      resetSettingsSwipeVisuals();
      return;
    }
    swipe.active = true;
    $("settingsDialog").classList.add("settingsDragging");
  }

  const at = settingsSwipeEventTime(point);
  const elapsed = at - swipe.lastAt;
  const movement = y - swipe.lastY;
  if (elapsed > 0 && Math.abs(movement) > 0.5) {
    swipe.velocityY = elapsed <= 160 ? movement / elapsed : 0;
    swipe.lastMotionAt = at;
  } else if (at - swipe.lastMotionAt > 120) {
    swipe.velocityY = 0;
  }
  swipe.lastY = y;
  swipe.lastAt = at;
  swipe.offset = Math.max(0, rawY);
  if (event.preventDefault) event.preventDefault();
  scheduleSettingsSwipeRender(swipe);
}

function finishSettingsSwipe(event, cancelled = false) {
  const initial = settingsSwipe;
  if (!initial || event.pointerId !== initial.pointerId) return;
  if (!cancelled) continueSettingsSwipe(event);
  const swipe = settingsSwipe;
  if (!swipe) return;
  if (!swipe.active) {
    resetSettingsSwipeVisuals();
    return;
  }
  if (cancelled) {
    settleSettingsSwipe(false);
    return;
  }
  const at = settingsSwipeEventTime(event);
  const totalElapsed = Math.max(1, at - swipe.startAt);
  const totalVelocity = swipe.offset / totalElapsed;
  const recentVelocity = at - swipe.lastMotionAt <= 120 ? Math.max(0, swipe.velocityY) : 0;
  const velocity = Math.max(totalVelocity, recentVelocity);
  const close = swipe.offset >= swipe.closeDistance || (swipe.offset >= SETTINGS_SWIPE_FLICK_DISTANCE && velocity >= SETTINGS_SWIPE_FLICK_VELOCITY);
  settleSettingsSwipe(close);
}

function setupSettingsSwipe() {
  const area = $("settingsDragArea");
  if (area.dataset.settingsSwipeReady === "true") return;
  area.dataset.settingsSwipeReady = "true";
  area.addEventListener("pointerdown", startSettingsSwipe);
  area.addEventListener("pointermove", continueSettingsSwipe);
  area.addEventListener("pointerup", event => finishSettingsSwipe(event, false));
  area.addEventListener("pointercancel", event => finishSettingsSwipe(event, true));
  area.addEventListener("lostpointercapture", event => finishSettingsSwipe(event, true));
}

function commitSettingsChanges() {
  const dialog = $("settingsDialog");
  const active = document.activeElement;
  if (active && dialog.contains(active) && typeof active.blur === "function") active.blur();
  save();
  calc();
}

function setSettingsOpen(open, restoreFocus = true) {
  const layer = $("settingsLayer");
  const wasOpen = !layer.hidden;
  if (!open && wasOpen) commitSettingsChanges();
  resetSettingsSwipeVisuals();
  if (open) {
    settingsReturnFocus = document.activeElement;
    layer.hidden = false;
    $("appRoot").inert = true;
    document.body.classList.add("settingsModalOpen");
    $("settingsOpen").setAttribute("aria-expanded", "true");
    $("settingsDialog").focus({ preventScroll: true });
    return;
  }
  layer.hidden = true;
  $("appRoot").inert = false;
  document.body.classList.remove("settingsModalOpen");
  $("settingsOpen").setAttribute("aria-expanded", "false");
  if (restoreFocus && settingsReturnFocus && settingsReturnFocus.isConnected) settingsReturnFocus.focus({ preventScroll: true });
  settingsReturnFocus = null;
}

function handleSettingsKey(event) {
  if ($("settingsLayer").hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    setSettingsOpen(false);
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...$("settingsDialog").querySelectorAll("button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])")].filter(element => element.offsetParent !== null);
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
}

function addOptions(element, start, end, suffix = "", step = 1, pad = false) {
  for (let value = start; value <= end; value += step) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${pad ? String(value).padStart(2, "0") : value}${suffix}`;
    element.appendChild(option);
  }
}

function n(id) {
  const value = parseFloat($(id).value);
  return Number.isFinite(value) ? value : 0;
}

function manualRemain() {
  return Math.max(n("remainH") * 60 + n("remainM"), 0);
}

function setRemain(minutes) {
  const value = Math.min(MAX_REMAIN_INPUT_MINUTES, Math.max(0, Math.ceil(minutes)));
  $("remainH").value = String(Math.floor(value / 60));
  $("remainM").value = String(value % 60);
}

function remain() {
  if (!clockState.on) return manualRemain();
  const elapsed = Math.floor((Date.now() - clockState.baseAt) / 60000);
  const value = Math.max(0, clockState.baseRemain - elapsed);
  if (value <= 0) {
    clockState.on = false;
    clockState.baseRemain = 0;
    saveClock();
  }
  return value;
}

function syncClock() {
  clockState.baseRemain = manualRemain();
  clockState.baseAt = Date.now();
  saveClock();
}

function adjustRemain(delta) {
  const current = remain();
  const value = Math.max(0, Math.min(current + delta, MAX_REMAIN_INPUT_MINUTES));
  setRemain(value);
  if (value !== current) syncClock();
  save();
  calc();
}

function adjustDone(delta) {
  const current = typeof UberQuestStore !== "undefined" ? UberQuestStore.currentDone() : n("done");
  const value = Math.max(0, Math.min(current + delta, 80));
  if (value === current) return;
  $("done").value = String(value);
  save({ countChange: true });
  calc();
}

function enableHoldRepeat(buttonId, action) {
  const button = $(buttonId);
  let pointerId = null;
  let holdTimer = null;
  let repeatTimer = null;
  let repeated = false;

  function stopHold(event, applyTap = false) {
    if (pointerId === null || (event && event.pointerId !== pointerId)) return;
    const activePointerId = pointerId;
    pointerId = null;
    clearTimeout(holdTimer);
    clearInterval(repeatTimer);
    holdTimer = null;
    repeatTimer = null;
    if (applyTap && !repeated) action();
    repeated = false;
    if (button.hasPointerCapture && button.hasPointerCapture(activePointerId)) button.releasePointerCapture(activePointerId);
  }

  button.addEventListener("pointerdown", event => {
    if (!event.isPrimary || pointerId !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    pointerId = event.pointerId;
    repeated = false;
    if (button.setPointerCapture) button.setPointerCapture(pointerId);
    holdTimer = setTimeout(() => {
      repeated = true;
      action();
      repeatTimer = setInterval(action, 120);
    }, 420);
  });
  button.addEventListener("pointerup", event => stopHold(event, true));
  button.addEventListener("pointercancel", event => stopHold(event));
  button.addEventListener("lostpointercapture", event => stopHold(event));
  button.addEventListener("contextmenu", event => event.preventDefault());
  button.addEventListener("click", event => {
    if (event.detail !== 0) {
      event.preventDefault();
      return;
    }
    action();
  });
}

function stopClock(remaining) {
  const value = Math.max(0, Math.round(remaining));
  setRemain(value);
  clockState = { on: false, baseRemain: value, baseAt: Date.now() };
  saveClock();
  save();
}

function toggleClock() {
  const value = remain();
  setRemain(value);
  clockState = { on: !clockState.on, baseRemain: value, baseAt: Date.now() };
  saveClock();
  save();
  calc();
}

function saveClock() {
  localStorage.setItem(CLOCK_KEY, JSON.stringify(clockState));
}

function loadClock() {
  try {
    const data = JSON.parse(localStorage.getItem(CLOCK_KEY) || "{}");
    if (typeof data.on === "boolean") {
      clockState = {
        on: data.on,
        baseRemain: Number(data.baseRemain) || manualRemain(),
        baseAt: Number(data.baseAt) || Date.now()
      };
    }
  } catch (e) {}
}

function fillCards(value) {
  const valid = new Set(CARD_OPTIONS.map(option => option[0]));
  const result = [];
  const append = id => {
    if (result.length < 6 && valid.has(id) && !result.includes(id)) result.push(id);
  };
  (Array.isArray(value) ? value : []).forEach(append);
  DEFAULT_CARDS.forEach(append);
  CARD_OPTIONS.forEach(option => append(option[0]));
  return result.slice(0, 6);
}

function save(options = {}) {
  cards = fillCards(cards);
  const endLimitTime = $("endLimit").value;
  let previous = {};
  try { previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (_) {}
  const data = {
    ...(previous && typeof previous === "object" ? previous : {}),
    target: $("target").value,
    done: $("done").value,
    remainH: $("remainH").value,
    remainM: $("remainM").value,
    endLimitTime,
    endLimit: endLimitTime,
    displayCount: String(cardCount),
    cardCount: String(cardCount),
    displayCards: cards
  };
  if (typeof UberQuestStore !== "undefined") {
    if (!UberQuestStore.saveProgress(data, options)) { load(); return false; }
  } else localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  if (typeof UberQuestStore !== "undefined") $("done").value = String(UberQuestStore.currentDone());
  return true;
}

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    Object.keys(data).forEach(key => {
      if ($(key)) $(key).value = data[key];
    });
    if (data.endLimitTime !== undefined) $("endLimit").value = data.endLimitTime || "";
    else if (data.endLimit !== undefined) $("endLimit").value = data.endLimit || "";
    const storedCount = Number(data.displayCount || data.cardCount);
    cardCount = [3, 4, 6].includes(storedCount) ? storedCount : 6;
    if (Array.isArray(data.displayCards)) {
      cards = data.displayCards.filter(id => CARD_OPTIONS.some(option => option[0] === id));
      // Refresh only the built-in layouts; preserve personally selected card sets.
      if (cards.join("|") === LEGACY_DEFAULT_CARDS.join("|")) cards = [...DEFAULT_CARDS];
      if (cards.join("|") === "remaining|eta|actualPace|need|project12|targetPace") {
        cards = [...FOUR_CARD_DEFAULTS, "project12", "targetPace"];
      }
    }
  } catch (e) {}
  cards = fillCards(cards);
  $("cardCount").value = String(cardCount);
}

function syncCardCountControl() {
  document.querySelectorAll("[data-card-count]").forEach(button => {
    const active = Number(button.dataset.cardCount) === cardCount;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = cardOrderMode;
  });
}

function selectCardCount(value) {
  const selected = Number(value);
  cardCount = [3, 4, 6].includes(selected) ? selected : 6;
  $("cardCount").value = String(cardCount);
  if (cardCount === 4 && cards.join("|") === DEFAULT_CARDS.join("|")) {
    cards = [...FOUR_CARD_DEFAULTS, "project12", "targetPace"];
    renderCardSelectors();
  }
  syncCardCountControl();
  save();
  calc();
}

function formatMinutes(minutes) {
  const value = Math.round(Math.abs(minutes));
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return hours ? `${hours}時間${mins}分` : `${mins}分`;
}

function hourMinuteText(minutes) {
  const value = Math.max(0, minutes);
  return `${Math.floor(value / 60)}時間${String(value % 60).padStart(2, "0")}分`;
}

function remainingText(minutes) {
  return hourMinuteText(Math.ceil(minutes));
}

function elapsedText(minutes) {
  return hourMinuteText(Math.floor(minutes));
}

function paceMode(cardId) {
  return localStorage.getItem(PACE_MODE_KEY_PREFIX + cardId) === "hourly" ? "hourly" : "minutes";
}

function paceModeLabel(cardId) {
  return paceMode(cardId) === "hourly" ? "件/時" : "分/件";
}

function pacePerOrder(minutes) {
  return Number.isFinite(minutes) && minutes > 0 ? `${minutes.toFixed(1)}分<span class="paceSuffix">/件</span>` : "-";
}

function pacePerHour(minutes) {
  return Number.isFinite(minutes) && minutes > 0 ? `${(60 / minutes).toFixed(1)}件<span class="paceSuffix">/時</span>` : "-";
}

function paceCardText(minutes, cardId) {
  return paceMode(cardId) === "hourly" ? pacePerHour(minutes) : pacePerOrder(minutes);
}

function togglePaceDisplayMode(cardId) {
  const next = paceMode(cardId) === "hourly" ? "minutes" : "hourly";
  localStorage.setItem(PACE_MODE_KEY_PREFIX + cardId, next);
  calc();
}

let clockFormatter;
let clockFormatterOffset;
function clock(date) {
  const offset = new Date().getTimezoneOffset();
  if (!clockFormatter || clockFormatterOffset !== offset) {
    clockFormatter = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
    clockFormatterOffset = offset;
  }
  return clockFormatter.format(date);
}

function eta(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "-";
  const now = new Date();
  const end = new Date(now.getTime() + minutes * 60000);
  return `${end.toDateString() !== now.toDateString() ? "翌" : ""}${clock(end)}`;
}

function countEndLabel(remaining) {
  if (!Number.isFinite(remaining) || remaining <= 0) return "使い切り 到達";
  const now = new Date();
  const endAt = clockState.on
    ? clockState.baseAt + clockState.baseRemain * 60000
    : now.getTime() + remaining * 60000;
  const end = new Date(endAt);
  return `使い切り ${end.toDateString() !== now.toDateString() ? "翌" : ""}${clock(end)}`;
}

function endValue() {
  return $("endLimit").value || "";
}

function endInfo() {
  const resolved = resolveEndLimit(endValue());
  return resolved ? {
    m: resolved.minutes,
    d: resolved.date,
    over: resolved.over,
    label: resolved.label
  } : null;
}

function activeConstraint(remaining, limit) {
  const resolved = resolveActiveConstraint(remaining, limit);
  return {
    m: resolved.minutes,
    label: resolved.label,
    kind: resolved.kind,
    endOn: resolved.endOn,
    endM: resolved.endMinutes,
    endLabel: resolved.endLabel,
    over: resolved.over
  };
}

function constraintTag(active) {
  if (!active.endOn) return "12時間制限基準";
  return active.kind === "end" ? "終了上限基準" : "12時間制限基準";
}

function setTone(margin, left) {
  const hero = $("hero");
  const main = $("mainValue");
  hero.className = "hero";
  main.className = "main";
  $("subValue").className = "sub";
  const tone = progressTone(margin, left, ORANGE_DELAY_LIMIT_MINUTES);
  hero.classList.add(tone);
  main.classList.add(`${tone}Txt`);
}

function bikeIcon(count) {
  const icon = '<svg class="bike" viewBox="0 0 32 28" aria-hidden="true"><use href="assets/ui-icons.svg?v=73#scooter"></use></svg>';
  return `<span class="bikes" aria-hidden="true">${icon.repeat(count)}</span>`;
}

function limitText(value, type) {
  if (Number.isFinite(value) && value > 0) {
    const rounded = Math.round(value);
    if (type === "s" && rounded < 10) return "シングル：ショート優先";
    if (type === "d" && rounded < 20) return "ダブル：厳しめ";
    return `${type === "s" ? "シングル" : "ダブル"} ${rounded}分まで`;
  }
  return type === "s" ? "シングル：ショート優先" : "ダブル：非推奨";
}

function limits(targetPace, margin) {
  if (margin < 0) {
    const delay = Math.abs(margin);
    const gainPerOrder = targetPace - RECOVERY_PACE_MINUTES;
    const recoveryLimit = orders => {
      const isDouble = orders === 2;
      let title = `${isDouble ? "ダブル" : "シングル"} ${RECOVERY_PACE_MINUTES * orders}分`;
      let note = "10分/件では回復不可";
      if (Number.isFinite(gainPerOrder) && gainPerOrder > 0) {
        const count = Math.max(1, Math.ceil(delay / (gainPerOrder * orders)));
        title += ` ×${count}`;
        note = "復帰目安";
      }
      return `<span class="lim recovery">${bikeIcon(orders)}<span class="recoveryCopy"><strong>${title}</strong><small>${note}</small></span></span>`;
    };
    return `<div class="limits">${recoveryLimit(1)}${recoveryLimit(2)}</div>`;
  }
  const guide = (orders, value, type) => {
    const text = limitText(value, type);
    const label = type === "s" ? "シングル" : "ダブル";
    const match = text.match(/ (\d+)分まで$/);
    const detail = match
      ? `<strong class="guideValue">${match[1]}<span class="guideUnit">分まで</span></strong>`
      : `<strong class="guideAlternative">${text.replace(`${label}：`, "")}</strong>`;
    return `<span class="lim">${bikeIcon(orders)}<span class="guideCopy"><span class="guideLabel">${label}</span>${detail}</span></span>`;
  };
  return `<div class="limits">${guide(1, targetPace + margin, "s")}${guide(2, targetPace * 2 + margin, "d")}</div>`;
}

function metricIcon(id) {
  return `<span class="metricIconSlot" aria-hidden="true"><svg class="metricIcon" viewBox="0 0 24 24"><use href="assets/ui-icons.svg?v=73#${id}"></use></svg></span>`;
}

function slackMarkup(minutes) {
  const formatted = formatMinutes(minutes).replace(/(時間|分)/g, '<span class="timeUnit">$1</span>');
  return `${formatted}<span class="slackState">${minutes >= 0 ? "余裕" : "遅れ"}</span>`;
}

function renderClock(remaining) {
  $("countRemain").textContent = `残り ${remainingText(remaining)}`;
  $("countEndClock").textContent = countEndLabel(remaining);
  $("countEndClock").classList.toggle("run", clockState.on);
  const button = $("countToggle");
  const sub = $("countSub");
  const dot = $("countDot");
  const panel = $("countPanel");
  $("countStatusDetail").textContent = clockState.on ? "時間ON" : "時間OFF";
  $("sessionStatus").dataset.state = clockState.on ? "working" : "break";
  $("operationDock").dataset.state = clockState.on ? "working" : "break";
  button.setAttribute("aria-pressed", String(clockState.on));
  button.setAttribute("aria-label", clockState.on ? "稼働中。時間ON。タップで休憩" : "停止中。時間OFF。タップで開始");
  if (clockState.on) {
    $("countStatus").textContent = "稼働中";
    button.classList.add("off");
    button.firstChild.nodeValue = "稼働中";
    sub.textContent = "時間ON・タップで休憩";
    dot.classList.remove("stop");
    panel.classList.add("run");
  } else {
    $("countStatus").textContent = "停止中";
    button.classList.remove("off");
    button.firstChild.nodeValue = "停止中";
    sub.textContent = "時間OFF・タップで開始";
    dot.classList.add("stop");
    panel.classList.remove("run");
  }
}

let renderedSelectorKey = "";
function renderCardSelectors() {
  const key = JSON.stringify([cards, cardOrderMode]);
  if (key === renderedSelectorKey) return;
  renderedSelectorKey = key;
  const box = $("cardSelectors");
  box.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const wrapper = document.createElement("div");
    const label = document.createElement("label");
    const select = document.createElement("select");
    wrapper.className = "selBox";
    label.textContent = `${i + 1}番目`;
    select.id = `cardSel${i}`;
    label.htmlFor = select.id;
    CARD_OPTIONS.forEach(option => {
      const item = document.createElement("option");
      item.value = option[0];
      item.textContent = option[1];
      select.appendChild(item);
    });
    select.value = cards[i] || DEFAULT_CARDS[i];
    select.disabled = cardOrderMode;
    select.onchange = () => {
      const previous = cards[i];
      const next = select.value;
      const duplicateIndex = cards.findIndex((id, index) => index !== i && id === next);
      cards[i] = next;
      if (duplicateIndex >= 0) cards[duplicateIndex] = previous;
      cards = fillCards(cards);
      save();
      renderCardSelectors();
      calc();
      if (duplicateIndex >= 0) announceCardOrder(`${cardLabel(next)}と${cardLabel(previous)}を入れ替えました`);
    };
    wrapper.append(label, select);
    box.appendChild(wrapper);
  }
}

function applyCardCount() {
  const selected = Number($("cardCount").value);
  cardCount = [3, 4, 6].includes(selected) ? selected : 6;
  $("metrics").dataset.cardCount = String(cardCount);
  for (let i = 0; i < 6; i++) {
    const element = $(`cardSel${i}`);
    if (element) element.parentElement.style.display = i < cardCount ? "block" : "none";
  }
}

function isPaceToggleCard(id) {
  return id === "need" || id === "targetPace" || id === "actualPace";
}

let renderedCardLayout = "";
function drawCards(values) {
  if (cardDrag) return;
  const ids = fillCards(cards).slice(0, cardCount);
  const layout = JSON.stringify([ids, cardOrderMode]);
  const metrics = $("metrics");
  const rendered = ids.map((id, index) => {
    const item = values[id] || values.remaining;
    const toggle = isPaceToggleCard(id) && !cardOrderMode;
    const attrs = toggle ? ` role="button" tabindex="0" aria-label="${item.k}の表示を切り替え" title="タップで分/件と件/時を切替"` : "";
    const handle = cardOrderMode ? `<button class="dragHandle" type="button" aria-label="${item.k}を移動" title="長押しして移動">≡</button>` : "";
    const switchIcon = toggle ? '<svg class="paceSwitchIcon" viewBox="0 0 24 24" aria-hidden="true"><use href="assets/ui-icons.svg?v=73#swap"></use></svg>' : "";
    const content = `${handle}<div class="k">${metricIcon(id)}<span>${item.k}</span>${switchIcon}</div><div class="v">${item.v}</div>${item.p || ""}${item.n ? `<div class="note">${item.n}</div>` : ""}`;
    return { id, content, html: `<div class="metric${toggle ? " paceToggle" : ""}" data-card-id="${id}" data-card-index="${index}"${attrs}>${content}</div>` };
  });
  const existing = rendered.map(item => metrics.querySelector(`.metric[data-card-id="${item.id}"]`));
  if (layout !== renderedCardLayout || existing.some(element => !element)) {
    setMarkup(metrics, rendered.map(item => item.html).join(""));
    renderedCardLayout = layout;
    rendered.forEach(item => {
      const card = metrics.querySelector(`.metric[data-card-id="${item.id}"]`);
      if (card) renderedMarkup.set(card, item.content);
    });
    return;
  }
  rendered.forEach((item, index) => setMarkup(existing[index], item.content));
}

function renderTodaySummary(target, done, used, actualPace) {
  const summary = $("todaySummary");
  const achieved = done >= target;
  summary.hidden = !achieved;
  if (!achieved) return;
  const over = Math.max(done - target, 0);
  setText($("todaySummaryLead"), over ? `目標${target}件を${over}件上回って達成` : `目標${target}件を達成`);
  setText($("todaySummaryDone"), `${done}件`);
  setText($("todaySummaryWork"), elapsedText(used));
  setText($("todaySummaryPace"), Number.isFinite(actualPace) ? `${actualPace.toFixed(2)}分/件` : "計測なし");
  setText($("todaySummaryHourly"), Number.isFinite(actualPace) && actualPace > 0 ? `${(60 / actualPace).toFixed(1)}件/時` : "計測なし");
}

function cardLabel(id) {
  const option = CARD_OPTIONS.find(item => item[0] === id);
  return option ? option[1] : "小カード";
}

function announceCardOrder(message) {
  $("cardOrderLive").textContent = message;
}

function moveCard(from, to) {
  if (from === to || from < 0 || to < 0 || from >= cardCount || to >= cardCount) return;
  const visible = cards.slice(0, cardCount);
  const [moved] = visible.splice(from, 1);
  visible.splice(to, 0, moved);
  cards = [...visible, ...cards.slice(cardCount)];
  save();
  renderCardSelectors();
  calc();
  announceCardOrder(`${cardLabel(moved)}を${to + 1}番目に移動しました`);
}

function setCardOrderMode(enabled, scrollToCards = false) {
  if (!enabled && cardDrag) finishCardDrag(false);
  cardOrderMode = enabled;
  $("cardCount").disabled = enabled;
  $("cardSelectors").querySelectorAll("select").forEach(select => { select.disabled = enabled; });
  $("metrics").classList.toggle("reorderMode", enabled);
  $("cardOrderToolbar").hidden = !enabled;
  $("cardOrderToggle").classList.toggle("active", enabled);
  $("cardOrderToggle").setAttribute("aria-pressed", String(enabled));
  $("cardOrderLabel").textContent = enabled ? "並び替えを完了" : "カードを並び替える";
  syncCardCountControl();
  calc();
  if (enabled) {
    announceCardOrder("並び替えモードを開始しました");
    if (scrollToCards) setTimeout(() => $("cardOrderToolbar").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  } else {
    announceCardOrder("並び順を保存しました");
  }
}

function updateCardDrag() {
  if (!cardDrag || !cardDrag.active) return;
  const dx = cardDrag.x - cardDrag.startX;
  const dy = cardDrag.y - cardDrag.startY;
  cardDrag.card.style.transform = `translate3d(${dx}px,${dy}px,0) scale(1.035)`;

  let target = cardDrag.source;
  if (Math.hypot(dx, dy) >= 12) {
    let bestDistance = Infinity;
    cardDrag.rects.forEach((rect, index) => {
      const distance = Math.hypot(cardDrag.x - (rect.left + rect.width / 2), cardDrag.y - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        target = index;
      }
    });
  }
  cardDrag.target = target;
  $("metrics").querySelectorAll(".metric").forEach((card, index) => card.classList.toggle("dropTarget", index === target));
}

function beginCardDrag() {
  if (!cardDrag || !cardDrag.card.isConnected) return;
  cardDrag.active = true;
  cardDrag.rects = [...$("metrics").querySelectorAll(".metric")].map(card => card.getBoundingClientRect());
  cardDrag.card.classList.add("dragging");
  cardDrag.handle.classList.remove("pressing");
  updateCardDrag();
  announceCardOrder(`${cardLabel(cards[cardDrag.source])}を移動中`);
}

function finishCardDrag(commit) {
  if (!cardDrag) return;
  const state = cardDrag;
  cardDrag = null;
  clearTimeout(state.timer);
  const { handle, card, pointerId, source, target, active } = state;
  if (handle.hasPointerCapture && handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  handle.classList.remove("pressing");
  card.classList.remove("dragging");
  card.style.transform = "";
  $("metrics").querySelectorAll(".metric").forEach(item => item.classList.remove("dropTarget"));
  if (commit && active && source !== target) moveCard(source, target);
  else if (commit && active) announceCardOrder("並び順は変わりませんでした");
  else if (commit) announceCardOrder("長押しすると移動できます");
  else if (active) announceCardOrder("移動をキャンセルしました");
}

function startCardDrag(event) {
  const handle = event.target.closest(".dragHandle");
  if (!cardOrderMode || !handle || cardDrag) return;
  const card = handle.closest(".metric");
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("pressing");
  cardDrag = {
    pointerId: event.pointerId,
    source: Number(card.dataset.cardIndex),
    target: Number(card.dataset.cardIndex),
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    active: false,
    handle,
    card,
    rects: [],
    timer: setTimeout(beginCardDrag, event.pointerType === "mouse" ? 0 : 260)
  };
}

function continueCardDrag(event) {
  if (!cardDrag || event.pointerId !== cardDrag.pointerId) return;
  cardDrag.x = event.clientX;
  cardDrag.y = event.clientY;
  if (cardDrag.active) {
    event.preventDefault();
    updateCardDrag();
  }
}

function handleCardOrderKey(event) {
  const handle = event.target.closest(".dragHandle");
  if (!cardOrderMode || !handle) return false;
  const from = Number(handle.closest(".metric").dataset.cardIndex);
  const columns = cardCount === 4 ? 2 : 3;
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
  if (!(event.key in offsets)) return false;
  event.preventDefault();
  const to = Math.max(0, Math.min(cardCount - 1, from + offsets[event.key]));
  moveCard(from, to);
  const nextHandle = $("metrics").querySelector(`.metric[data-card-index="${to}"] .dragHandle`);
  if (nextHandle) nextHandle.focus();
  return true;
}

function calc() {
  const wasCounting = clockState.on;
  const currentRemain = remain();
  const target = Math.max(n("target"), 1);
  const done = Math.max(n("done"), 0);
  const end = endInfo();
  const active = activeConstraint(currentRemain, end);
  const progress = calculateProgress({
    target,
    done,
    currentRemainingMinutes: currentRemain,
    effectiveRemainingMinutes: active.m,
    actualUsedMinutes: clockState.sessionStartAt
      ? sessionUsedMsFromRemaining(clockState.remainingMs, clockState.usageBaselineMs) / 60000
      : undefined,
    workLimitMinutes: WORK_LIMIT_MINUTES
  });
  const left = progress.remainingOrders;
  if (wasCounting) setRemain(currentRemain);
  if (left === 0 && wasCounting) stopClock(currentRemain);
  if (document.hidden) return;

  const effectiveRemain = active.m;
  const used = progress.actualUsedMinutes;
  const targetPace = progress.targetPaceMinutes;
  const margin = progress.slackMinutes;
  const neededPace = progress.neededPaceMinutes;
  const actualPace = progress.actualPaceMinutes;
  const finish = progress.minutesToTarget;
  const rate = progress.completionRate;
  const safe = progress.attainableCount;
  const projection = progress.projectedCount;
  const etaCap = active.over ? currentRemain : effectiveRemain;
  const etaText = left === 0 ? "達成済み" : !Number.isFinite(finish) ? "計測待ち" : eta(Math.min(finish, etaCap));
  const etaNote = left === 0 ? "目標達成済み" : active.over ? `${active.endLabel}を超過 / 稼働延長が必要` : !Number.isFinite(finish) ? "実績ペース計測待ち" : finish > etaCap ? "上限到達見込み" : "現ペース継続";

  setTone(margin, left);
  setText($("constraintTag"), constraintTag(active));
  setText($("endText"), active.endOn ? `${active.endLabel}上限` : "なし");
  setMarkup($("baselinePaceValue"), paceCardText(targetPace, "targetPace"));
  setAttributeIfChanged($("baselinePace"), "aria-label", `目標ペース ${paceModeLabel("targetPace")}表示。タップで切り替え`);
  setText($("heroDone"), String(done));
  setText($("heroTarget"), `/ ${target}`);
  setText($("heroRemaining"), left ? `残り${left}件` : "目標達成");
  setAttributeIfChanged($("heroProgressTrack"), "aria-valuenow", rate.toFixed(1));
  setAttributeIfChanged($("heroProgressFill"), "style", `width:${rate.toFixed(1)}%`);
  setText($("heroPercent"), `${Math.round(rate)}%`);

  if (left === 0) {
    setText($("mainValue"), "目標達成");
    setText($("subValue"), `${done}件完了`);
    setText($("miniValue"), "お疲れさまです");
  } else {
    setMarkup($("mainValue"), slackMarkup(margin));
    setMarkup($("subValue"), limits(targetPace, margin));
    setText($("miniValue"), active.over ? `残り${left}件 / ${active.endLabel}を超過` : `残り${left}件 / ${active.label}まで${remainingText(effectiveRemain)}`);
  }

  renderTodaySummary(target, done, used, actualPace);
  renderClock(currentRemain);

  const session = typeof window.uberProgressSessionMetrics === "function" ? window.uberProgressSessionMetrics() : null;
  const constraintNote = active.endOn ? (active.kind === "end" ? "終了上限が12時間制限より短い" : `${active.endLabel}上限は補助情報`) : "終了上限なし";
  const values = {
    remaining: { k: "進捗件数", v: `<span class="progressCurrent">${done}</span><span class="progressGoal">/ ${target}件</span>`, p: `<div class="progressTrack" role="progressbar" aria-label="目標達成率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${rate.toFixed(1)}" aria-valuetext="${rate.toFixed(1)}%達成"><span class="progressFill" style="width:${rate.toFixed(1)}%"></span></div>`, n: `<span>残り${left}件</span><span class="progressPercent">${Math.round(rate)}%</span>` },
    need: { k: "必要ペース", v: left ? paceCardText(neededPace, "need") : "達成済み", n: `タップで切替 / ${paceModeLabel("need")} / ${active.label}基準` },
    eta: { k: "終了予測", v: etaText, n: etaNote },
    actualPace: { k: "実績ペース", v: Number.isFinite(actualPace) ? paceCardText(actualPace, "actualPace") : "計測待ち", n: Number.isFinite(projection) ? `現ペースなら${projection.toFixed(1)}件` : "配達完了後に表示" },
    safe: { k: "狙える件数", v: Number.isFinite(safe) ? `${safe}件まで` : "計測待ち", n: "実績ペース基準" },
    targetPace: { k: "目標ペース", v: paceCardText(targetPace, "targetPace"), n: `タップで切替 / ${paceModeLabel("targetPace")} / ${active.label}反映` },
    project12: { k: "上限まで走ると", v: Number.isFinite(projection) ? `${projection.toFixed(1)}件` : "計測待ち", n: `${active.label}基準` },
    constraint: { k: "制約条件", v: active.kind === "end" ? "終了上限基準" : "12時間制限基準", n: constraintNote },
    elapsed: { k: "経過時間", v: session && session.started ? session.elapsedText.replace(/(時間|分)/g, '<span class="timeUnit">$1</span>') : "未開始", n: "休憩を除く" },
    workRate: { k: "稼働率", v: session && session.started ? `${session.rate.toFixed(1)}<span class="paceSuffix">%</span>` : "未開始", n: "休憩を除く経過に対する稼働" }
  };
  applyCardCount();
  drawCards(values);
}

function setup() {
  addOptions($("target"), 1, 80, "件");
  addOptions($("done"), 0, 80, "件");
  addOptions($("remainH"), 0, 12, "時間");
  addOptions($("remainM"), 0, 59, "分", 1, true);
  $("target").value = "46";
  $("done").value = "0";
  $("remainH").value = "12";
  $("remainM").value = "0";

  load();
  loadClock();
  syncCardCountControl();
  renderCardSelectors();
  calc();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && cardDrag) finishCardDrag(false);
  });
  window.addEventListener("storage", event => {
    if (event.key === STORAGE_KEY && event.newValue) {
      load();
      syncCardCountControl();
      renderCardSelectors();
      calc();
      return;
    }
    if (event.key && event.key.startsWith(PACE_MODE_KEY_PREFIX)) calc();
  });
  window.addEventListener("pageshow", () => {
    load();
    syncCardCountControl();
    renderCardSelectors();
  });

  ["target", "done", "remainH", "remainM", "endLimit"].forEach(id => {
    $(id).addEventListener("change", () => {
      if (id === "remainH" || id === "remainM") syncClock();
      save({ countChange: id === "done" });
      calc();
    });
  });
  $("cardCount").onchange = () => selectCardCount($("cardCount").value);
  $("cardCountSegment").onclick = event => {
    const button = event.target.closest("[data-card-count]");
    if (!button || button.disabled) return;
    selectCardCount(button.dataset.cardCount);
  };
  $("baselinePace").onclick = () => togglePaceDisplayMode("targetPace");
  $("settingsOpen").onclick = () => setSettingsOpen(true);
  $("settingsClose").onclick = () => setSettingsOpen(false);
  $("settingsDone").onclick = () => setSettingsOpen(false);
  $("settingsBackdrop").onclick = () => setSettingsOpen(false);
  setupSettingsSwipe();
  document.addEventListener("keydown", handleSettingsKey);
  $("cardOrderToggle").onclick = () => {
    const next = !cardOrderMode;
    setSettingsOpen(false, false);
    setCardOrderMode(next, next);
  };
  $("cardOrderDone").onclick = () => setCardOrderMode(false);
  $("metrics").addEventListener("pointerdown", startCardDrag);
  $("metrics").addEventListener("pointermove", continueCardDrag);
  $("metrics").addEventListener("pointerup", event => {
    if (cardDrag && event.pointerId === cardDrag.pointerId) finishCardDrag(true);
  });
  $("metrics").addEventListener("pointercancel", event => {
    if (cardDrag && event.pointerId === cardDrag.pointerId) finishCardDrag(false);
  });
  $("metrics").addEventListener("lostpointercapture", event => {
    if (cardDrag && event.pointerId === cardDrag.pointerId) finishCardDrag(false);
  });
  $("metrics").addEventListener("click", event => {
    if (cardOrderMode) return;
    const card = event.target.closest(".metric");
    if (card && isPaceToggleCard(card.dataset.cardId)) togglePaceDisplayMode(card.dataset.cardId);
  });
  $("metrics").addEventListener("keydown", event => {
    if (handleCardOrderKey(event) || cardOrderMode) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".metric");
    if (!card || !isPaceToggleCard(card.dataset.cardId)) return;
    event.preventDefault();
    togglePaceDisplayMode(card.dataset.cardId);
  });
  $("clearEnd").onclick = () => {
    $("endLimit").value = "";
    save();
    calc();
  };
  enableHoldRepeat("remainMinus", () => adjustRemain(-1));
  enableHoldRepeat("remainPlus", () => adjustRemain(1));
  enableHoldRepeat("minus", () => adjustDone(-1));
  enableHoldRepeat("plus", () => adjustDone(1));
  $("reset").onclick = () => {
    if (!confirm("完了件数と残り時間をリセットしますか？")) return;
    if (typeof UberQuestStore !== "undefined" && !UberQuestStore.resetCounter()) return;
    $("done").value = "0";
    $("remainH").value = "12";
    $("remainM").value = "0";
    $("endLimit").value = "";
    clockState = { on: false, baseRemain: WORK_LIMIT_MINUTES, baseAt: Date.now() };
    saveClock();
    save();
    calc();
  };
  $("countToggle").onclick = toggleClock;
  $("helpBtn").onclick = () => {
    const help = $("helpText");
    const open = help.hidden;
    help.hidden = !open;
    $("helpBtn").setAttribute("aria-expanded", String(open));
  };
}

setup();
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js?v=73").catch(() => {}));
}
