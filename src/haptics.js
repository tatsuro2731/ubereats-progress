(function(root) {
  "use strict";

  // Press feedback (a small knock from the phone) for the count buttons.
  // A device preference like the theme: its own key, never part of the
  // delivery/timer record.
  const STORAGE_KEY = "ubereatsProgressHapticsV1";
  const MODES = Object.freeze(["on", "off"]);
  const normalize = value => MODES.includes(value) ? value : MODES[0];
  // +1 is a double knock and -1 a single one, so the two can be told apart by feel.
  const TARGETS = Object.freeze([
    Object.freeze({ id: "plus", knocks: 2 }),
    Object.freeze({ id: "minus", knocks: 1 })
  ]);
  const PATTERNS = Object.freeze({ 1: Object.freeze([25]), 2: Object.freeze([25, 60, 25]) });
  const SECOND_KNOCK_DELAY = 110;

  // Android plays a pattern through the Vibration API. iPhone has no such API:
  // the only haptic a page can play there is the system tick of a native switch
  // control, so an invisible switch is laid over each button to take the tap.
  function strategy(nav, win) {
    if (nav && typeof nav.vibrate === "function") return "vibrate";
    const coarse = Boolean(win && typeof win.matchMedia === "function" && win.matchMedia("(pointer: coarse)").matches);
    return coarse ? "switch" : "none";
  }

  const api = { STORAGE_KEY, MODES, TARGETS, PATTERNS, SECOND_KNOCK_DELAY, normalize, strategy };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (!root || !root.document) return;

  const doc = root.document;
  const overlays = [];
  let mode = MODES[0];
  let helper = null;

  function read() {
    try { mode = normalize(root.localStorage.getItem(STORAGE_KEY)); } catch (_) { /* keep the current mode */ }
  }

  function apply() {
    // With the feature off the overlays leave the layout, so taps reach the buttons directly.
    for (const overlay of overlays) overlay.hidden = mode !== "on";
    doc.querySelectorAll("button[data-haptics-mode]").forEach(button => {
      const selected = button.dataset.hapticsMode === mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function save(next) {
    mode = normalize(next);
    try { root.localStorage.setItem(STORAGE_KEY, mode); } catch (_) { /* applied to this screen only */ }
    apply();
  }

  function createSwitch() {
    const input = doc.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.setAttribute("aria-hidden", "true");
    input.tabIndex = -1;
    // The label forwards the tap to this switch. Without this, the forwarded
    // click would bubble on to the button and count the press twice.
    for (const type of ["click", "input", "change"]) input.addEventListener(type, event => event.stopPropagation());
    return input;
  }

  // Up to iOS 26.4 a scripted toggle shortly after a tap still ticks, which turns
  // +1 into a double knock. From iOS 26.5 only the user's own tap ticks, so this
  // does nothing there and +1 stays a single knock.
  function secondKnock() {
    if (mode !== "on" || !doc.body) return;
    if (!helper) {
      helper = doc.createElement("label");
      helper.className = "hapticHelper";
      helper.hidden = true;
      helper.setAttribute("aria-hidden", "true");
      helper.appendChild(createSwitch());
      helper.addEventListener("click", event => event.stopPropagation());
      doc.body.appendChild(helper);
    }
    helper.click();
  }

  function coverWithSwitch(button, knocks) {
    const overlay = doc.createElement("label");
    overlay.className = "hapticTap";
    overlay.setAttribute("aria-hidden", "true");
    overlay.appendChild(createSwitch());
    overlay.addEventListener("click", event => {
      // The hold-to-repeat buttons cancel the click that follows a pointer press.
      // A cancelled click is not forwarded to the switch, so nothing would tick:
      // keep this click to ourselves and hand the button a click of its own.
      event.stopPropagation();
      button.click();
      if (knocks > 1) root.setTimeout(secondKnock, SECOND_KNOCK_DELAY);
    });
    button.classList.add("hapticHost");
    button.appendChild(overlay);
    overlays.push(overlay);
  }

  function vibrateOnPress(button, knocks) {
    button.addEventListener("click", () => {
      if (mode !== "on") return;
      try { root.navigator.vibrate(PATTERNS[knocks]); } catch (_) { /* feedback is optional */ }
    });
  }

  function setup() {
    const how = strategy(root.navigator, root);
    doc.documentElement.setAttribute("data-haptics", how);
    for (const target of TARGETS) {
      const button = doc.getElementById(target.id);
      if (!button) continue;
      if (how === "switch") coverWithSwitch(button, target.knocks);
      else if (how === "vibrate") vibrateOnPress(button, target.knocks);
    }
    doc.querySelectorAll("button[data-haptics-mode]").forEach(button => {
      button.addEventListener("click", () => save(button.dataset.hapticsMode));
    });
    apply();
  }

  read();
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", setup, { once: true });
  else setup();
  root.addEventListener("storage", event => {
    if (event.key === STORAGE_KEY || event.key === null) { read(); apply(); }
  });
  root.UberProgressHaptics = api;
})(typeof window !== "undefined" ? window : null);
