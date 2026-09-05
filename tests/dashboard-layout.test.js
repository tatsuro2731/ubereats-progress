"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the real resize callbacks with measured-box fixtures. Pixel rendering
// is separate; these fixtures cover the fit budget, scrolling and resize lifecycle.
function layoutHarness({ height = 956, top = 62, dockHeight = 188 } = {}) {
  const events = new Map();
  const frames = [];
  const observers = [];
  const observed = [];
  const addListener = (key, callback) => {
    if (!events.has(key)) events.set(key, []);
    events.get(key).push(callback);
  };
  const style = () => ({
    values: new Map(),
    setProperty(k, v) { this.values.set(k, v); },
    removeProperty(k) { this.values.delete(k); },
    getPropertyValue(k) { return this.values.get(k) || ""; }
  });
  const body = { dataset: {} };
  const documentElement = { style: style(), setAttribute() {} };
  const overviewHeights = { comfortable: 480, compact: 360, dense: 304 };
  const cardHeights = { comfortable: 274, compact: 228, dense: 212 };
  const density = () => body.dataset.dashboardDensity || "comfortable";
  const overview = {
    style: style(), scrollTop: 0,
    getBoundingClientRect() {
      const natural = overviewHeights[density()];
      const cap = Number.parseFloat(this.style.getPropertyValue("max-height"));
      const size = Number.isFinite(cap) ? Math.min(natural, cap) : natural;
      return { top: top - window.scrollY, height: size, bottom: top - window.scrollY + size };
    }
  };
  let reorder = false;
  const metrics = {
    classList: { contains: () => reorder },
    getBoundingClientRect() {
      const start = overview.getBoundingClientRect().bottom;
      const size = cardHeights[density()];
      return { top: start, height: size, bottom: start + size };
    }
  };
  const dock = { getBoundingClientRect: () => ({ height: dockHeight }) };
  const hero = {};
  const elements = { operationDock: dock, dashboardOverview: overview, metrics, hero };
  const deliveryData = '{"done":"21","unknown":"keep"}';
  const storageWrites = [];
  const document = {
    readyState: "loading", hidden: false, body, documentElement,
    getElementById: id => elements[id] || null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (name, fn) => addListener(`document:${name}`, fn)
  };
  const window = {
    document, innerHeight: height, scrollY: 0,
    visualViewport: { height, scale: 1, addEventListener: (name, fn) => addListener(`viewport:${name}`, fn) },
    localStorage: { getItem: key => key === "ubereatsProgressAppearanceV1" ? '{"mode":"dark"}' : deliveryData, setItem: (...args) => storageWrites.push(args) },
    setTimeout() {}, clearTimeout() {},
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener: (name, fn) => addListener(`window:${name}`, fn),
    ResizeObserver: class {
      constructor(fn) { observers.push(fn); }
      observe(element) { observed.push(element); }
    }
  };
  const emit = key => (events.get(key) || []).forEach(fn => fn({}));
  const flush = () => { const batch = frames.splice(0); batch.forEach(fn => fn()); };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/appearance.js"), "utf8"), { window });
  emit("document:DOMContentLoaded");
  flush();
  return {
    window, document, overview, metrics, dock, hero, observed, body, storageWrites,
    frames, cardHeights, overviewHeights, emit, flush,
    notifyResize: () => observers.forEach(fn => fn()),
    setReorder: value => { reorder = value; },
    setHeight(value) { window.innerHeight = value; window.visualViewport.height = value; emit("window:resize"); flush(); },
    cardsClearDock: () => metrics.getBoundingClientRect().bottom + window.scrollY <= window.innerHeight - dockHeight - 8
  };
}

test("two card rows fit above the dock including top and bottom safe areas", () => {
  const app = layoutHarness();
  assert.equal(app.body.dataset.dashboardDensity, "compact");
  assert.equal(app.overview.style.getPropertyValue("max-height"), "");
  assert.ok(app.cardsClearDock());
  assert.equal(app.document.documentElement.style.getPropertyValue("--operation-dock-height"), "188px");
  assert.deepEqual(app.storageWrites, [], "layout must never write preferences, deliveries or timers");
});

test("very short screens scroll the overview, then restore full spacing when enlarged", () => {
  const app = layoutHarness({ height: 650 });
  assert.ok(app.cardsClearDock());
  assert.ok(Number.parseFloat(app.overview.style.getPropertyValue("max-height")) >= 44);
  app.overview.scrollTop = 90;
  app.notifyResize(); app.flush();
  assert.equal(app.overview.scrollTop, 90, "remeasuring must preserve the user's overview scroll position");
  app.setHeight(1100);
  assert.equal(app.body.dataset.dashboardDensity, "comfortable");
  assert.equal(app.overview.style.getPropertyValue("max-height"), "");
  assert.ok(app.cardsClearDock());
});

test("scrolling to history does not incorrectly select a taller layout", () => {
  const app = layoutHarness();
  app.window.scrollY = 500;
  app.notifyResize(); app.flush();
  assert.equal(app.body.dataset.dashboardDensity, "compact");
  assert.ok(app.cardsClearDock());
});

test("changed card text, browser chrome and page resume all recompute available space", () => {
  const app = layoutHarness();
  assert.ok(app.observed.includes(app.hero));
  assert.ok(app.observed.includes(app.metrics));
  assert.ok(app.observed.includes(app.dock));
  for (const density of ["comfortable", "compact", "dense"]) app.cardHeights[density] += 160;
  app.notifyResize(); app.notifyResize();
  assert.equal(app.frames.length, 1, "multiple size notifications are batched into one frame");
  app.flush();
  assert.ok(app.cardsClearDock());
  app.window.visualViewport.height = 700;
  app.emit("viewport:resize"); app.flush();
  assert.ok(app.metrics.getBoundingClientRect().bottom <= 700 - 188 - 8);
  app.window.visualViewport.scale = 2;
  app.emit("viewport:resize"); app.flush();
  assert.ok(app.cardsClearDock(), "pinch zoom must not permanently compress the underlying layout");
  app.emit("window:pageshow"); app.emit("document:visibilitychange");
  assert.equal(app.frames.length, 1);
  app.flush();
  assert.ok(app.cardsClearDock());
});

test("reorder mode releases the overview limit without moving density during a drag", () => {
  const app = layoutHarness({ height: 650 });
  app.setReorder(true);
  app.notifyResize(); app.flush();
  assert.equal(app.overview.style.getPropertyValue("max-height"), "");
  assert.equal(app.body.dataset.dashboardDensity, "dense");
  app.setReorder(false);
  app.notifyResize(); app.flush();
  assert.ok(app.cardsClearDock());
});
