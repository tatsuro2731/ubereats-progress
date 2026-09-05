"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const appearance = require("../src/appearance.js");
const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const at = (h, m = 0, s = 0) => new Date(2026, 8, 6, h, m, s);

test("automatic theme uses local time and includes the exact six/eighteen boundaries", () => {
  for (const [hour, minute, expected] of [[0, 0, "dark"], [5, 59, "dark"], [6, 0, "light"], [17, 59, "light"], [18, 0, "dark"], [23, 59, "dark"]]) {
    assert.equal(appearance.themeAt({}, at(hour, minute)), expected);
  }
});

test("manual themes stay fixed, custom minute schedules and midnight wrap work", () => {
  assert.equal(appearance.themeAt({ mode: "light" }, at(23)), "light");
  assert.equal(appearance.themeAt({ mode: "dark" }, at(12)), "dark");
  const settings = { mode: "auto", lightStart: "07:15", darkStart: "19:30" };
  assert.equal(appearance.themeAt(settings, at(7, 14)), "dark");
  assert.equal(appearance.themeAt(settings, at(7, 15)), "light");
  assert.equal(appearance.themeAt(settings, at(19, 30)), "dark");
  const overnight = { mode: "auto", lightStart: "20:00", darkStart: "05:00" };
  assert.equal(appearance.themeAt(overnight, at(23)), "light");
  assert.equal(appearance.themeAt(overnight, at(4, 59)), "light");
  assert.equal(appearance.themeAt(overnight, at(5)), "dark");
});

test("invalid saved preferences fall back safely and boundary checks do not busy-loop", () => {
  for (const bad of ["24:00", "06:60", "6:00", "", null, 600]) assert.equal(appearance.timeMinutes(bad), null);
  assert.deepEqual(appearance.normalize(null), appearance.DEFAULTS);
  assert.deepEqual(appearance.normalize({ mode: "unknown", lightStart: "11:00", darkStart: "11:00" }), appearance.DEFAULTS);
  assert.ok(appearance.nextCheckDelay({}, at(17, 59, 59)) <= 1010);
  assert.ok(appearance.nextCheckDelay({}, at(18)) >= 1000);
});

function browserHarness({ now = at(17, 59, 59).getTime(), blocked = false } = {}) {
  const values = new Map([
    ["ubereatsProgressFixed12Data", '{"done":"21","unknown":"keep"}'],
    ["ubereatsProgressMovementClockV1", '{"remainingMs":1234567}'],
    ["ubereatsProgressWorkHistoryV1", '[{"done":20}]']
  ]);
  const writes = [];
  const listeners = new Map();
  const timers = new Map();
  const elements = new Map();
  let timerId = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", disabled: false, dataset: {}, attrs: {}, events: {},
      classList: { toggle() {} },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, callback) { this.events[k] = callback; }
    });
    return elements.get(id);
  };
  const buttons = ["auto", "light", "dark"].map(mode => {
    const e = element(mode); e.dataset.themeMode = mode; return e;
  });
  const document = {
    hidden: false, readyState: "loading", activeElement: null,
    documentElement: element("root"),
    querySelector: () => element("meta"),
    querySelectorAll: () => buttons,
    getElementById: id => id === "operationDock" ? null : element(id),
    addEventListener: (name, fn) => listeners.set(`document:${name}`, fn)
  };
  const window = {
    document,
    localStorage: {
      getItem(key) { if (blocked) throw new Error("blocked"); return values.get(key) || null; },
      setItem(key, value) { if (blocked) throw new Error("blocked"); values.set(key, value); writes.push(key); }
    },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(`window:${name}`, fn)
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  vm.runInNewContext(read("src/appearance.js"), { window, Date: FakeDate });
  const emit = (name, event = {}) => listeners.get(name)?.(event);
  return { values, writes, timers, document, element, emit, setNow: value => { now = value; } };
}

test("theme applies before DOM ready, crosses a boundary and never writes delivery state", () => {
  const app = browserHarness();
  const before = [...app.values];
  assert.equal(app.element("root").attrs["data-theme"], "light");
  assert.equal(app.writes.length, 0);
  app.setNow(at(18).getTime());
  [...app.timers.values()][0].fn();
  assert.equal(app.element("root").attrs["data-theme"], "dark");
  assert.deepEqual([...app.values], before);
  assert.equal(app.timers.size, 1);
});

test("manual selection persists separately, synchronizes across tabs and stops auto checks", () => {
  const app = browserHarness();
  app.emit("document:DOMContentLoaded");
  app.element("light").events.click();
  assert.equal(app.element("root").attrs["data-theme"], "light");
  assert.deepEqual(app.writes, [appearance.STORAGE_KEY]);
  assert.equal(app.timers.size, 0);
  app.values.set(appearance.STORAGE_KEY, JSON.stringify({ mode: "dark" }));
  app.emit("window:storage", { key: appearance.STORAGE_KEY });
  assert.equal(app.element("root").attrs["data-theme"], "dark");
  assert.equal(app.element("compactThemeMode").value, "dark");
  assert.equal(app.element("themeLightStart").disabled, true);
});

test("returning from background or BFCache updates time without duplicate timers", () => {
  const app = browserHarness();
  app.document.hidden = true;
  app.emit("document:visibilitychange");
  assert.equal(app.timers.size, 0);
  app.setNow(at(19).getTime());
  app.document.hidden = false;
  app.emit("document:visibilitychange");
  assert.equal(app.element("root").attrs["data-theme"], "dark");
  app.setNow(at(9).getTime());
  app.emit("window:pageshow");
  assert.equal(app.element("root").attrs["data-theme"], "light");
  assert.equal(app.timers.size, 1);
});

test("invalid schedule edits are rejected, valid edits persist and storage failures do not crash", () => {
  const app = browserHarness();
  app.emit("document:DOMContentLoaded");
  app.element("themeLightStart").value = "18:00";
  app.element("themeLightStart").events.change();
  assert.equal(app.writes.length, 0);
  assert.equal(app.element("themeLightStart").value, "06:00");
  app.element("themeLightStart").value = "08:30";
  app.element("themeLightStart").events.change();
  assert.equal(JSON.parse(app.values.get(appearance.STORAGE_KEY)).lightStart, "08:30");
  const blocked = browserHarness({ blocked: true });
  blocked.emit("document:DOMContentLoaded");
  blocked.element("dark").events.click();
  assert.equal(blocked.element("root").attrs["data-theme"], "dark");
  assert.match(blocked.element("themeScheduleNote").textContent, /保存できません/);
});

test("each card uses a semantic sprite and a shared optical icon slot", () => {
  const icons = read("assets/ui-icons.svg");
  const main = read("src/main-app.js");
  for (const id of ["actualPace", "need", "eta", "workRate", "remaining", "elapsed", "safe", "targetPace", "project12", "constraint", "scooter", "swap"]) {
    assert.match(icons, new RegExp(`<symbol id="${id}"`));
  }
  assert.match(main, /icon\.repeat\(count\)/, "single/double repeat exactly the same scooter");
  assert.match(main, /class="metricIconSlot" aria-hidden="true"/);
  const css = read("styles/appearance.css");
  assert.match(css, /\.metricIconSlot\s*\{[^}]*width: 24px; height: 24px/);
  assert.match(css, /data-card-id="workRate"[^}]*width: 19px; height: 19px/);
  assert.match(css, /\.bike\s*\{[^}]*flex: 0 0 26px; width: 26px; height: 24px/);
});

test("main page has one copy of every control and the dock reserves its measured height", () => {
  const html = read("index.html");
  for (const id of ["plus", "minus", "countToggle", "countDot", "countStatus", "countRemain", "remainMinus", "remainPlus"]) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, "g"))].length, 1, id);
  }
  assert.ok(html.indexOf('src/appearance.js') < html.indexOf('rel="stylesheet"'));
  assert.match(html, /id="operationDock"/);
  assert.match(read("src/appearance.js"), /ResizeObserver/);
  assert.match(read("styles/appearance.css"), /padding-bottom: calc\(var\(--operation-dock-height\) \+ 20px\)/);
});
