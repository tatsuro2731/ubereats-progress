(() => {
  "use strict";

  const ENHANCED_CLOCK_KEY = "ubereatsProgressMovementClockV1";
  const HISTORY_KEY = "ubereatsProgressWorkHistoryV1";
  const COUNT_MODE = "continuous-v1";
  const WORK_LIMIT_MS = 720 * 60000;
  const SAVE_INTERVAL_MS = 5000;

  const legacyRemain = typeof remain === "function" ? remain() : manualRemain();
  let lastSavedAt = 0;
  let pendingConfirmAction = null;
  let confirmReturnFocus = null;
  let finalizingSession = false;

  function nowMs() { return Date.now(); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }

  function defaultEnhancedState() {
    const now = nowMs();
    return {
      countMode: COUNT_MODE,
      on: Boolean(clockState && clockState.on),
      remainingMs: Math.max(0, legacyRemain * 60000),
      baseRemain: Math.max(0, legacyRemain),
      baseAt: now,
      lastTickAt: now,
      moving: false,
      activeMs: 0,
      sessionStartAt: clockState && clockState.on ? now : null,
      sessionEndedAt: null,
      breakOn: false,
      breakStartedAt: null,
      breakMs: 0,
      breakSegments: [],
      legacyBreakMs: 0,
      backgroundGap: null,
      lastBackfillMs: 0,
      lastBackfillAt: null,
      updatedAt: now
    };
  }

  function normalizeBreakSegments(value, breakOn, breakStartedAt, now) {
    if (!Array.isArray(value)) return [];
    const segments = value.map(segment => {
      const startAt = finite(segment && segment.startAt, NaN);
      const rawEnd = segment && segment.endAt;
      const endAt = rawEnd === null || rawEnd === undefined ? null : finite(rawEnd, NaN);
      if (!Number.isFinite(startAt) || startAt <= 0) return null;
      if (endAt !== null && (!Number.isFinite(endAt) || endAt < startAt)) return null;
      return { startAt, endAt };
    }).filter(Boolean).sort((a, b) => a.startAt - b.startAt).slice(-200);

    let keptOpen = false;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (segments[index].endAt !== null) continue;
      if (breakOn && !keptOpen) keptOpen = true;
      else segments[index].endAt = now;
    }
    if (breakOn && !keptOpen) {
      segments.push({ startAt: finite(breakStartedAt, now), endAt: null });
    }
    return segments;
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
    const breakOn = !sessionEndedAt && Boolean(data && data.breakOn);
    const breakStartedAt = breakOn ? finite(data && data.breakStartedAt, stateAt) : null;
    const hasBreakSegments = Boolean(data && Array.isArray(data.breakSegments));
    const isContinuousState = Boolean(data && data.countMode === COUNT_MODE);
    const rawUpdatedAt = finite(data && data.updatedAt, now);
    const resumeAt = isContinuousState && rawUpdatedAt > 0 ? rawUpdatedAt : now;
    return {
      countMode: COUNT_MODE,
      on: !sessionEndedAt && Boolean(data && data.on),
      remainingMs: clamp(remainingMs, 0, MAX_REMAIN_INPUT_MINUTES * 60000),
      baseRemain: remainingMs / 60000,
      baseAt: now,
      lastTickAt: resumeAt,
      moving: false,
      activeMs: Math.max(0, finite(data && data.activeMs, 0)),
      sessionStartAt,
      sessionEndedAt,
      breakOn,
      breakStartedAt,
      breakMs: Math.max(0, finite(data && data.breakMs, 0)),
      breakSegments: normalizeBreakSegments(data && data.breakSegments, breakOn, breakStartedAt, stateAt),
      legacyBreakMs: hasBreakSegments ? Math.max(0, finite(data && data.legacyBreakMs, 0)) : Math.max(0, finite(data && data.breakMs, 0)),
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
    return {
      countMode: COUNT_MODE,
      on: clockState.on,
      remainingMs: clockState.remainingMs,
      activeMs: clockState.activeMs,
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
      backgroundGap: null,
      lastBackfillMs: 0,
      lastBackfillAt: null,
      updatedAt: Math.max(0, finite(clockState.updatedAt, nowMs()))
    };
  }

  function persistEnhancedClock(force = false) {
    const now = nowMs();
    if (!force && now - lastSavedAt < SAVE_INTERVAL_MS) return;
    lastSavedAt = now;
    const anchorAt = Math.max(now, finite(clockState.lastTickAt, now));
    clockState.countMode = COUNT_MODE;
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.baseAt = anchorAt;
    clockState.updatedAt = anchorAt;
    localStorage.setItem(ENHANCED_CLOCK_KEY, JSON.stringify(serializableState()));
    localStorage.setItem(CLOCK_KEY, JSON.stringify({
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
    if (counting && delta > 0) {
      const consumed = Math.min(delta, Math.max(0, clockState.remainingMs));
      clockState.remainingMs -= consumed;
      clockState.activeMs += consumed;
    }
    clockState.moving = false;
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.baseAt = effectiveAt;
    if (clockState.remainingMs <= 0 && clockState.on) {
      clockState.on = false;
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
    const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}時間${String(minutes).padStart(2, "0")}分`;
  }

  function durationText(ms) {
    const totalMinutes = Math.max(0, Math.floor(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}時間${String(minutes).padStart(2, "0")}分`;
  }

  function sessionMetricAt(at = nowMs()) {
    const requestedAt = finite(at, nowMs());
    const endedAt = clockState.sessionEndedAt ? finite(clockState.sessionEndedAt, NaN) : NaN;
    return Number.isFinite(endedAt) ? Math.min(requestedAt, endedAt) : requestedAt;
  }

  function sessionBreakMs(at = nowMs()) {
    at = sessionMetricAt(at);
    const sessionStart = clockState.sessionStartAt ? finite(clockState.sessionStartAt, at) : at;
    const intervals = (Array.isArray(clockState.breakSegments) ? clockState.breakSegments : []).map(segment => {
      const startAt = Math.max(sessionStart, finite(segment && segment.startAt, at));
      const rawEnd = segment && segment.endAt;
      const endAt = Math.min(at, rawEnd === null || rawEnd === undefined ? at : finite(rawEnd, at));
      return endAt > startAt ? [startAt, endAt] : null;
    }).filter(Boolean).sort((a, b) => a[0] - b[0]);
    let segmentMs = 0;
    let rangeStart = null;
    let rangeEnd = null;
    intervals.forEach(([startAt, endAt]) => {
      if (rangeStart === null) {
        rangeStart = startAt;
        rangeEnd = endAt;
      } else if (startAt <= rangeEnd) {
        rangeEnd = Math.max(rangeEnd, endAt);
      } else {
        segmentMs += rangeEnd - rangeStart;
        rangeStart = startAt;
        rangeEnd = endAt;
      }
    });
    if (rangeStart !== null) segmentMs += rangeEnd - rangeStart;
    return Math.max(0, finite(clockState.legacyBreakMs, 0)) + segmentMs;
  }

  function sessionElapsedMs(at = nowMs()) {
    if (!clockState.sessionStartAt) return 0;
    at = sessionMetricAt(at);
    return Math.max(0, at - clockState.sessionStartAt - sessionBreakMs(at));
  }

  function operationRate(at = nowMs()) {
    const elapsed = sessionElapsedMs(at);
    return elapsed > 0 ? clamp(clockState.activeMs / elapsed * 100, 0, 100) : 0;
  }

  function currentStatus() {
    if (clockState.sessionEndedAt) return { text: "稼働終了", sub: "履歴に保存済み", mode: "ended" };
    if (!clockState.on) return { text: "停止中", sub: "開始する", mode: "off" };
    if (clockState.breakOn) return { text: "休憩中", sub: "休憩中", mode: "break" };
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
    $("countStatus").textContent = status.text;
    $("countEndClock").textContent = exhaustionText();
    $("countEndClock").classList.toggle("run", counting);
    button.classList.toggle("off", clockState.on);
    button.firstChild.nodeValue = ended ? "稼働終了済み" : clockState.on ? "時間OFF" : "時間ON";
    sub.textContent = ended ? "履歴に保存済み" : clockState.on ? status.sub : "開始する";
    button.disabled = ended;
    button.setAttribute("aria-disabled", String(ended));
    dot.classList.toggle("stop", !counting);
    panel.classList.toggle("run", counting);
    const detail = $("movementDetail");
    if (detail) detail.textContent = ended
      ? "稼働終了・履歴に保存済み"
      : clockState.breakOn
        ? "休憩中は残り時間を止めています"
        : clockState.on
          ? "移動・停車にかかわらず連続でカウントします"
          : "時間OFF中は残り時間を止めています";
    renderSessionPanel();
  }

  function enhancedToggleClock() {
    if (clockState.sessionEndedAt) return;
    tickClock();
    clockState.on = !clockState.on;
    clockState.lastTickAt = Math.max(finite(clockState.lastTickAt, 0), nowMs());
    if (clockState.on) {
      if (!clockState.sessionStartAt) clockState.sessionStartAt = nowMs();
    }
    clockState.backgroundGap = null;
    persistEnhancedClock(true);
    calc();
    renderEnhancedClock();
  }

  function setExactRemainingMs(milliseconds) {
    tickClock();
    clockState.remainingMs = clamp(milliseconds, 0, MAX_REMAIN_INPUT_MINUTES * 60000);
    clockState.baseRemain = clockState.remainingMs / 60000;
    clockState.lastTickAt = Math.max(finite(clockState.lastTickAt, 0), nowMs());
    persistEnhancedClock(true);
  }

  function setExactRemaining(minutes) {
    setExactRemainingMs(minutes * 60000);
  }

  function toggleBreak() {
    if (clockState.sessionEndedAt) return;
    if (!clockState.sessionStartAt) {
      alert("時間ONで計測を開始してから休憩を記録してください。");
      return;
    }
    tickClock();
    const now = nowMs();
    if (!Array.isArray(clockState.breakSegments)) clockState.breakSegments = [];
    if (clockState.breakOn) {
      const startedAt = finite(clockState.breakStartedAt, now);
      const openSegment = [...clockState.breakSegments].reverse().find(segment => segment.endAt === null);
      if (openSegment) openSegment.endAt = now;
      else clockState.breakSegments.push({ startAt: startedAt, endAt: now });
      clockState.breakMs += Math.max(0, now - startedAt);
      clockState.breakStartedAt = null;
      clockState.breakOn = false;
    } else {
      clockState.breakOn = true;
      clockState.breakStartedAt = now;
      clockState.breakSegments.push({ startAt: now, endAt: null });
      clockState.backgroundGap = null;
    }
    clockState.lastTickAt = Math.max(finite(clockState.lastTickAt, 0), now);
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
    const target = Math.max(1, finite(n("target"), 1));
    const done = Math.max(0, finite(n("done"), 0));
    const remainingMs = Math.max(0, finite(clockState.remainingMs, 0));
    const usedMs = Math.max(0, WORK_LIMIT_MS - remainingMs);
    const actualPaceMinutes = done > 0 && usedMs > 0 ? usedMs / 60000 / done : null;
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
      activeMs: Math.max(0, finite(clockState.activeMs, 0)),
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

  function historyPace(item) {
    const stored = finite(item && item.actualPaceMinutes, NaN);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const done = Math.max(0, finite(item && item.done, 0));
    if (!done) return NaN;
    const usedMs = finite(item && item.usedMs, NaN);
    if (Number.isFinite(usedMs) && usedMs > 0) return usedMs / 60000 / done;
    const activeMs = finite(item && item.activeMs, NaN);
    return Number.isFinite(activeMs) && activeMs > 0 ? activeMs / 60000 / done : NaN;
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
    openWorkConfirm({
      title: "稼働を終了しますか？",
      description: "現在の件数と稼働指標を履歴に保存し、時間計測を停止します。目標未達でも記録されます。",
      rows: [
        { label: "完了件数", value: `${Math.max(0, n("done"))} / ${Math.max(1, n("target"))}件` },
        { label: "時計が減った時間", value: durationText(clockState.activeMs) },
        { label: "経過時間（休憩除外）", value: durationText(sessionElapsedMs(at)) },
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
        { label: "時計が減った時間", value: durationText(finite(item.activeMs, 0)) }
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
    const items = history().slice(0, 5);
    box.innerHTML = items.length ? items.map((item, index) => {
      const done = Math.max(0, finite(item.done, 0));
      const target = Math.max(0, finite(item.target, 0));
      const progress = target ? `${Math.round(clamp(done / target * 100, 0, 999))}%達成` : "目標記録なし";
      const pace = historyPace(item);
      const endedAt = item.endedAt || item.recordedAt;
      return `
        <div class="workHistoryItem" role="listitem">
          <div class="workHistoryMain"><strong>${formatDateTime(item.startedAt || item.date)}〜${formatTime(endedAt)}</strong><small>${target ? `${done} / ${target}件` : `${done}件`} · ${progress}</small><div class="workHistoryMeta">経過 ${durationText(finite(item.elapsedMs, 0))} · 休憩 ${durationText(finite(item.breakMs, 0))}<br>実稼働率 ${finite(item.rate, 0).toFixed(1)}% · 平均 ${Number.isFinite(pace) ? `${pace.toFixed(2)}分/件` : "計測なし"}</div></div>
          <div class="workHistoryDuration"><span>時計が減った時間</span><strong>${durationText(finite(item.activeMs, 0))}</strong></div>
          <button class="workHistoryDelete" type="button" data-history-index="${index}" aria-label="${formatDateTime(item.startedAt || item.date)}開始の履歴を削除">削除</button>
        </div>`;
    }).join("") : '<div class="workHistoryEmpty">保存した履歴はまだありません</div>';
  }

  function renderSessionPanel() {
    const panel = $("workSessionPanel");
    if (!panel) return;
    const at = nowMs();
    const ended = Boolean(clockState.sessionEndedAt);
    $("workStartTime").textContent = clockState.sessionStartAt ? formatDateTime(clockState.sessionStartAt) : "未開始";
    $("workActiveTime").textContent = durationText(clockState.activeMs);
    $("workElapsedTime").textContent = durationText(sessionElapsedMs(at));
    $("workRate").textContent = `${operationRate(at).toFixed(1)}%`;
    $("workBreakTime").textContent = durationText(sessionBreakMs(at));
    $("breakToggle").textContent = clockState.breakOn ? "休憩終了" : "休憩開始";
    $("breakToggle").classList.toggle("active", clockState.breakOn);
    $("breakToggle").disabled = !clockState.sessionStartAt || ended;
    $("breakToggle").setAttribute("aria-disabled", String(!clockState.sessionStartAt || ended));
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
  }

  function injectUi() {
    const style = document.createElement("style");
    style.textContent = `
      .movementDetail{margin-top:8px;color:#8fa6ba;font-size:11px;line-height:1.45;text-align:center}
      .workSessionPanel{margin:12px 0;padding:16px;border:1px solid #28506c;border-radius:24px;background:linear-gradient(155deg,rgba(9,29,43,.96),rgba(4,18,30,.94));box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 10px 26px rgba(0,0,0,.17)}
      .workSessionHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.workSessionTitle{margin:0;font-size:18px}.workSessionStart{color:#8fa6ba;font-size:11px;text-align:right}.workSessionStart strong{display:block;margin-top:2px;color:#e7f2fb;font-size:13px}
      .workSessionGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:13px}.workSessionStat{padding:11px;border:1px solid rgba(59,91,116,.5);border-radius:16px;background:rgba(3,18,27,.58)}.workSessionStat span{display:block;color:#8fa6ba;font-size:9.5px;font-weight:750}.workSessionStat strong{display:block;margin-top:4px;font-size:17px;white-space:nowrap}.workSessionStat.primary{border-color:rgba(52,230,123,.36);background:rgba(18,76,52,.18)}.workSessionStat.primary strong{color:#68ef9b}
      .workSessionActions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:11px}.workSessionActions button{min-height:48px;padding:10px;border:1px solid #365b75;border-radius:15px;background:linear-gradient(180deg,#143047,#0a2134);font-size:13px}.workSessionActions .breakToggle.active{border-color:#ff9b42;background:rgba(116,57,16,.36);color:#ffc38b}.workSessionActions .finishWork{border-color:rgba(255,102,114,.68);background:linear-gradient(180deg,#b73545,#7f1f30);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 7px 18px rgba(103,19,33,.22)}
      .workSessionActions button:disabled,.toggleBtn:disabled,.editStartTime:disabled{opacity:.46;filter:none;cursor:default;transform:none;box-shadow:none}.workSessionNotice{margin-top:9px;padding:9px 11px;border:1px solid rgba(52,230,123,.32);border-radius:13px;background:rgba(24,92,59,.16);color:#86edaa;font-size:10px;line-height:1.45}.workSessionNotice[hidden]{display:none}
      .workHistory{margin-top:13px;padding-top:12px;border-top:1px solid rgba(69,99,122,.38)}.workHistoryTitle{margin:0 0 8px;color:#b9c9d7;font-size:11px}.workHistoryItem{display:grid;grid-template-columns:minmax(0,1fr) auto 44px;align-items:center;gap:9px;margin-top:7px;padding:10px;border:1px solid rgba(59,91,116,.34);border-radius:15px;background:rgba(3,18,27,.44)}.workHistoryItem:first-child{margin-top:0}.workHistoryMain{min-width:0}.workHistoryMain strong,.workHistoryMain small{display:block}.workHistoryMain strong{overflow:hidden;color:#e7f0f7;font-size:11.5px;text-overflow:ellipsis;white-space:nowrap}.workHistoryMain small{margin-top:2px;color:#91a5b7;font-size:9.5px}.workHistoryMeta{margin-top:5px;color:#718ba1;font-size:8.8px;line-height:1.45}.workHistoryDuration{text-align:right;white-space:nowrap}.workHistoryDuration span,.workHistoryDuration strong{display:block}.workHistoryDuration span{color:#7890a5;font-size:8px}.workHistoryDuration strong{margin-top:3px;color:#68ef9b;font-size:11px}.workHistoryDelete{display:grid;width:44px;height:44px;padding:0;place-items:center;border:1px solid rgba(255,102,114,.42);border-radius:13px;background:rgba(105,26,39,.18);color:#ff9ba3;font-size:10px}.workHistoryDelete:focus-visible{outline:2px solid #ff7d89;outline-offset:2px}.workHistoryEmpty{padding:10px 0;color:#71869a;font-size:10px}
      .workConfirmLayer{position:fixed;z-index:120;inset:0;display:grid;place-items:center;padding:max(12px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom))}.workConfirmLayer[hidden]{display:none}.workConfirmBackdrop{position:absolute;inset:0;background:rgba(0,5,12,.80);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}.workConfirmDialog{position:relative;width:min(100%,430px);max-height:min(88dvh,560px);padding:18px;overflow:auto;border:1px solid #3b5368;border-radius:24px;background:radial-gradient(circle at 50% -10%,rgba(255,102,114,.10),transparent 38%),linear-gradient(160deg,#0b2536,#04131f);box-shadow:0 26px 72px rgba(0,0,0,.62),inset 0 1px 0 rgba(255,255,255,.06);outline:none;-webkit-overflow-scrolling:touch}.workConfirmDialog h3{margin:0;color:#f7f9fc;font-size:20px;letter-spacing:-.025em}.workConfirmDialog p{margin:6px 0 14px;color:#93a8ba;font-size:11px;line-height:1.55}.workConfirmSummary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.workConfirmSummary>div{min-width:0;padding:10px;border:1px solid rgba(72,105,130,.42);border-radius:14px;background:rgba(3,18,28,.64)}.workConfirmSummary span,.workConfirmSummary strong{display:block}.workConfirmSummary span{color:#849aac;font-size:9px}.workConfirmSummary strong{overflow:hidden;margin-top:3px;color:#eef4f8;font-size:14px;text-overflow:ellipsis;white-space:nowrap}.workConfirmActions{display:grid;grid-template-columns:1fr 1.2fr;gap:9px;margin-top:15px}.workConfirmActions button{min-height:50px;padding:11px;border:1px solid #365b75;border-radius:15px;background:linear-gradient(180deg,#143047,#0a2134);font-size:13px}.workConfirmActions .workConfirmSubmit{border-color:rgba(255,102,114,.72);background:linear-gradient(180deg,#c13b4c,#851f31)}.workConfirmActions .workConfirmSubmit.delete{background:linear-gradient(180deg,#a52c3b,#701925)}.workConfirmActions button:disabled{opacity:.5}.workConfirmOpen{overflow:hidden}
      @media(max-width:390px){.workSessionPanel{padding:13px}.workSessionStat strong{font-size:15px}.workSessionActions{grid-template-columns:1fr}.workHistoryItem{grid-template-columns:minmax(0,1fr) 44px}.workHistoryDuration{grid-column:1;grid-row:2;display:flex;align-items:center;gap:5px;text-align:left}.workHistoryDuration strong{margin-top:0}.workHistoryDelete{grid-column:2;grid-row:1/3}.workConfirmDialog{padding:15px}.workConfirmSummary strong{font-size:13px}}
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
      <div class="workSessionHead"><div><h2 class="workSessionTitle">稼働計測</h2><div class="movementDetail">休憩時間を除いて実稼働率を計算</div></div><div class="workSessionStart">開始時刻<strong id="workStartTime">未開始</strong></div></div>
      <div class="workSessionGrid">
        <div class="workSessionStat primary"><span>時計が減った時間</span><strong id="workActiveTime">0時間00分</strong></div>
        <div class="workSessionStat"><span>実稼働率</span><strong id="workRate">0.0%</strong></div>
        <div class="workSessionStat"><span>経過時間（休憩除外）</span><strong id="workElapsedTime">0時間00分</strong></div>
        <div class="workSessionStat"><span>休憩時間</span><strong id="workBreakTime">0時間00分</strong></div>
      </div>
      <div class="workSessionActions"><button id="breakToggle" class="breakToggle" type="button">休憩開始</button><button id="finishWork" class="finishWork" type="button">稼働終了</button></div>
      <div id="workSessionNotice" class="workSessionNotice" role="status" aria-live="polite" hidden></div>
      <div class="workHistory"><h3 id="workHistoryTitle" class="workHistoryTitle" tabindex="-1">最近の履歴</h3><div id="workHistoryList" role="list"></div></div>`;
    $("todaySummary").before(panel);
    $("breakToggle").onclick = toggleBreak;
    $("finishWork").onclick = event => requestSessionFinish(event.currentTarget);
    $("workHistoryList").onclick = event => {
      const button = event.target.closest(".workHistoryDelete");
      if (!button) return;
      requestHistoryDelete(Number(button.dataset.historyIndex), button);
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

    const desc = $("countPanel").querySelector(".desc");
    const hint = $("countPanel").querySelector(".hint");
    if (desc) desc.textContent = "時間ON中は移動・停車にかかわらず連続で減少します。内部では秒単位で計算し、画面には分単位で表示します。";
    if (hint) hint.textContent = "Uber側の残り時間が止まっている時は時間OFFにしてください。−／＋で1分ずつ補正できます。";
    $("helpText").textContent = "時間ON中は残り稼働時間を連続で減らし、時間OFF中と休憩中は止めます。案件の有無や移動状態は自動判定しません。Uber側の時計に合わせてON／OFFと−1分・＋1分を使ってください。";
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
    persistEnhancedClock(true);
    save();
  };
  toggleClock = enhancedToggleClock;
  renderClock = function() { renderEnhancedClock(); };
  countEndLabel = function() { return exhaustionText(); };

  injectUi();
  $("countToggle").onclick = enhancedToggleClock;

  adjustRemain = function(delta) {
    tickClock();
    clockState.remainingMs = clamp(clockState.remainingMs + finite(delta, 0) * 60000, 0, MAX_REMAIN_INPUT_MINUTES * 60000);
    clockState.baseRemain = clockState.remainingMs / 60000;
    persistEnhancedClock(true);
    setRemain(clockState.remainingMs / 60000);
    save();
    calc();
    renderEnhancedClock();
  };

  $("reset").onclick = function() {
    if (!confirm("完了件数・残り時間・終了上限・今日の稼働計測をリセットしますか？")) return;
    const hadSession = Boolean(!clockState.sessionEndedAt && clockState.sessionStartAt && (clockState.activeMs > 0 || n("done") > 0));
    if (hadSession && confirm("リセット前に今日の稼働記録を保存しますか？")) recordSession(false);
    $("done").value = "0";
    $("remainH").value = "12";
    $("remainM").value = "0";
    $("endLimit").value = "";
    const now = nowMs();
    clockState = {
      countMode: COUNT_MODE,
      on: false,
      remainingMs: 720 * 60000,
      baseRemain: 720,
      baseAt: now,
      lastTickAt: now,
      moving: false,
      activeMs: 0,
      sessionStartAt: null,
      sessionEndedAt: null,
      breakOn: false,
      breakStartedAt: null,
      breakMs: 0,
      breakSegments: [],
      legacyBreakMs: 0,
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
