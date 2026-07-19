(() => {
  "use strict";

  const ENHANCED_CLOCK_KEY = "ubereatsProgressMovementClockV1";
  const $id = id => document.getElementById(id);

  function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function currentBreakMs(at = Date.now()) {
    if (!clockState) return 0;
    const stored = Math.max(0, finite(clockState.breakMs, 0));
    if (!clockState.breakOn || !clockState.breakStartedAt) return stored;
    return stored + Math.max(0, at - finite(clockState.breakStartedAt, at));
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
    clockState.baseAt = now;
    clockState.lastTickAt = now;
    clockState.updatedAt = now;
    const state = {
      on: Boolean(clockState.on),
      remainingMs: Math.max(0, finite(clockState.remainingMs, finite(clockState.baseRemain) * 60000)),
      activeMs: Math.max(0, finite(clockState.activeMs, 0)),
      sessionStartAt: clockState.sessionStartAt || null,
      breakOn: Boolean(clockState.breakOn),
      breakStartedAt: clockState.breakStartedAt || null,
      breakMs: Math.max(0, finite(clockState.breakMs, 0)),
      updatedAt: now
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

  function closeEditor() {
    const layer = $id("startTimeEditorLayer");
    if (!layer) return;
    layer.hidden = true;
    document.body.classList.remove("startTimeEditorOpen");
  }

  function openEditor() {
    const layer = $id("startTimeEditorLayer");
    const input = $id("startTimeInput");
    const error = $id("startTimeError");
    if (!layer || !input) return;
    const initial = clockState && clockState.sessionStartAt ? clockState.sessionStartAt : Date.now();
    input.value = toLocalInputValue(initial);
    input.max = toLocalInputValue(Date.now());
    error.textContent = "";
    layer.hidden = false;
    document.body.classList.add("startTimeEditorOpen");
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  }

  function applyStartTime() {
    const input = $id("startTimeInput");
    const error = $id("startTimeError");
    const timestamp = parseLocalInput(input.value);
    const now = Date.now();
    if (!Number.isFinite(timestamp)) {
      error.textContent = "開始日時を入力してください。";
      return;
    }
    if (timestamp > now + 30000) {
      error.textContent = "開始時刻を現在より後には設定できません。";
      return;
    }
    const activeMs = Math.max(0, finite(clockState.activeMs, 0));
    const availableMs = Math.max(0, now - timestamp - currentBreakMs(now));
    if (availableMs + 60000 < activeMs) {
      error.textContent = "開始時刻が遅すぎます。時計が減った時間より後には設定できません。";
      return;
    }
    clockState.sessionStartAt = timestamp;
    saveEnhancedState();
    closeEditor();
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .remainSync{min-width:0;width:100%;max-width:none;grid-template-columns:clamp(52px,14vw,64px) minmax(0,1fr) clamp(52px,14vw,64px)}
      .remainSync .remainBig{min-width:0;margin:0;padding:0 4px;overflow:visible;font-size:clamp(17px,5.4vw,30px);line-height:1.15;letter-spacing:-.045em;text-align:center;white-space:nowrap}
      .remainStep{width:100%;min-width:0;padding-left:2px;padding-right:2px}
      .workSessionStart{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:3px 7px;max-width:58%}
      .workSessionStart>span{grid-column:1/-1;color:#8fa6ba;font-size:11px}
      .workSessionStart strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .editStartTime{align-self:center;min-height:32px;padding:5px 9px;border:1px solid #2f8bff;border-radius:11px;background:rgba(16,83,164,.24);color:#74b8ff;font-size:10px;box-shadow:none}
      .startTimeEditorLayer{position:fixed;z-index:100;inset:0;display:grid;place-items:center;padding:18px}
      .startTimeEditorLayer[hidden]{display:none}
      .startTimeEditorBackdrop{position:absolute;inset:0;background:rgba(0,5,12,.78);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px)}
      .startTimeEditor{position:relative;width:min(100%,430px);padding:18px;border:1px solid #28506c;border-radius:24px;background:linear-gradient(160deg,#0a2436,#04131f);box-shadow:0 24px 70px rgba(0,0,0,.58)}
      .startTimeEditor h3{margin:0;color:#f5f9fc;font-size:19px}
      .startTimeEditor p{margin:5px 0 14px;color:#8fa6ba;font-size:11px;line-height:1.5}
      .startTimeEditor input{width:100%;min-height:54px;padding:11px 12px;border:1px solid #2a4c66;border-radius:15px;background:#061522;color:#f4f8fb;font-size:17px;color-scheme:dark}
      .startTimeError{min-height:20px;margin:7px 1px 0;color:#ff8a94;font-size:10px;line-height:1.4}
      .startTimeEditorActions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}
      .startTimeEditorActions button{min-height:46px;padding:10px;border:1px solid #365b75;border-radius:15px;background:linear-gradient(180deg,#143047,#0a2134);font-size:13px}
      .startTimeEditorActions .applyStartTime{border-color:#2f8bff;background:linear-gradient(180deg,#1769c4,#0a4b9e)}
      .startTimeEditorOpen{overflow:hidden}
      @media(max-width:430px){
        .countPanel{padding-left:12px;padding-right:12px}
        .remainSync{grid-template-columns:54px minmax(0,1fr) 54px;gap:6px}
        .remainSync .remainBig{font-size:clamp(15px,4.65vw,20px);letter-spacing:-.055em}
        .remainStep{min-height:46px;font-size:13px;border-radius:14px}
        .workSessionStart{max-width:64%}
      }
      @media(max-width:350px){
        .remainSync{grid-template-columns:1fr 1fr;gap:7px}
        .remainSync .remainBig{grid-column:1/-1;grid-row:1;font-size:20px;white-space:normal}
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
    startBox.appendChild(button);

    const layer = document.createElement("div");
    layer.id = "startTimeEditorLayer";
    layer.className = "startTimeEditorLayer";
    layer.hidden = true;
    layer.innerHTML = `
      <div id="startTimeEditorBackdrop" class="startTimeEditorBackdrop"></div>
      <section class="startTimeEditor" role="dialog" aria-modal="true" aria-labelledby="startTimeEditorTitle">
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
      if (event.key === "Escape") closeEditor();
      if (event.key === "Enter" && event.target === $id("startTimeInput")) applyStartTime();
    });
  }

  function initialize() {
    injectStyles();
    injectEditor();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();