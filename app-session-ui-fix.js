(() => {
  "use strict";

  const ENHANCED_CLOCK_KEY = "ubereatsProgressMovementClockV1";
  const COUNT_MODE = "continuous-v1";
  const USAGE_MODE = "remaining-v1";
  const WORK_LIMIT_MS = 720 * 60000;
  const $id = id => document.getElementById(id);

  function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function clockUsedMs(remainingMs) {
    return Math.max(0, Math.min(WORK_LIMIT_MS - finite(remainingMs, WORK_LIMIT_MS), WORK_LIMIT_MS));
  }

  function breakOverlapMs(startAt, endAt = Date.now()) {
    if (!clockState) return 0;
    const windowMs = Math.max(0, endAt - startAt);
    if (!Array.isArray(clockState.breakSegments) || !clockState.breakSegments.length) {
      const stored = Math.max(0, finite(clockState.breakMs, 0), finite(clockState.legacyBreakMs, 0));
      if (!clockState.breakOn || !clockState.breakStartedAt) return Math.min(windowMs, stored);
      const currentStart = Math.max(startAt, finite(clockState.breakStartedAt, endAt));
      return Math.min(windowMs, stored + Math.max(0, endAt - currentStart));
    }
    const intervals = clockState.breakSegments.map(segment => {
      const isTuple = Array.isArray(segment);
      const rawStart = isTuple ? segment[0] : segment && (segment.startAt ?? segment.startedAt ?? segment.start);
      const rawEnd = isTuple ? segment[1] : segment && (segment.endAt ?? segment.endedAt ?? segment.end);
      const segmentStart = finite(rawStart, NaN);
      const segmentEnd = rawEnd === null || rawEnd === undefined ? endAt : finite(rawEnd, NaN);
      if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)) return null;
      const overlapStart = Math.max(startAt, segmentStart);
      const overlapEnd = Math.min(endAt, segmentEnd);
      return overlapEnd > overlapStart ? [overlapStart, overlapEnd] : null;
    }).filter(Boolean).sort((a, b) => a[0] - b[0]);

    let total = 0;
    let mergedStart = null;
    let mergedEnd = null;
    intervals.forEach(([start, end]) => {
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
    });
    if (mergedStart !== null) total += mergedEnd - mergedStart;
    const legacyFallback = Math.max(0, finite(clockState.legacyBreakMs, 0));
    return Math.min(windowMs, legacyFallback + total);
  }

  function otherCompanyOverlapMs(startAt, endAt = Date.now()) {
    if (!clockState) return 0;
    const windowMs = Math.max(0, endAt - startAt);
    const segments = Array.isArray(clockState.otherCompanySegments) ? clockState.otherCompanySegments : [];
    if (!segments.length) return Math.min(windowMs, Math.max(0, finite(clockState.otherCompanyMs, 0)));
    const intervals = segments.map(segment => {
      const rawStart = segment && segment.startAt;
      const rawEnd = segment && segment.endAt;
      const segmentStart = finite(rawStart, NaN);
      const segmentEnd = rawEnd === null || rawEnd === undefined ? endAt : finite(rawEnd, NaN);
      if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)) return null;
      const overlapStart = Math.max(startAt, segmentStart);
      const overlapEnd = Math.min(endAt, segmentEnd);
      return overlapEnd > overlapStart ? [overlapStart, overlapEnd] : null;
    }).filter(Boolean).sort((a, b) => a[0] - b[0]);
    let total = 0;
    let mergedStart = null;
    let mergedEnd = null;
    intervals.forEach(([start, end]) => {
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
    });
    if (mergedStart !== null) total += mergedEnd - mergedStart;
    return Math.min(windowMs, Math.max(0, total));
  }

  function toLocalInputValue(timestamp) {
    const date = new Date(timestamp);
    const pad = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function parseLocalInput(value) {
    if (!value) return NaN;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }

  function saveEnhancedState() {
    const now = Date.now();
    const anchorAt = Math.max(finite(clockState.lastTickAt, 0), now);
    const remainingMs = Math.max(0, finite(clockState.remainingMs, finite(clockState.baseRemain) * 60000));
    clockState.countMode = COUNT_MODE;
    clockState.usageMode = USAGE_MODE;
    clockState.activeMs = clockUsedMs(remainingMs);
    const metricEndAt = clockState.sessionEndedAt || now;
    const otherCompanyMs = clockState.sessionStartAt ? otherCompanyOverlapMs(clockState.sessionStartAt, metricEndAt) : 0;
    clockState.otherCompanyMs = otherCompanyMs;
    clockState.totalActiveMs = clockState.activeMs + otherCompanyMs;
    clockState.baseAt = anchorAt;
    clockState.lastTickAt = anchorAt;
    clockState.updatedAt = anchorAt;
    const state = {
      countMode: COUNT_MODE,
      usageMode: USAGE_MODE,
      on: Boolean(clockState.on),
      remainingMs,
      activeMs: clockState.activeMs,
      sessionStartAt: clockState.sessionStartAt || null,
      sessionEndedAt: clockState.sessionEndedAt || null,
      breakOn: Boolean(clockState.breakOn),
      breakStartedAt: clockState.breakStartedAt || null,
      breakMs: Math.max(0, finite(clockState.breakMs, 0)),
      breakSegments: Array.isArray(clockState.breakSegments) ? clockState.breakSegments.map(segment => ({
        startAt: segment.startAt,
        endAt: segment.endAt === null ? null : segment.endAt
      })) : undefined,
      legacyBreakMs: Math.max(0, finite(clockState.legacyBreakMs, 0)),
      otherCompanyOn: Boolean(clockState.otherCompanyOn),
      otherCompanyStartedAt: clockState.otherCompanyStartedAt || null,
      otherCompanyMs,
      otherCompanySegments: Array.isArray(clockState.otherCompanySegments) ? clockState.otherCompanySegments.map(segment => ({
        startAt: segment.startAt,
        endAt: segment.endAt === null ? null : segment.endAt
      })) : [],
      totalActiveMs: clockState.totalActiveMs,
      backgroundGap: null,
      lastBackfillMs: 0,
      lastBackfillAt: null,
      updatedAt: anchorAt
    };
    localStorage.setItem(ENHANCED_CLOCK_KEY, JSON.stringify(state));
    localStorage.setItem(CLOCK_KEY, JSON.stringify({
      on: state.on,
      baseRemain: state.remainingMs / 60000,
      baseAt: now
    }));
    if (typeof save === "function") save();
    if (typeof calc === "function") calc();
  }

  function closeEditor(restoreFocus = true) {
    const layer = $id("startTimeEditorLayer");
    if (!layer) return;
    layer.hidden = true;
    $id("appRoot").inert = false;
    document.body.classList.remove("startTimeEditorOpen");
    const editButton = $id("editStartTime");
    if (editButton) {
      editButton.setAttribute("aria-expanded", "false");
      if (restoreFocus) editButton.focus({ preventScroll: true });
    }
  }

  function openEditor() {
    const layer = $id("startTimeEditorLayer");
    const input = $id("startTimeInput");
    const error = $id("startTimeError");
    if (!layer || !input || !clockState || !clockState.sessionStartAt || clockState.sessionEndedAt) return;
    const initial = clockState && clockState.sessionStartAt ? clockState.sessionStartAt : Date.now();
    input.value = toLocalInputValue(initial);
    input.max = toLocalInputValue(Date.now());
    error.textContent = "";
    layer.hidden = false;
    $id("appRoot").inert = true;
    document.body.classList.add("startTimeEditorOpen");
    $id("editStartTime").setAttribute("aria-expanded", "true");
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  }

  function applyStartTime() {
    const input = $id("startTimeInput");
    const error = $id("startTimeError");
    if (!clockState || !clockState.sessionStartAt || clockState.sessionEndedAt) {
      closeEditor();
      return;
    }
    error.textContent = "";
    const timestamp = parseLocalInput(input.value);
    const now = Date.now();
    if (!Number.isFinite(timestamp)) {
      error.textContent = "開始日時を入力してください。";
      return;
    }
    if (timestamp > now) {
      error.textContent = "開始時刻を現在より後には設定できません。";
      return;
    }
    if (typeof remain === "function") remain();
    const remainingMs = Math.max(0, finite(clockState.remainingMs, finite(clockState.baseRemain) * 60000));
    const currentStartAt = finite(clockState.sessionStartAt, timestamp);
    const recordedOtherCompanyMs = otherCompanyOverlapMs(currentStartAt, now);
    const earliestOtherCompanyStartAt = (Array.isArray(clockState.otherCompanySegments) ? clockState.otherCompanySegments : []).reduce((earliest, segment) => {
      const startAt = finite(segment && segment.startAt, NaN);
      const rawEnd = segment && segment.endAt;
      const endAt = rawEnd === null || rawEnd === undefined ? now : finite(rawEnd, NaN);
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return earliest;
      return Math.min(earliest, Math.max(currentStartAt, startAt));
    }, Infinity);
    const activeMs = clockUsedMs(remainingMs) + recordedOtherCompanyMs;
    const elapsedMs = Math.max(0, now - timestamp - breakOverlapMs(timestamp, now));
    const startsAfterOtherCompanyWork = Number.isFinite(earliestOtherCompanyStartAt) && timestamp > earliestOtherCompanyStartAt;
    if (startsAfterOtherCompanyWork || activeMs > elapsedMs) {
      error.textContent = "開始時刻が遅すぎます。総実稼働時間より後には設定できません。";
      return;
    }
    clockState.sessionStartAt = timestamp;
    saveEnhancedState();
    closeEditor();
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .remainSync{min-width:0;width:100%;max-width:none;grid-template-columns:clamp(44px,11.5vw,50px) minmax(0,1fr) clamp(44px,11.5vw,50px);gap:clamp(4px,1.2vw,5px)}
      .remainSync .remainBig{min-width:0;margin:0;padding:0 2px;overflow:hidden;font-size:clamp(24px,6.5vw,26px);font-variant-numeric:tabular-nums;line-height:1.15;letter-spacing:-.06em;text-align:center;white-space:nowrap}
      .remainStep{width:100%;min-width:0;padding-left:2px;padding-right:2px}
      .workSessionStart{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:3px 7px;max-width:58%}
      .workSessionStart>span{grid-column:1/-1;color:#8fa6ba;font-size:11px}
      .workSessionStart strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .editStartTime{align-self:center;min-height:32px;padding:5px 9px;border:1px solid #2f8bff;border-radius:11px;background:rgba(16,83,164,.24);color:#74b8ff;font-size:10px;box-shadow:none}
      .startTimeEditorLayer{position:fixed;z-index:100;inset:0;display:grid;place-items:center;padding:clamp(8px,4vw,18px)}
      .startTimeEditorLayer[hidden]{display:none}
      .startTimeEditorBackdrop{position:absolute;inset:0;background:rgba(0,5,12,.78);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px)}
      .startTimeEditor{position:relative;width:100%;max-width:430px;min-width:0;padding:clamp(14px,4.5vw,18px);overflow:hidden;border:1px solid #28506c;border-radius:24px;background:linear-gradient(160deg,#0a2436,#04131f);box-shadow:0 24px 70px rgba(0,0,0,.58);outline:none}
      .startTimeEditor h3{margin:0;color:#f5f9fc;font-size:19px}
      .startTimeEditor p{margin:5px 0 14px;color:#8fa6ba;font-size:11px;line-height:1.5}
      .startTimeEditor input{display:block;width:100%;max-width:100%;min-width:0;min-height:54px;padding:11px 9px;border:1px solid #2a4c66;border-radius:15px;background:#061522;color:#f4f8fb;font-size:clamp(15px,4.8vw,17px);color-scheme:dark}
      .startTimeError{min-height:20px;margin:7px 1px 0;color:#ff8a94;font-size:10px;line-height:1.4}
      .startTimeEditorActions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}
      .startTimeEditorActions button{min-height:46px;padding:10px;border:1px solid #365b75;border-radius:15px;background:linear-gradient(180deg,#143047,#0a2134);font-size:13px}
      .startTimeEditorActions .applyStartTime{border-color:#2f8bff;background:linear-gradient(180deg,#1769c4,#0a4b9e)}
      .startTimeEditorOpen{overflow:hidden}
      .workSessionStat{min-width:0}
      .workSessionStat strong{max-width:100%;font-size:clamp(12px,4vw,17px);letter-spacing:-.035em;white-space:normal;overflow-wrap:anywhere}
      @media(max-width:440px){
        .countPanel{padding-left:12px;padding-right:12px}
        .remainSync .remainBig{padding-left:0;padding-right:0}
        .remainStep{min-height:46px;font-size:13px;border-radius:14px}
        .workSessionStart{max-width:64%}
      }
      @media(max-width:370px){
        .remainSync{grid-template-columns:1fr 1fr;gap:7px}
        .remainSync .remainBig{grid-column:1/-1;grid-row:1;font-size:26px;white-space:nowrap}
        .remainSync #remainMinus{grid-column:1;grid-row:2}
        .remainSync #remainPlus{grid-column:2;grid-row:2}
        .workSessionHead{align-items:stretch;flex-direction:column}
        .workSessionStart{max-width:none;text-align:left}
      }
    `;
    document.head.appendChild(style);
  }

  function injectEditor() {
    const startBox = document.querySelector(".workSessionStart");
    if (!startBox || $id("editStartTime")) return;
    const labelText = [...startBox.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
    if (labelText) labelText.remove();
    const label = document.createElement("span");
    label.textContent = "開始時刻";
    startBox.prepend(label);
    const button = document.createElement("button");
    button.id = "editStartTime";
    button.className = "editStartTime";
    button.type = "button";
    button.textContent = "編集";
    button.setAttribute("aria-label", "開始時刻を編集");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", "startTimeEditorDialog");
    button.setAttribute("aria-expanded", "false");
    button.disabled = !clockState || !clockState.sessionStartAt || Boolean(clockState.sessionEndedAt);
    button.setAttribute("aria-disabled", String(button.disabled));
    startBox.appendChild(button);

    const layer = document.createElement("div");
    layer.id = "startTimeEditorLayer";
    layer.className = "startTimeEditorLayer";
    layer.hidden = true;
    layer.innerHTML = `
      <div id="startTimeEditorBackdrop" class="startTimeEditorBackdrop"></div>
      <section id="startTimeEditorDialog" class="startTimeEditor" role="dialog" aria-modal="true" aria-labelledby="startTimeEditorTitle" tabindex="-1">
        <h3 id="startTimeEditorTitle">開始時刻を修正</h3>
        <p>実際にオンラインを開始した日時へ合わせます。変更後は経過時間と実稼働率を再計算します。</p>
        <input id="startTimeInput" type="datetime-local" step="60" aria-label="開始日時">
        <div id="startTimeError" class="startTimeError" aria-live="polite"></div>
        <div class="startTimeEditorActions"><button id="cancelStartTime" type="button">キャンセル</button><button id="applyStartTime" class="applyStartTime" type="button">変更する</button></div>
      </section>`;
    document.body.appendChild(layer);

    button.onclick = openEditor;
    $id("cancelStartTime").onclick = closeEditor;
    $id("startTimeEditorBackdrop").onclick = closeEditor;
    $id("applyStartTime").onclick = applyStartTime;
    layer.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
        return;
      }
      if (event.key === "Enter" && event.target === $id("startTimeInput")) {
        event.preventDefault();
        applyStartTime();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...$id("startTimeEditorDialog").querySelectorAll("button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])")].filter(element => element.offsetParent !== null);
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
  }

  function initialize() {
    injectStyles();
    injectEditor();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
