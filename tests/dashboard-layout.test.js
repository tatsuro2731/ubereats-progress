"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the real resize callbacks with measured-box fixtures. Pixel rendering
// is separate; these fixtures cover the fit budget and resize lifecycle.
function layoutHarness({ height = 956, top = 62, dockHeight = 188, footerHeight = 0, questHeight = 0, headerHeight = 0 } = {}) {
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
  const overviewHeights = { comfortable: 480, compact: 360, dense: 304, tight: 250 };
  const cardHeights = { comfortable: 274, compact: 228, dense: 212, tight: 206 };
  const density = () => body.dataset.dashboardDensity || "comfortable";
  const overview = {
    style: style(), scrollTop: 0,
    getBoundingClientRect() {
      const natural = overviewHeights[density()];
      const cap = Number.parseFloat(this.style.getPropertyValue("max-height"));
      const size = Number.isFinite(cap) ? Math.min(natural, cap) : natural;
      const start = top + questHeight + headerHeight - window.scrollY;
      return { top: start, height: size, bottom: start + size };
    }
  };
  let reorder = false;
  const metrics = {
    classList: { contains: () => reorder },
    getBoundingClientRect() {
      const start = overview.getBoundingClientRect().bottom + footerHeight;
      const size = cardHeights[density()];
      return { top: start, height: size, bottom: start + size };
    }
  };
  const dock = { getBoundingClientRect: () => ({ height: dockHeight }) };
  const hero = {};
  const questBrief = {};
  const elements = { operationDock: dock, dashboardOverview: overview, metrics, hero, questBrief };
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
    window, document, overview, metrics, dock, hero, questBrief, observed, body, storageWrites,
    frames, cardHeights, overviewHeights, emit, flush,
    notifyResize: () => observers.forEach(fn => fn()),
    setReorder: value => { reorder = value; },
    setQuestHeight(value) { questHeight = value; observers.forEach(fn => fn()); flush(); },
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

test("the tight step is used only when dense does not fit and keeps every detail", () => {
  const tight = layoutHarness({ height: 740 });
  assert.equal(tight.body.dataset.dashboardDensity, "tight");
  assert.ok(tight.cardsClearDock());
  assert.equal(tight.overview.style.getPropertyValue("max-height"), "");
  assert.equal(tight.overview.getBoundingClientRect().height, tight.overviewHeights.tight, "the details are shown in full");
  const dense = layoutHarness({ height: 800 });
  assert.equal(dense.body.dataset.dashboardDensity, "dense");
  assert.ok(dense.cardsClearDock());
});

test("when even the tight step cannot fit, the page scrolls instead of clipping the details", () => {
  const app = layoutHarness({ height: 650 });
  assert.equal(app.body.dataset.dashboardDensity, "tight");
  assert.equal(app.overview.style.getPropertyValue("max-height"), "", "the card never becomes its own scroll area");
  assert.equal(app.overview.getBoundingClientRect().height, app.overviewHeights.tight);
  assert.equal(app.cardsClearDock(), false, "the whole page scrolls the lower cards above the dock");
  app.setHeight(1100);
  assert.equal(app.body.dataset.dashboardDensity, "comfortable");
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
  for (const density of ["comfortable", "compact", "dense", "tight"]) app.cardHeights[density] += 160;
  app.notifyResize(); app.notifyResize();
  assert.equal(app.frames.length, 1, "multiple size notifications are batched into one frame");
  app.flush();
  assert.equal(app.body.dataset.dashboardDensity, "dense");
  assert.ok(app.cardsClearDock());
  app.window.visualViewport.height = 900;
  app.emit("viewport:resize"); app.flush();
  assert.equal(app.body.dataset.dashboardDensity, "tight");
  assert.ok(app.metrics.getBoundingClientRect().bottom <= 900 - 188 - 8);
  app.window.visualViewport.height = 956;
  app.emit("window:pageshow"); app.emit("document:visibilitychange");
  assert.equal(app.frames.length, 1);
  app.flush();
  assert.equal(app.body.dataset.dashboardDensity, "dense");
  assert.ok(app.cardsClearDock());
});

test("pinch zoom leaves the layout still until the page returns to its normal scale", () => {
  const app = layoutHarness();
  assert.equal(app.body.dataset.dashboardDensity, "compact");
  // While zoomed, iOS reports only the magnified visible area.
  app.window.visualViewport.scale = 2;
  app.window.visualViewport.height = 478;
  app.window.innerHeight = 478;
  app.emit("viewport:resize"); app.flush();
  app.notifyResize(); app.flush();
  assert.equal(app.body.dataset.dashboardDensity, "compact", "zooming must not reflow or clip the card");
  assert.equal(app.overview.style.getPropertyValue("max-height"), "");
  app.window.visualViewport.scale = 1;
  app.window.visualViewport.height = 956;
  app.window.innerHeight = 956;
  app.emit("viewport:resize"); app.flush();
  assert.equal(app.body.dataset.dashboardDensity, "compact");
  assert.ok(app.cardsClearDock());
});

test("reorder mode keeps the density still during a drag", () => {
  const app = layoutHarness({ height: 740 });
  assert.equal(app.body.dataset.dashboardDensity, "tight");
  app.setReorder(true);
  app.setHeight(1100);
  assert.equal(app.body.dataset.dashboardDensity, "tight", "cards must not move underneath the finger");
  assert.equal(app.overview.style.getPropertyValue("max-height"), "");
  app.setReorder(false);
  app.notifyResize(); app.flush();
  assert.equal(app.body.dataset.dashboardDensity, "comfortable");
  assert.ok(app.cardsClearDock());
});

test("a visible target-pace footer keeps its full height between the details and the cards", () => {
  for (const footerHeight of [28, 52]) {
    const app = layoutHarness({ height: 740, top: 164, footerHeight, questHeight: 52 });
    assert.equal(app.overview.style.getPropertyValue("max-height"), "");
    assert.equal(app.metrics.getBoundingClientRect().top - app.overview.getBoundingClientRect().bottom, footerHeight);
    assert.equal(app.overview.getBoundingClientRect().height, app.overviewHeights[app.body.dataset.dashboardDensity], "the details are shown in full");
    assert.deepEqual(app.storageWrites, []);
  }
});

test("showing or wrapping the quest summary remeasures the footer and card budget", () => {
  const app = layoutHarness({ height: 956, top: 164, footerHeight: 32 });
  assert.ok(app.observed.includes(app.questBrief));
  for (const [questHeight, density] of [[52, "tight"], [76, "tight"], [0, "dense"]]) {
    app.setQuestHeight(questHeight);
    assert.equal(app.body.dataset.dashboardDensity, density);
    assert.ok(app.cardsClearDock());
  }
});

test("the fixed count header fits with the footer, quest summary and two card rows when space permits", () => {
  for (const [height, density] of [[1000, "tight"], [1100, "compact"]]) {
    const app = layoutHarness({ height, top: 120, headerHeight: 110, footerHeight: 28, questHeight: 52 });
    assert.equal(app.body.dataset.dashboardDensity, density);
    assert.ok(app.cardsClearDock());
    assert.equal(app.overview.getBoundingClientRect().top, 282, "the details start below the count header");
    assert.equal(app.overview.style.getPropertyValue("max-height"), "");
    assert.deepEqual(app.storageWrites, []);
  }
});

test("on an impossibly short viewport the details stay complete and the page scrolls", () => {
  const app = layoutHarness({ height: 568, top: 160, headerHeight: 110, footerHeight: 28, questHeight: 76 });
  assert.equal(app.body.dataset.dashboardDensity, "tight");
  assert.equal(app.overview.style.getPropertyValue("max-height"), "");
  assert.equal(app.overview.getBoundingClientRect().height, app.overviewHeights.tight);
  assert.ok(app.metrics.getBoundingClientRect().height > 0);
  assert.equal(app.document.documentElement.style.getPropertyValue("--operation-dock-height"), "188px");
});

test("count label, buttons and progress bar stay outside the pace details, which never scroll by themselves", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const stack = [];
  const ancestors = new Map();
  for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    const [, close, tag, attributes] = match;
    if (close) { stack.splice(stack.findLastIndex(item => item.tag === tag)); continue; }
    const id = attributes.match(/\bid="([^"]+)"/)?.[1];
    if (id) ancestors.set(id, stack.map(item => item.id));
    if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)) stack.push({ tag, id });
  }
  for (const id of ["heroProgress", "heroDone", "heroTarget", "heroRemaining", "plus", "minus", "heroProgressTrack", "baselinePace"]) {
    assert.ok(ancestors.get(id).includes("hero"), `${id} remains within the hero card`);
    assert.ok(!ancestors.get(id).includes("dashboardOverview"), `${id} stays outside the pace details`);
  }
  for (const id of ["mainValue", "subValue", "miniValue"]) assert.ok(ancestors.get(id).includes("dashboardOverview"));
  assert.doesNotMatch(html, /id="dashboardOverview"[^>]*tabindex/, "nothing to scroll, so no extra focus stop");
  const appearance = fs.readFileSync(path.join(__dirname, "../styles/appearance.css"), "utf8");
  assert.doesNotMatch(appearance, /\.dashboardOverview\s*\{[^}]*overflow/, "touch and pinch gestures cannot scroll or clip the details");
  assert.match(appearance, /\[data-dashboard-density="tight"\] \.guideCaption \{ display: none; \}/);
  const css = fs.readFileSync(path.join(__dirname, "../styles/quest.css"), "utf8");
  assert.match(css, /@media\(max-width:440px\)\s*\{\s*\.questView \.questDateTimeFields\s*\{\s*grid-template-columns:minmax\(0,1fr\)/);
});
