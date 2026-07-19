(() => {
  "use strict";

  const ENHANCED_CLOCK_KEY = "ubereatsProgressMovementClockV1";
  const HISTORY_KEY = "ubereatsProgressWorkHistoryV1";
  const MOVING_SPEED_MPS = 0.8;
  const STOP_SPEED_MPS = 0.35;
  const MIN_MOVE_DISTANCE_M = 7;
  const MOVEMENT_HOLD_MS = 15000;
  const MAX_LOCATION_ACCURACY_M = 80;
  const SAVE_INTERVAL_MS = 5000;

  const legacyRemain = typeof remain === "function" ? remain() : manualRemain();
  let geoWatchId = null;
  let lastPosition = null;
  let movementEvidenceUntil = 0;
  let lastSavedAt = 0;
  let locationState = "idle";
  let locationMessage = "";

  function nowMs() { return Date.now(); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }

  function defaultEnhancedState() {
    const now = nowMs();
    return {
      on: Boolean(clockState && clockState.on),
      remainingMs: Math.max(0, legacyRemain * 60000),
      baseRemain: Math.max(0, legacyRemain),
      baseAt: now,
      lastTickAt: now,
      moving: false,
      activeMs: 0,
      sessionStartAt: clockState && clockState.on ? now : null,
      breakOn: false,
      breakStartedAt: null,
      breakMs: 0,
      updatedAt: now
    };
  }

  function normalizeState(data) {
    const fallback = defaultEnhancedState();
    const now = nowMs();
    const remainingMs = finite(data && data.remainingMs, fallback.remainingMs);
    return {
      on: Boolean(data && data.on),
      remainingMs: clamp(remainingMs, 0, MAX_REMAIN_INPUT_MINUTES * 60000),
      baseRemain: remainingMs / 60000,
      baseAt: now,
      lastTickAt: now,
      moving: false,
      activeMs: Math.max(0, finite(data && data.activeMs, 0)),
      sessionStartAt: data && data.sessionStartAt ? finite(data.sessionStartAt, now) : null,
      breakOn: Boolean(data && data.breakOn),
      breakStartedAt: data && data.breakOn ? finite(data.breakStartedAt, now) : null,
      breakMs: Math.max(0, finite(data && data.breakMs, 0)),
      updatedAt: now
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
  }

  function serializableState() {
    return {
      on: clockState.on,
      remainingMs: clockState.remainingMs,
      activeMs: clockState.activeMs,
      sessionStartAt: clockState.sessionStartAt,
      breakOn: clockState.breakOn,
      breakStartedAt: clockState.breakStartedAt,
      breakMs: clockState.breakMs,
      updatedAt: nowMs()
    };
  }

  function persistEnhancedClock(force = false) {
    const now = nowMs();
    if (!force && now - lastSavedAt < SAVE_INTERVAL_MS) return;
    lastSavedAt = now;
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.baseAt = now;
    localStorage.setItem(ENHANCED_CLOCK_KEY, JSON.stringify(serializableState()));
    localStorage.setItem(CLOCK_KEY, JSON.stringify({
      on: clockState.on,
      baseRemain: clockState.remainingMs / 60000,
      baseAt: now
    }));
  }

  function tickClock(at = nowMs()) {
    const previous = finite(clockState.lastTickAt, at);
    const delta = Math.max(0, at - previous);
    clockState.lastTickAt = at;
    const movingForDelta = clockState.on && !clockState.breakOn && previous < movementEvidenceUntil;
    if (movingForDelta && delta > 0) {
      const activeDelta = Math.min(delta, Math.max(0, movementEvidenceUntil - previous));
      clockState.remainingMs = Math.max(0, clockState.remainingMs - activeDelta);
      clockState.activeMs += activeDelta;
    }
    clockState.moving = clockState.on && !clockState.breakOn && at < movementEvidenceUntil;
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.baseAt = at;
    if (clockState.remainingMs <= 0 && clockState.on) {
      clockState.on = false;
      clockState.moving = false;
      stopLocationWatch();
      persistEnhancedClock(true);
    } else {
      persistEnhancedClock(false);
    }
  }

  function distanceMeters(a, b) {
    const rad = Math.PI / 180;
    const lat1 = a.latitude * rad;
    const lat2 = b.latitude * rad;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLon = (b.longitude - a.longitude) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function handlePosition(position) {
    const at = finite(position.timestamp, nowMs());
    const coords = position.coords;
    const accuracy = finite(coords.accuracy, 9999);
    if (accuracy > MAX_LOCATION_ACCURACY_M) {
      locationState = "weak";
      locationMessage = `GPS精度待ち（±${Math.round(accuracy)}m）`;
      renderEnhancedClock();
      return;
    }

    let inferredSpeed = 0;
    let distance = 0;
    if (lastPosition) {
      const elapsedSeconds = Math.max((at - lastPosition.at) / 1000, 0.1);
      distance = distanceMeters(lastPosition.coords, coords);
      inferredSpeed = distance / elapsedSeconds;
    }
    const gpsSpeed = Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed : null;
    const speed = gpsSpeed === null ? inferredSpeed : Math.max(gpsSpeed, inferredSpeed);
    const reliableMove = speed >= MOVING_SPEED_MPS || (distance >= MIN_MOVE_DISTANCE_M && inferredSpeed >= MOVING_SPEED_MPS);
    const reliableStop = speed <= STOP_SPEED_MPS && distance < MIN_MOVE_DISTANCE_M;

    tickClock(at);
    if (reliableMove) movementEvidenceUntil = at + MOVEMENT_HOLD_MS;
    else if (reliableStop && at >= movementEvidenceUntil) movementEvidenceUntil = 0;

    lastPosition = { coords: { latitude: coords.latitude, longitude: coords.longitude }, at };
    locationState = reliableMove || at < movementEvidenceUntil ? "moving" : "stationary";
    locationMessage = gpsSpeed === null ? "位置変化から判定" : `速度 ${Math.max(0, gpsSpeed * 3.6).toFixed(1)}km/h`;
    tickClock(nowMs());
    renderEnhancedClock();
  }

  function handleLocationError(error) {
    locationState = error && error.code === 1 ? "denied" : "error";
    locationMessage = error && error.code === 1 ? "位置情報が許可されていません" : "位置情報を取得できません";
    movementEvidenceUntil = 0;
    clockState.moving = false;
    renderEnhancedClock();
  }

  function startLocationWatch() {
    if (!clockState.on || clockState.breakOn || geoWatchId !== null) return;
    if (!("geolocation" in navigator)) {
      locationState = "unsupported";
      locationMessage = "この端末では位置情報を利用できません";
      renderEnhancedClock();
      return;
    }
    locationState = "requesting";
    locationMessage = "位置情報を確認中";
    geoWatchId = navigator.geolocation.watchPosition(handlePosition, handleLocationError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000
    });
  }

  function stopLocationWatch() {
    if (geoWatchId !== null && "geolocation" in navigator) navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
    lastPosition = null;
    movementEvidenceUntil = 0;
    clockState.moving = false;
    if (!clockState.on) {
      locationState = "idle";
      locationMessage = "";
    }
  }

  function exactRemainText(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}時間${String(minutes).padStart(2, "0")}分${String(secs).padStart(2, "0")}秒`;
  }

  function durationText(ms, includeSeconds = false) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (includeSeconds) return `${hours}時間${String(minutes).padStart(2, "0")}分${String(seconds).padStart(2, "0")}秒`;
    return `${hours}時間${String(minutes).padStart(2, "0")}分`;
  }

  function sessionBreakMs(at = nowMs()) {
    return clockState.breakMs + (clockState.breakOn && clockState.breakStartedAt ? Math.max(0, at - clockState.breakStartedAt) : 0);
  }

  function sessionElapsedMs(at = nowMs()) {
    if (!clockState.sessionStartAt) return 0;
    return Math.max(0, at - clockState.sessionStartAt - sessionBreakMs(at));
  }

  function operationRate(at = nowMs()) {
    const elapsed = sessionElapsedMs(at);
    return elapsed > 0 ? clamp(clockState.activeMs / elapsed * 100, 0, 100) : 0;
  }

  function currentStatus() {
    if (!clockState.on) return { text: "停止中", sub: "開始する", mode: "off" };
    if (clockState.breakOn) return { text: "休憩中", sub: "休憩中", mode: "break" };
    if (clockState.moving) return { text: "移動中・カウント中", sub: "移動中", mode: "moving" };
    if (["requesting", "weak"].includes(locationState)) return { text: "位置確認中", sub: "GPS確認中", mode: "waiting" };
    if (["denied", "error", "unsupported"].includes(locationState)) return { text: "位置情報待ち", sub: "位置情報が必要", mode: "error" };
    return { text: "停車中・自動停止", sub: "停車で停止", mode: "stationary" };
  }

  function renderEnhancedClock() {
    tickClock();
    const status = currentStatus();
    const button = $("countToggle");
    const sub = $("countSub");
    const dot = $("countDot");
    const panel = $("countPanel");
    $("countRemain").textContent = `残り ${exactRemainText(clockState.remainingMs)}`;
    $("countStatus").textContent = status.text;
    $("countEndClock").textContent = clockState.on ? "移動時間に連動" : "停止中";
    $("countEndClock").classList.toggle("run", clockState.on && clockState.moving);
    button.classList.toggle("off", clockState.on);
    button.firstChild.nodeValue = clockState.on ? "時間OFF" : "時間ON";
    sub.textContent = clockState.on ? status.sub : "開始する";
    dot.classList.toggle("stop", !clockState.on || !clockState.moving);
    panel.classList.toggle("run", clockState.on && clockState.moving);
    const detail = $("movementDetail");
    if (detail) detail.textContent = locationMessage || (clockState.on ? "移動を検知すると自動でカウントします" : "OFF中は移動しても反応しません");
    renderSessionPanel();
  }

  function enhancedToggleClock() {
    tickClock();
    clockState.on = !clockState.on;
    clockState.lastTickAt = nowMs();
    if (clockState.on) {
      if (!clockState.sessionStartAt) clockState.sessionStartAt = nowMs();
      startLocationWatch();
    } else {
      stopLocationWatch();
    }
    persistEnhancedClock(true);
    calc();
    renderEnhancedClock();
  }

  function setExactRemaining(minutes) {
    tickClock();
    clockState.remainingMs = clamp(minutes * 60000, 0, MAX_REMAIN_INPUT_MINUTES * 60000);
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.lastTickAt = nowMs();
    persistEnhancedClock(true);
  }

  function toggleBreak() {
    tickClock();
    const now = nowMs();
    if (clockState.breakOn) {
      clockState.breakMs += Math.max(0, now - finite(clockState.breakStartedAt, now));
      clockState.breakStartedAt = null;
      clockState.breakOn = false;
      if (clockState.on) startLocationWatch();
    } else {
      clockState.breakOn = true;
      clockState.breakStartedAt = now;
      stopLocationWatch();
    }
    clockState.lastTickAt = now;
    persistEnhancedClock(true);
    renderEnhancedClock();
  }

  function history() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  function recordSession(showMessage = true) {
    tickClock();
    if (!clockState.sessionStartAt) {
      if (showMessage) alert("開始時刻がまだありません。時間ONで計測を開始してください。");
      return false;
    }
    const at = nowMs();
    const item = {
      id: `${at}-${Math.random().toString(36).slice(2, 7)}`,
      date: new Date(clockState.sessionStartAt).toISOString(),
      startedAt: clockState.sessionStartAt,
      recordedAt: at,
      target: n("target"),
      done: n("done"),
      activeMs: clockState.activeMs,
      elapsedMs: sessionElapsedMs(at),
      breakMs: sessionBreakMs(at),
      rate: operationRate(at)
    };
    const items = history();
    items.unshift(item);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 30)));
    renderHistory();
    if (showMessage) alert("今日の稼働記録を保存しました。");
    return true;
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return "未開始";
    return new Date(timestamp).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function renderHistory() {
    const box = $("workHistoryList");
    if (!box) return;
    const items = history().slice(0, 5);
    box.innerHTML = items.length ? items.map(item => `
      <div class="workHistoryItem">
        <div><strong>${formatDateTime(item.startedAt)}</strong><small>${finite(item.done)}件 / 実稼働率 ${finite(item.rate).toFixed(1)}%</small></div>
        <span>${durationText(finite(item.activeMs))}</span>
      </div>`).join("") : '<div class="workHistoryEmpty">保存した記録はまだありません</div>';
  }

  function renderSessionPanel() {
    const panel = $("workSessionPanel");
    if (!panel) return;
    const at = nowMs();
    $("workStartTime").textContent = clockState.sessionStartAt ? formatDateTime(clockState.sessionStartAt) : "未開始";
    $("workActiveTime").textContent = durationText(clockState.activeMs, true);
    $("workElapsedTime").textContent = durationText(sessionElapsedMs(at), true);
    $("workRate").textContent = `${operationRate(at).toFixed(1)}%`;
    $("workBreakTime").textContent = durationText(sessionBreakMs(at));
    $("breakToggle").textContent = clockState.breakOn ? "休憩終了" : "休憩開始";
    $("breakToggle").classList.toggle("active", clockState.breakOn);
  }

  function injectUi() {
    const style = document.createElement("style");
    style.textContent = `
      .movementDetail{margin-top:8px;color:#8fa6ba;font-size:11px;line-height:1.45;text-align:center}
      .workSessionPanel{margin:12px 0;padding:16px;border:1px solid #28506c;border-radius:24px;background:linear-gradient(155deg,rgba(9,29,43,.96),rgba(4,18,30,.94));box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 10px 26px rgba(0,0,0,.17)}
      .workSessionHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.workSessionTitle{margin:0;font-size:18px}.workSessionStart{color:#8fa6ba;font-size:11px;text-align:right}.workSessionStart strong{display:block;margin-top:2px;color:#e7f2fb;font-size:13px}
      .workSessionGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:13px}.workSessionStat{padding:11px;border:1px solid rgba(59,91,116,.5);border-radius:16px;background:rgba(3,18,27,.58)}.workSessionStat span{display:block;color:#8fa6ba;font-size:9.5px;font-weight:750}.workSessionStat strong{display:block;margin-top:4px;font-size:17px;white-space:nowrap}.workSessionStat.primary{border-color:rgba(52,230,123,.36);background:rgba(18,76,52,.18)}.workSessionStat.primary strong{color:#68ef9b}
      .workSessionActions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:11px}.workSessionActions button{min-height:46px;padding:10px;border:1px solid #365b75;border-radius:15px;background:linear-gradient(180deg,#143047,#0a2134);font-size:13px}.workSessionActions .breakToggle.active{border-color:#ff9b42;background:rgba(116,57,16,.36);color:#ffc38b}.workSessionActions .recordWork{border-color:#2f8bff;background:linear-gradient(180deg,#1769c4,#0a4b9e)}
      .workHistory{margin-top:13px;padding-top:12px;border-top:1px solid rgba(69,99,122,.38)}.workHistoryTitle{margin:0 0 7px;color:#b9c9d7;font-size:11px}.workHistoryItem{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid rgba(59,91,116,.28)}.workHistoryItem:first-child{border-top:0}.workHistoryItem strong,.workHistoryItem small{display:block}.workHistoryItem strong{font-size:12px}.workHistoryItem small{margin-top:2px;color:#8096aa;font-size:9.5px}.workHistoryItem>span{color:#68ef9b;font-size:11px;font-weight:850;white-space:nowrap}.workHistoryEmpty{color:#71869a;font-size:10px}
      @media(max-width:390px){.workSessionPanel{padding:13px}.workSessionStat strong{font-size:15px}.workSessionActions{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);

    const detail = document.createElement("div");
    detail.id = "movementDetail";
    detail.className = "movementDetail";
    $("countPanel").appendChild(detail);

    const panel = document.createElement("section");
    panel.id = "workSessionPanel";
    panel.className = "workSessionPanel";
    panel.innerHTML = `
      <div class="workSessionHead"><div><h2 class="workSessionTitle">稼働計測</h2><div class="movementDetail">休憩時間を除いて実稼働率を計算</div></div><div class="workSessionStart">開始時刻<strong id="workStartTime">未開始</strong></div></div>
      <div class="workSessionGrid">
        <div class="workSessionStat primary"><span>時計が減った時間</span><strong id="workActiveTime">0時間00分00秒</strong></div>
        <div class="workSessionStat"><span>実稼働率</span><strong id="workRate">0.0%</strong></div>
        <div class="workSessionStat"><span>経過時間（休憩除外）</span><strong id="workElapsedTime">0時間00分00秒</strong></div>
        <div class="workSessionStat"><span>休憩時間</span><strong id="workBreakTime">0時間00分</strong></div>
      </div>
      <div class="workSessionActions"><button id="breakToggle" class="breakToggle" type="button">休憩開始</button><button id="recordWork" class="recordWork" type="button">記録する</button></div>
      <div class="workHistory"><h3 class="workHistoryTitle">最近の記録</h3><div id="workHistoryList"></div></div>`;
    $("todaySummary").before(panel);
    $("breakToggle").onclick = toggleBreak;
    $("recordWork").onclick = () => recordSession(true);

    const desc = $("countPanel").querySelector(".desc");
    const hint = $("countPanel").querySelector(".hint");
    if (desc) desc.textContent = "ON中は移動を検知した時だけ秒単位で減少し、停車すると自動停止します。";
    if (hint) hint.textContent = "OFF中は移動しても反応しません。位置情報は移動判定だけに使い、座標は保存しません。";
    $("helpText").textContent = "時間ONで位置情報を使った移動判定を開始します。移動中だけ残り時間が秒単位で減り、停車中は自動停止します。時間OFF中と休憩中は移動しても減りません。GPSの性質上、屋内・高層建物周辺・バックグラウンドでは判定が遅れる場合があります。";
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
    clockState.on = false;
    stopLocationWatch();
    persistEnhancedClock(true);
    save();
  };
  toggleClock = enhancedToggleClock;
  renderClock = function() { renderEnhancedClock(); };
  countEndLabel = function() { return clockState.on ? "移動時間に連動" : "停止中"; };

  injectUi();
  $("countToggle").onclick = enhancedToggleClock;

  const originalAdjustRemain = adjustRemain;
  adjustRemain = function(delta) {
    tickClock();
    const roundedMinutes = Math.round(clockState.remainingMs / 60000);
    setExactRemaining(clamp(roundedMinutes + delta, 0, MAX_REMAIN_INPUT_MINUTES));
    setRemain(clockState.remainingMs / 60000);
    save();
    calc();
    renderEnhancedClock();
  };

  const originalReset = $("reset").onclick;
  $("reset").onclick = function() {
    const hadSession = Boolean(clockState.sessionStartAt && (clockState.activeMs > 0 || n("done") > 0));
    if (hadSession && confirm("リセット前に今日の稼働記録を保存しますか？")) recordSession(false);
    const before = n("done");
    originalReset.call(this);
    if (before === n("done") && before !== 0) return;
    clockState = {
      on: false,
      remainingMs: 720 * 60000,
      baseRemain: 720,
      baseAt: nowMs(),
      lastTickAt: nowMs(),
      moving: false,
      activeMs: 0,
      sessionStartAt: null,
      breakOn: false,
      breakStartedAt: null,
      breakMs: 0,
      updatedAt: nowMs()
    };
    stopLocationWatch();
    persistEnhancedClock(true);
    renderEnhancedClock();
  };

  if (clockState.on && !clockState.breakOn) startLocationWatch();
  renderHistory();
  calc();
  renderEnhancedClock();

  setInterval(() => {
    tickClock();
    calc();
    renderEnhancedClock();
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    tickClock();
    if (!document.hidden && clockState.on && !clockState.breakOn) startLocationWatch();
    renderEnhancedClock();
  });
  window.addEventListener("pagehide", () => persistEnhancedClock(true));
})();
