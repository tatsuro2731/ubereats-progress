(() => {
  "use strict";

  const ENHANCED_CLOCK_KEY = "ubereatsProgressMovementClockV1";
  const COUNT_MODE = "continuous-v1";
  const USAGE_MODE = "remaining-v1";
  const WORK_LIMIT_MS = 720 * 60000;
  const $id = id => document.getElementById(id);
  let breakEditorInitialMinutes = null;

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
      const rawStart = segment && (segment.startAt ?? segment.startedAt ?? segment.start);
      const rawEnd = segment && (segment.endAt ?? segment.endedAt ?? segment.end);
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
    return Math.min(windowMs, Math.max(0, finite(clockState.legacyOtherCompanyMs, 0)) + total);
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
    clockState.otherCompanyMs = Math.min(
      clockState.activeMs,
      otherCompanyOverlapMs(clockState.sessionStartAt || now, clockState.sessionEndedAt || now)
    );
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
      otherCompanyMs: Math.max(0, finite(clockState.otherCompanyMs, 0)),
      otherCompanySegments: Array.isArray(clockState.otherCompanySegments) ? clockState.otherCompanySegments.map(segment => ({
        startAt: segment.startAt,
        endAt: segment.endAt === null ? null : segment.endAt
      })) : undefined,
      legacyOtherCompanyMs: Math.max(0, finite(clockState.legacyOtherCompanyMs, 0)),
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
    const activeMs = clockUsedMs(remainingMs);
    const elapsedMs = Math.max(0, now - timestamp - breakOverlapMs(timestamp, now));
    if (activeMs > elapsedMs) {
      error.textContent = "開始時刻が遅すぎます。記録済みの稼働時間を収められません。";
      return;
    }
    clockState.sessionStartAt = timestamp;
    saveEnhancedState();
    closeEditor();
  }

  function currentBreakMs(at = Date.now()) {
    if (!clockState || !clockState.sessionStartAt) return 0;
    const endAt = clockState.sessionEndedAt || at;
    return breakOverlapMs(clockState.sessionStartAt, endAt);
  }

  function closeBreakEditor(restoreFocus = true) {
    const layer = $id("breakTimeEditorLayer");
    if (!layer) return;
    layer.hidden = true;
    $id("appRoot").inert = false;
    document.body.classList.remove("breakTimeEditorOpen");
    breakEditorInitialMinutes = null;
    const editButton = $id("editBreakTime");
    if (editButton) {
      editButton.setAttribute("aria-expanded", "false");
      if (restoreFocus) editButton.focus({ preventScroll: true });
    }
  }

  function openBreakEditor() {
    const layer = $id("breakTimeEditorLayer");
    const hours = $id("breakTimeHours");
    const minutes = $id("breakTimeMinutes");
    const error = $id("breakTimeError");
    if (!layer || !hours || !minutes || !clockState || !clockState.sessionStartAt || clockState.sessionEndedAt) return;
    if (typeof remain === "function") remain();
    breakEditorInitialMinutes = Math.floor(currentBreakMs() / 60000);
    hours.value = String(Math.floor(breakEditorInitialMinutes / 60));
    minutes.value = String(breakEditorInitialMinutes % 60);
    error.textContent = "";
    layer.hidden = false;
    $id("appRoot").inert = true;
    document.body.classList.add("breakTimeEditorOpen");
    $id("editBreakTime").setAttribute("aria-expanded", "true");
    setTimeout(() => hours.focus({ preventScroll: true }), 0);
  }

  function setBreakDuration(milliseconds, at = Date.now()) {
    if (!clockState || !clockState.sessionStartAt || clockState.sessionEndedAt) {
      return { ok: false, reason: "inactive", maxMs: 0 };
    }
    const desiredMs = Math.max(0, finite(milliseconds, 0));
    const remainingMs = Math.max(0, finite(clockState.remainingMs, finite(clockState.baseRemain) * 60000));
    const activeMs = clockUsedMs(remainingMs);
    const wallElapsedMs = Math.max(0, at - clockState.sessionStartAt);
    const maxMs = Math.max(0, wallElapsedMs - activeMs);
    if (desiredMs > maxMs) return { ok: false, reason: "too-long", maxMs };

    const continues = Boolean(clockState.breakOn);
    clockState.legacyBreakMs = desiredMs;
    clockState.breakMs = desiredMs;
    clockState.breakSegments = continues ? [{ startAt: at, endAt: null }] : [];
    clockState.breakStartedAt = continues ? at : null;
    saveEnhancedState();
    return { ok: true, maxMs };
  }

  function applyBreakTime() {
    const hours = $id("breakTimeHours");
    const minutes = $id("breakTimeMinutes");
    const error = $id("breakTimeError");
    if (!clockState || !clockState.sessionStartAt || clockState.sessionEndedAt) {
      closeBreakEditor();
      return;
    }
    const hourValue = Math.max(0, finite(hours.value, 0));
    const minuteValue = Math.max(0, Math.min(59, finite(minutes.value, 0)));
    const totalMinutes = hourValue * 60 + minuteValue;
    if (totalMinutes === breakEditorInitialMinutes) {
      closeBreakEditor();
      return;
    }
    if (typeof remain === "function") remain();
    const result = setBreakDuration(totalMinutes * 60000, Date.now());
    if (!result.ok) {
      if (result.reason === "too-long") {
        const maximumMinutes = Math.floor(result.maxMs / 60000);
        error.textContent = `休憩時間が長すぎます。現在は最大${Math.floor(maximumMinutes / 60)}時間${String(maximumMinutes % 60).padStart(2, "0")}分まで設定できます。`;
      } else {
        error.textContent = "稼働中の休憩時間だけ修正できます。";
      }
      return;
    }
    closeBreakEditor();
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .remainSync{min-width:0;width:100%;max-width:none;grid-template-columns:clamp(44px,11.5vw,50px) minmax(0,1fr) clamp(44px,11.5vw,50px);gap:clamp(4px,1.2vw,5px)}
      .remainSync .remainBig{min-width:0;margin:0;padding:0 2px;overflow:hidden;font-size:clamp(24px,6.5vw,26px);font-variant-numeric:tabular-nums;line-height:1.15;letter-spacing:-.06em;text-align:center;white-space:nowrap}
      .remainStep{width:100%;min-width:0;padding-left:2px;padding-right:2px}
      .workSessionStart{display:grid;width:100%;max-width:none;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:7px;padding:8px 9px;border:1px solid rgba(59,91,116,.42);border-radius:13px;background:rgba(3,18,27,.48);text-align:left}
      .workSessionStart>span{grid-column:auto;color:#8fa6ba;font-size:10px;font-weight:750;white-space:nowrap}
      .workSessionStart strong{display:block;min-width:0;margin:0;overflow:visible;color:#e7f2fb;font-size:13px;font-variant-numeric:tabular-nums;text-overflow:clip;white-space:nowrap}
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
      .breakTimeEditorLayer{position:fixed;z-index:100;inset:0;display:grid;place-items:center;padding:clamp(8px,4vw,18px)}
      .breakTimeEditorLayer[hidden]{display:none}
      .breakTimeEditorBackdrop{position:absolute;inset:0;background:rgba(0,5,12,.78);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px)}
      .breakTimeEditor{position:relative;width:100%;max-width:430px;min-width:0;padding:clamp(14px,4.5vw,18px);overflow:hidden;border:1px solid #28506c;border-radius:24px;background:linear-gradient(160deg,#0a2436,#04131f);box-shadow:0 24px 70px rgba(0,0,0,.58);outline:none}
      .breakTimeEditor h3{margin:0;color:#f5f9fc;font-size:19px}
      .breakTimeEditor p{margin:5px 0 14px;color:#8fa6ba;font-size:11px;line-height:1.5}
      .breakTimeFields{display:grid;grid-template-columns:1fr 1fr;gap:9px}
      .breakTimeFields label{min-width:0;margin:0;color:#aebdcc;font-size:10px;font-weight:750}
      .breakTimeFields select{display:block;width:100%;max-width:100%;min-width:0;min-height:54px;margin-top:5px;padding:10px;border:1px solid #2a4c66;border-radius:15px;background:#061522;color:#f4f8fb;font-size:17px;color-scheme:dark}
      .breakTimeError{min-height:20px;margin:7px 1px 0;color:#ff8a94;font-size:10px;line-height:1.4}
      .breakTimeEditorActions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}
      .breakTimeEditorActions button{min-height:46px;padding:10px;border:1px solid #365b75;border-radius:15px;background:linear-gradient(180deg,#143047,#0a2134);font-size:13px}
      .breakTimeEditorActions .applyBreakTime{border-color:#2f8bff;background:linear-gradient(180deg,#1769c4,#0a4b9e)}
      .breakTimeEditorOpen{overflow:hidden}
      .workSessionStat{min-width:0}
      .workSessionStat strong{max-width:100%;font-size:clamp(12px,3.8vw,17px);font-variant-numeric:tabular-nums;letter-spacing:-.04em;white-space:nowrap;overflow-wrap:normal}
      @media(max-width:440px){
        .countPanel{padding-left:12px;padding-right:12px}
        .remainSync .remainBig{padding-left:0;padding-right:0}
        .remainStep{min-height:46px;font-size:13px;border-radius:14px}
      }
      @media(max-width:370px){
        .remainSync{grid-template-columns:1fr 1fr;gap:7px}
        .remainSync .remainBig{grid-column:1/-1;grid-row:1;font-size:26px;white-space:nowrap}
        .remainSync #remainMinus{grid-column:1;grid-row:2}
        .remainSync #remainPlus{grid-column:2;grid-row:2}
        .workSessionStart{grid-template-columns:auto minmax(0,1fr) auto}
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

  function injectBreakEditor() {
    const button = $id("editBreakTime");
    if (!button || $id("breakTimeEditorLayer")) return;
    button.setAttribute("aria-controls", "breakTimeEditorDialog");
    button.setAttribute("aria-expanded", "false");

    const layer = document.createElement("div");
    layer.id = "breakTimeEditorLayer";
    layer.className = "breakTimeEditorLayer";
    layer.hidden = true;
    layer.innerHTML = `
      <div id="breakTimeEditorBackdrop" class="breakTimeEditorBackdrop"></div>
      <section id="breakTimeEditorDialog" class="breakTimeEditor" role="dialog" aria-modal="true" aria-labelledby="breakTimeEditorTitle" tabindex="-1">
        <h3 id="breakTimeEditorTitle">休憩時間を修正</h3>
        <p>時間OFFで自動記録された今日の累計休憩時間を合わせます。休憩中に直した場合は、変更後もそのまま加算を続けます。</p>
        <div class="breakTimeFields">
          <label>時間<select id="breakTimeHours" aria-label="休憩時間の時間"></select></label>
          <label>分<select id="breakTimeMinutes" aria-label="休憩時間の分"></select></label>
        </div>
        <div id="breakTimeError" class="breakTimeError" aria-live="polite"></div>
        <div class="breakTimeEditorActions"><button id="cancelBreakTime" type="button">キャンセル</button><button id="applyBreakTime" class="applyBreakTime" type="button">変更する</button></div>
      </section>`;
    document.body.appendChild(layer);

    const hours = $id("breakTimeHours");
    const minutes = $id("breakTimeMinutes");
    for (let value = 0; value <= 23; value += 1) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value}時間`;
      hours.appendChild(option);
    }
    for (let value = 0; value <= 59; value += 1) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value}分`;
      minutes.appendChild(option);
    }

    button.onclick = openBreakEditor;
    $id("cancelBreakTime").onclick = closeBreakEditor;
    $id("breakTimeEditorBackdrop").onclick = closeBreakEditor;
    $id("applyBreakTime").onclick = applyBreakTime;
    layer.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeBreakEditor();
        return;
      }
      if (event.key === "Enter" && (event.target === hours || event.target === minutes)) {
        event.preventDefault();
        applyBreakTime();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...$id("breakTimeEditorDialog").querySelectorAll("button:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex='-1'])")].filter(element => element.offsetParent !== null);
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
    injectBreakEditor();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
