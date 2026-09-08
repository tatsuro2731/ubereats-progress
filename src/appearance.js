(function(root) {
  "use strict";

  // Appearance is a device preference, never part of the delivery/timer record.
  const STORAGE_KEY = "ubereatsProgressAppearanceV1";
  const DEFAULTS = Object.freeze({ mode: "auto", lightStart: "06:00", darkStart: "18:00" });

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

  const api = { STORAGE_KEY, DEFAULTS, timeMinutes, normalize, themeAt, nextCheckDelay };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (!root || !root.document) return;

  const doc = root.document;
  let settings = { ...DEFAULTS };
  let refreshTimer = null;
  let storageFailed = false;

  function read() {
    try {
      settings = normalize(JSON.parse(root.localStorage.getItem(STORAGE_KEY) || "null"));
      storageFailed = false;
    } catch (_) {
      // Blocked storage must not prevent the UI or its clock from starting.
    }
  }

  function updateControls() {
    doc.querySelectorAll("[data-theme-mode]").forEach(button => {
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
    const note = doc.getElementById("themeScheduleNote");
    if (note) note.textContent = storageFailed
      ? "この端末に設定を保存できませんでした。現在の画面には適用しています。"
      : `端末の時刻で ${settings.lightStart} にライト、${settings.darkStart} にダークへ切り替わります。`;
  }

  function apply() {
    const theme = themeAt(settings);
    doc.documentElement.setAttribute("data-theme", theme);
    doc.documentElement.setAttribute("data-theme-mode", settings.mode);
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#111815" : "#f0f7f3");
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

  function setupDashboardLayout() {
    const dock = doc.getElementById("operationDock");
    if (!dock) return;
    const overview = doc.getElementById("dashboardOverview");
    const metrics = doc.getElementById("metrics");
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      root.requestAnimationFrame(fit);
    };
    function fit() {
      pending = false;
      const dockHeight = Math.ceil(dock.getBoundingClientRect().height);
      doc.documentElement.style.setProperty("--operation-dock-height", `${dockHeight}px`);
      if (!overview || !metrics) return;
      // Do not move the cards underneath a drag, or compress the reorder handles.
      if (metrics.classList.contains("reorderMode")) {
        overview.style.removeProperty("max-height");
        return;
      }
      const scrollTop = overview.scrollTop;
      overview.style.removeProperty("max-height");
      const viewport = root.visualViewport;
      const height = viewport && viewport.scale === 1
        ? Math.min(root.innerHeight, viewport.height) : root.innerHeight;
      const bottom = height - dockHeight - 8;
      // Measure document coordinates so scrolling to the history cannot change density.
      for (const density of ["comfortable", "compact", "dense"]) {
        doc.body.dataset.dashboardDensity = density;
        if (metrics.getBoundingClientRect().bottom + root.scrollY <= bottom) break;
      }
      const cardRect = metrics.getBoundingClientRect();
      const overflow = cardRect.bottom + root.scrollY - bottom;
      if (overflow > 0) {
        // Only the hero's details scroll on short screens. Its target-pace footer
        // stays visible, outside this region. Subtract the measured overflow so
        // the footer, quest summary, borders and gaps all retain their space.
        const overviewHeight = overview.getBoundingClientRect().height;
        overview.style.setProperty("max-height", `${Math.max(44, Math.floor(overviewHeight - overflow))}px`);
      }
      overview.scrollTop = scrollTop;
    }
    if (root.ResizeObserver) {
      const observer = new root.ResizeObserver(schedule);
      [dock, overview, metrics, doc.getElementById("hero"), doc.getElementById("questBrief")].filter(Boolean).forEach(element => observer.observe(element));
    }
    root.addEventListener("resize", schedule);
    root.addEventListener("pageshow", schedule);
    if (root.visualViewport) root.visualViewport.addEventListener("resize", schedule);
    doc.addEventListener("visibilitychange", () => { if (!doc.hidden) schedule(); });
    schedule();
  }

  function setupControls() {
    doc.querySelectorAll("[data-theme-mode]").forEach(button => {
      button.addEventListener("click", () => save({ ...settings, mode: button.dataset.themeMode }));
    });
    const select = doc.getElementById("compactThemeMode");
    if (select) select.addEventListener("change", () => save({ ...settings, mode: select.value }));
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
  }

  read();
  apply(); // Head script: select the theme before the first painted frame.
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", setupControls, { once: true });
  else setupControls();
  doc.addEventListener("visibilitychange", () => { if (!doc.hidden) read(); apply(); });
  root.addEventListener("pageshow", () => { read(); apply(); });
  root.addEventListener("focus", () => { read(); apply(); });
  root.addEventListener("storage", event => {
    if (event.key === STORAGE_KEY || event.key === null) { read(); apply(); }
  });
  root.UberProgressAppearance = api;
})(typeof window !== "undefined" ? window : null);
