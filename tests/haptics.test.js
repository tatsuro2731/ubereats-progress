"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const haptics = require("../src/haptics.js");
const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");

// A minimal DOM: enough to observe which elements are created, where they are
// attached, and what each listener does with the event it receives.
function harness({ vibrate = false, coarse = true, stored = null, blocked = false, ids = ["plus", "minus"] } = {}) {
  const values = new Map(stored === null ? [] : [[haptics.STORAGE_KEY, stored]]);
  const writes = [];
  const vibrations = [];
  const timers = [];
  const created = [];
  const listeners = { window: {}, document: {} };
  function element(tag, id = "") {
    const node = {
      tag, id, children: [], attrs: {}, dataset: {}, events: {}, classes: new Set(), hidden: false, parent: null, clicks: 0,
      classList: { add: name => node.classes.add(name), toggle: (name, on) => { if (on) node.classes.add(name); else node.classes.delete(name); } },
      setAttribute: (name, value) => { node.attrs[name] = value; },
      addEventListener: (type, listener) => { (node.events[type] = node.events[type] || []).push(listener); },
      appendChild: child => { child.parent = node; node.children.push(child); return child; },
      // Runs this element's own listeners only; the tests check stopPropagation explicitly.
      dispatch(type, event = {}) {
        const record = { type, target: node, stopped: false, stopPropagation() { record.stopped = true; }, ...event };
        for (const listener of node.events[type] || []) listener(record);
        return record;
      },
      click() { node.clicks += 1; return node.dispatch("click"); }
    };
    Object.defineProperty(node, "className", { get: () => [...node.classes].join(" "), set: value => { node.classes = new Set(String(value).split(/\s+/).filter(Boolean)); } });
    return node;
  }
  const buttons = Object.fromEntries(ids.map(id => [id, element("button", id)]));
  const modeButtons = ["on", "off"].map(mode => { const node = element("button"); node.dataset.hapticsMode = mode; return node; });
  const root = element("html");
  const body = element("body");
  const document = {
    readyState: "loading", documentElement: root, body,
    createElement: tag => { const node = element(tag); created.push(node); return node; },
    getElementById: id => buttons[id] || null,
    querySelectorAll: selector => selector === "button[data-haptics-mode]" ? modeButtons : [],
    addEventListener: (type, listener) => { listeners.document[type] = listener; }
  };
  const window = {
    document,
    navigator: vibrate ? { vibrate: pattern => { vibrations.push([...pattern]); return true; } } : {},
    matchMedia: query => ({ matches: query === "(pointer: coarse)" && coarse }),
    localStorage: {
      getItem: key => { if (blocked) throw new Error("blocked"); return values.has(key) ? values.get(key) : null; },
      setItem: (key, value) => { if (blocked) throw new Error("blocked"); writes.push(key); values.set(key, value); }
    },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    addEventListener: (type, listener) => { listeners.window[type] = listener; }
  };
  vm.runInNewContext(read("src/haptics.js"), { window, module: undefined });
  listeners.document.DOMContentLoaded();
  return { window, document, root, body, buttons, modeButtons, created, values, writes, vibrations, timers, listeners, overlay: id => buttons[id].children.find(child => child.classes.has("hapticTap")) };
}

test("the saved choice is on or off, defaults to on, and lives in its own key", () => {
  assert.equal(haptics.normalize(null), "on");
  assert.equal(haptics.normalize("off"), "off");
  assert.equal(haptics.normalize("loud"), "on");
  assert.match(haptics.STORAGE_KEY, /^ubereatsProgressHapticsV1$/);
  assert.deepEqual(haptics.TARGETS.map(target => [target.id, target.knocks]), [["plus", 2], ["minus", 1]], "+1 and -1 feel different");
});

test("the method follows what the device offers: vibration, an overlaid switch, or nothing", () => {
  assert.equal(haptics.strategy({ vibrate() {} }, { matchMedia: () => ({ matches: true }) }), "vibrate");
  assert.equal(haptics.strategy({}, { matchMedia: () => ({ matches: true }) }), "switch", "iPhone: no Vibration API, touch screen");
  assert.equal(haptics.strategy({}, { matchMedia: () => ({ matches: false }) }), "none", "desktop Safari gets no overlay");
  assert.equal(haptics.strategy(undefined, undefined), "none");
});

test("iPhone: each count button is covered by an invisible label holding a native switch", () => {
  const app = harness();
  assert.equal(app.root.attrs["data-haptics"], "switch");
  assert.equal(app.writes.length, 0, "starting up saves nothing");
  for (const id of ["plus", "minus"]) {
    const overlay = app.overlay(id);
    assert.ok(overlay, `${id} has an overlay`);
    assert.equal(overlay.tag, "label");
    assert.equal(overlay.attrs["aria-hidden"], "true");
    assert.equal(overlay.hidden, false);
    assert.ok(app.buttons[id].classes.has("hapticHost"));
    const [input] = overlay.children;
    assert.equal(input.tag, "input");
    assert.equal(input.type, "checkbox");
    assert.equal(input.attrs.switch, "", "the switch attribute is what makes iOS tick");
    assert.equal(input.tabIndex, -1);
  }
});

test("iPhone: a tap counts exactly once and leaves the tap uncancelled for the switch", () => {
  const app = harness();
  let counted = 0;
  app.buttons.plus.addEventListener("click", () => { counted += 1; });
  const overlay = app.overlay("plus");
  const tap = overlay.dispatch("click");
  assert.equal(tap.stopped, true, "handlers above the label cannot cancel the tap before it reaches the switch");
  assert.equal(counted, 1, "the button receives one click of its own");
  // The label then forwards the tap to its switch; that click must not travel on to the button.
  for (const type of ["click", "input", "change"]) assert.equal(overlay.children[0].dispatch(type).stopped, true, `the switch keeps its ${type} to itself`);
  assert.equal(counted, 1);
});

test("iPhone: +1 asks for a second knock, -1 does not, and the helper never reaches the buttons", () => {
  const app = harness();
  app.overlay("minus").dispatch("click");
  assert.equal(app.timers.length, 0);
  app.overlay("plus").dispatch("click");
  assert.deepEqual(app.timers.map(timer => timer.delay), [haptics.SECOND_KNOCK_DELAY]);
  const before = app.buttons.plus.clicks;
  app.timers[0].callback();
  const helper = app.body.children.find(child => child.classes.has("hapticHelper"));
  assert.ok(helper, "the second knock uses a separate hidden switch");
  assert.equal(helper.hidden, true);
  assert.equal(helper.clicks, 1);
  assert.equal(helper.children[0].attrs.switch, "");
  assert.equal(helper.dispatch("click").stopped, true);
  assert.equal(app.buttons.plus.clicks, before, "the second knock does not press the button again");
  app.timers[0].callback();
  assert.equal(app.body.children.filter(child => child.classes.has("hapticHelper")).length, 1, "the helper is reused");
});

test("turning it off removes the overlays, saves only the haptics key, and skips the second knock", () => {
  const app = harness();
  app.modeButtons[1].dispatch("click");
  assert.deepEqual(app.writes, [haptics.STORAGE_KEY]);
  assert.equal(app.values.get(haptics.STORAGE_KEY), "off");
  assert.equal(app.overlay("plus").hidden, true);
  assert.equal(app.overlay("minus").hidden, true);
  assert.equal(app.modeButtons[1].attrs["aria-pressed"], "true");
  assert.equal(app.modeButtons[0].attrs["aria-pressed"], "false");
  assert.ok(app.modeButtons[1].classes.has("active") && !app.modeButtons[0].classes.has("active"));
  app.timers.length = 0;
  app.overlay("plus").dispatch("click");
  app.timers.forEach(timer => timer.callback());
  assert.equal(app.body.children.length, 0, "no helper switch is created while off");
  app.modeButtons[0].dispatch("click");
  assert.equal(app.overlay("plus").hidden, false);
});

test("the choice is restored on launch and follows a change made on the other page", () => {
  const app = harness({ stored: "off" });
  assert.equal(app.overlay("plus").hidden, true);
  assert.equal(app.modeButtons[1].attrs["aria-pressed"], "true");
  assert.equal(app.writes.length, 0);
  app.values.set(haptics.STORAGE_KEY, "on");
  app.listeners.window.storage({ key: haptics.STORAGE_KEY });
  assert.equal(app.overlay("plus").hidden, false);
  app.values.set(haptics.STORAGE_KEY, "off");
  app.listeners.window.storage({ key: "ubereatsProgressAppearanceV1" });
  assert.equal(app.overlay("plus").hidden, false, "unrelated keys are ignored");
});

test("Android: presses vibrate with a pattern per button and add no overlay", () => {
  const app = harness({ vibrate: true });
  assert.equal(app.root.attrs["data-haptics"], "vibrate");
  assert.equal(app.created.length, 0, "no switch is created where the Vibration API exists");
  app.buttons.plus.click();
  app.buttons.minus.click();
  assert.deepEqual(app.vibrations, [[25, 60, 25], [25]]);
  app.modeButtons[1].dispatch("click");
  app.buttons.plus.click();
  assert.equal(app.vibrations.length, 2, "off means silent");
});

test("blocked storage and missing buttons never stop the page", () => {
  const blocked = harness({ blocked: true });
  blocked.modeButtons[1].dispatch("click");
  assert.equal(blocked.overlay("plus").hidden, true, "the choice still applies to this screen");
  const partial = harness({ ids: ["plus"] });
  assert.ok(partial.overlay("plus"));
  const desktop = harness({ coarse: false });
  assert.equal(desktop.root.attrs["data-haptics"], "none");
  assert.equal(desktop.created.length, 0);
});

test("both pages load the module, the overlay styles exist, and delivery data is untouched", () => {
  for (const page of [read("index.html"), read("compact.html")]) assert.match(page, /<script defer src="src\/haptics\.js\?v=\d+"><\/script>/);
  assert.match(read("sw.js"), /"src\/haptics\.js\?v=\d+"/);
  const css = read("styles/appearance.css");
  assert.match(css, /\.hapticTap \{[^}]*position: absolute; inset: -1px;[^}]*opacity: 0;/, "the overlay covers the whole button including its border");
  assert.match(css, /\.hapticTap\[hidden\], \.hapticHelper \{ display: none; \}/);
  assert.match(css, /\.hapticTap input \{[^}]*pointer-events: none;/, "the finger must land on the label, not on the switch itself");
  const source = read("src/haptics.js");
  assert.equal((source.match(/localStorage\.setItem\(/g) || []).length, 1);
  assert.match(source, /localStorage\.setItem\(STORAGE_KEY, mode\)/);
  assert.match(read("index.html"), /data-haptics-mode="on"[^>]*>ON<\/button><button type="button" data-haptics-mode="off"/);
});
