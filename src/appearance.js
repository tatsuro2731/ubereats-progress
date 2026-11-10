(function(root) {
  "use strict";

  // Appearance is a device preference, never part of the delivery/timer record.
  const STORAGE_KEY = "ubereatsProgressAppearanceV1";
  const DEFAULTS = Object.freeze({ mode: "auto", lightStart: "06:00", darkStart: "18:00" });
  // The skin (surface finish) has its own key so the theme record keeps its
  // format. Both skins share the same palette, state colours and layout.
  const SKIN_KEY = "ubereatsProgressSkinV1";
  const SKINS = Object.freeze(["rich", "classic"]);
  const normalizeSkin = value => SKINS.includes(value) ? value : SKINS[0];
  const THEME_COLORS = Object.freeze({
    classic: Object.freeze({ light: "#f0f7f3", dark: "#111815" }),
    rich: Object.freeze({ light: "#edf3f5", dark: "#050b0e" })
  });

  function timeMinutes(value) {
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  }

  function normalize(value) {
    const data = value && typeof value === "object" ? value : {};
    const result = {
      mode: ["auto", "light", "dark"].includes(data.mode) ? data.mode : DEFAULTS.mode,
      lightStart: timeMinutes(data.lightStart) !== null ? data.lightStart : DEFAULTS.lightStart,
      darkStart: timeMinutes(data.darkStart) !== null ? data.darkStart : DEFAULTS.darkStart
    };
    if (result.lightStart === result.darkStart) {
      result.lightStart = DEFAULTS.lightStart;
      result.darkStart = DEFAULTS.darkStart;
    }
    return result;
  }

  function themeAt(settings, date = new Date()) {
    const config = normalize(settings);
    if (config.mode !== "auto") return config.mode;
    const minute = date.getHours() * 60 + date.getMinutes();
    const light = timeMinutes(config.lightStart);
    const dark = timeMinutes(config.darkStart);
    const lightNow = light < dark
      ? minute >= light && minute < dark
      : minute >= light || minute < dark;
    return lightNow ? "light" : "dark";
  }

  function nextCheckDelay(settings, date = new Date()) {
    const config = normalize(settings);
    const boundaries = [config.lightStart, config.darkStart].map(value => {
      const at = new Date(date.getTime());
      const minute = timeMinutes(value);
      at.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
      if (at <= date) at.setDate(at.getDate() + 1);
      return at.getTime() - date.getTime();
    });
    // The minute cap also picks up a device-clock/time-zone change while visible.
    return Math.max(25, Math.min(60000, ...boundaries) + 10);
  }

  const api = { STORAGE_KEY, DEFAULTS, SKIN_KEY, SKINS, THEME_COLORS, timeMinutes, normalize, normalizeSkin, themeAt, nextCheckDelay };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (!root || !root.document) return;

  const doc = root.document;
  let settings = { ...DEFAULTS };
  let refreshTimer = null;
  let storageFailed = false;
  let skin = SKINS[0];
  let relayout = () => {};

  function read() {
    try {
      settings = normalize(JSON.parse(root.localStorage.getItem(STORAGE_KEY) || "null"));
      storageFailed = false;
    } catch (_) {
      // Blocked storage must not prevent the UI or its clock from starting.
    }
    try { skin = normalizeSkin(root.localStorage.getItem(SKIN_KEY)); } catch (_) { /* keep the current skin */ }
  }

  function updateControls() {
    doc.querySelectorAll("button[data-theme-mode]").forEach(button => {
      const selected = button.dataset.themeMode === settings.mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    for (const key of ["lightStart", "darkStart"]) {
      const input = doc.getElementById(key === "lightStart" ? "themeLightStart" : "themeDarkStart");
      if (!input) continue;
      if (doc.activeElement !== input) input.value = settings[key];
      input.disabled = settings.mode !== "auto";
    }
    const select = doc.getElementById("compactThemeMode");
    if (select) select.value = settings.mode;
    doc.querySelectorAll("button[data-skin-mode]").forEach(button => {
      const selected = button.dataset.skinMode === skin;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const skinSelect = doc.getElementById("compactSkinMode");
    if (skinSelect) skinSelect.value = skin;
    const note = doc.getElementById("themeScheduleNote");
    if (note) note.textContent = storageFailed
      ? "この端末に設定を保存できませんでした。現在の画面には適用しています。"
      : settings.mode === "auto"
        ? `端末の時刻で ${settings.lightStart} にライト、${settings.darkStart} にダークへ切り替わります。`
        : `${settings.mode === "dark" ? "ダーク" : "ライト"}で固定しています。「自動」にすると時刻で切り替わります。`;
  }

  function apply() {
    const theme = themeAt(settings);
    doc.documentElement.setAttribute("data-theme", theme);
    doc.documentElement.setAttribute("data-theme-mode", settings.mode);
    doc.documentElement.setAttribute("data-skin", skin);
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLORS[skin][theme]);
    updateControls();
    if (refreshTimer !== null) root.clearTimeout(refreshTimer);
    refreshTimer = null;
    if (settings.mode === "auto" && !doc.hidden) refreshTimer = root.setTimeout(apply, nextCheckDelay(settings));
  }

  function save(next) {
    settings = normalize(next);
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      storageFailed = false;
    } catch (_) { storageFailed = true; }
    apply();
  }

  function saveSkin(next) {
    skin = normalizeSkin(next);
    try { root.localStorage.setItem(SKIN_KEY, skin); } catch (_) { /* applied to this screen only */ }
    apply();
    relayout(); // the skins differ in inner padding, so re-fit the cards to the dock
  }

  // Rich-skin motion hooks. They only toggle classes; rich.css owns the animation
  // and ignores them in the classic skin or when the device reduces motion.
  function setupRichMotion() {
    const html = doc.documentElement;
    if (!html.classList || typeof html.classList.add !== "function" || typeof html.addEventListener !== "function") return;
    // The entrance plays once per launch. Count the running entrance animations
    // and drop the class when the last one ends, so cards that are re-rendered
    // later do not replay it. No timer: nothing runs when motion is reduced.
    let running = 0;
    const entrance = event => event.animationName === "r-rise" || event.animationName === "r-dock";
    // Cards are measured for the dock fit; measure again once they stop moving.
    // The dock is timed to finish last and is never re-rendered, so its end also
    // releases the class when a card was replaced mid-entrance and its own end
    // event can no longer arrive.
    const finish = event => {
      if (!entrance(event)) return;
      running -= 1;
      if (running > 0 && event.animationName !== "r-dock") return;
      html.classList.remove("r-intro");
      relayout();
    };
    html.addEventListener("animationstart", event => { if (entrance(event)) running += 1; });
    html.addEventListener("animationend", finish);
    html.addEventListener("animationcancel", finish);
    html.classList.add("r-intro");
    const hero = doc.getElementById("hero");
    const done = doc.getElementById("heroDone");
    if (!hero || !done || !hero.classList || !root.MutationObserver) return;
    let shown = done.textContent;
    let timer = null;
    new root.MutationObserver(() => {
      if (done.textContent === shown) return;
      const first = shown === "" || shown === "-";
      shown = done.textContent;
      if (first || skin !== "rich") return;
      hero.classList.remove("r-tick");
      void hero.offsetWidth; // restart the animation for rapid taps
      hero.classList.add("r-tick");
      if (timer !== null) root.clearTimeout(timer);
      timer = root.setTimeout(() => { hero.classList.remove("r-tick"); timer = null; }, 800);
    }).observe(done, { childList: true, characterData: true, subtree: true });
  }

  function setupDashboardLayout() {
    const DENSITIES = ["comfortable", "compact", "dense", "tight"];
    const dock = doc.getElementById("operationDock");
    if (!dock) return;
    const overview = doc.getElementById("dashboardOverview");
    const metrics = doc.getElementById("metrics");
    const progressView = doc.getElementById("progressView");
    let pending = false;
    const schedule = () => {
      if (pending || doc.hidden || (progressView && progressView.hidden)) return;
      pending = true;
      root.requestAnimationFrame(fit);
    };
    function fit() {
      pending = false;
      if (doc.hidden || (progressView && progressView.hidden)) return;
      const dockHeight = Math.ceil(dock.getBoundingClientRect().height);
      const dockSize = `${dockHeight}px`;
      if (doc.documentElement.style.getPropertyValue("--operation-dock-height") !== dockSize) {
        doc.documentElement.style.setProperty("--operation-dock-height", dockSize);
      }
      if (!metrics) return;
      // Do not move the cards underneath a drag, or compress the reorder handles.
      if (metrics.classList.contains("reorderMode")) return;
      const viewport = root.visualViewport;
      // A pinch zoom shrinks the visible height only while zoomed. Keep the
      // layout still until the page is back at its normal scale.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport ? Math.min(root.innerHeight, viewport.height) : root.innerHeight;
      const bottom = height - dockHeight - 8;
      // Measure document coordinates so scrolling to the history cannot change density.
      // The card never scrolls or clips its own details; when even the tight
      // step does not fit, the whole page scrolls instead.
      for (const density of DENSITIES) {
        doc.body.dataset.dashboardDensity = density;
        if (metrics.getBoundingClientRect().bottom + root.scrollY <= bottom) break;
      }
    }
    if (root.ResizeObserver) {
      const observer = new root.ResizeObserver(schedule);
      [dock, overview, metrics, doc.getElementById("hero"), doc.getElementById("questBrief")].filter(Boolean).forEach(element => observer.observe(element));
    }
    relayout = schedule;
    root.addEventListener("resize", schedule);
    root.addEventListener("pageshow", schedule);
    if (root.visualViewport) root.visualViewport.addEventListener("resize", schedule);
    doc.addEventListener("visibilitychange", () => { if (!doc.hidden) schedule(); });
    schedule();
  }

  function setupControls() {
    doc.querySelectorAll("button[data-theme-mode]").forEach(button => {
      button.addEventListener("click", () => save({ ...settings, mode: button.dataset.themeMode }));
    });
    const select = doc.getElementById("compactThemeMode");
    if (select) select.addEventListener("change", () => save({ ...settings, mode: select.value }));
    doc.querySelectorAll("button[data-skin-mode]").forEach(button => {
      button.addEventListener("click", () => saveSkin(button.dataset.skinMode));
    });
    const skinSelect = doc.getElementById("compactSkinMode");
    if (skinSelect) skinSelect.addEventListener("change", () => saveSkin(skinSelect.value));
    for (const [id, key] of [["themeLightStart", "lightStart"], ["themeDarkStart", "darkStart"]]) {
      const input = doc.getElementById(id);
      if (!input) continue;
      input.addEventListener("change", () => {
        const next = { ...settings, [key]: input.value };
        if (timeMinutes(input.value) === null || next.lightStart === next.darkStart) {
          input.value = settings[key];
          const note = doc.getElementById("themeScheduleNote");
          if (note) note.textContent = "ライトとダークには異なる開始時刻を指定してください。";
          return;
        }
        save(next);
      });
    }
    apply();
    setupDashboardLayout();
    setupRichMotion();
  }

  read();
  apply(); // Head script: select the theme before the first painted frame.
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", setupControls, { once: true });
  else setupControls();
  doc.addEventListener("visibilitychange", () => { if (!doc.hidden) read(); apply(); });
  root.addEventListener("pageshow", () => { read(); apply(); });
  root.addEventListener("focus", () => { read(); apply(); });
  root.addEventListener("storage", event => {
    if (event.key === STORAGE_KEY || event.key === SKIN_KEY || event.key === null) { read(); apply(); }
  });
  root.UberProgressAppearance = api;
})(typeof window !== "undefined" ? window : null);
