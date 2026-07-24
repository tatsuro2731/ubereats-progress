"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

function normalizedAsset(value) {
  return value.replace(/^\.\//, "");
}

test("the first visit loads all enhancements directly from index.html", () => {
  const html = read("index.html");
  const expected = [
    "app-enhancements.js",
    "app-enhancements-fix.js",
    "app-session-ui-fix.js"
  ];
  const directScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/gi)]
    .map(match => match[1]);

  for (const name of expected) {
    assert.ok(
      directScripts.some(source => normalizedAsset(source).split("?")[0] === name),
      `${name} must be referenced by a script tag in index.html`
    );
  }

  const positions = expected.map(name => html.search(new RegExp(`<script\\b[^>]*src=["'][^"']*${name.replace(".", "\\.")}`)));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "enhancement scripts must retain dependency order");
  assert.ok(positions.every(position => position > 0 && position < html.lastIndexOf("</body>")));
});

test("the service worker cache revision and assets match direct script URLs", () => {
  const html = read("index.html");
  const compact = read("compact.html");
  const serviceWorker = read("sw.js");
  const cacheMatch = serviceWorker.match(/const\s+CACHE\s*=\s*["']ubereats-progress-v(\d+)["']/);
  assert.ok(cacheMatch, "sw.js must use a numbered ubereats-progress cache");
  const revision = Number(cacheMatch[1]);
  assert.ok(revision >= 37, "the cache revision must be bumped past the broken v36 deployment");
  assert.doesNotMatch(serviceWorker, /injectEnhancement|html\.replace\(\s*["']<\/body>/, "the service worker must not inject a second copy of direct scripts");

  const assetsMatch = serviceWorker.match(/const\s+ASSETS\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(assetsMatch, "sw.js must declare a static ASSETS array");
  const assets = JSON.parse(assetsMatch[1]).map(normalizedAsset);
  assert.ok(assets.includes(`?v=${revision}`), "the root navigation must carry the cache revision");
  assert.ok(assets.includes(`index.html?v=${revision}`), "index.html must carry the cache revision");
  assert.match(html, new RegExp(`serviceWorker\\.register\\(["']sw\\.js\\?v=${revision}["']\\)`));
  assert.match(compact, new RegExp(`serviceWorker\\.register\\(["']sw\\.js\\?v=${revision}["']\\)`));

  const directEnhancements = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']*app-(?:enhancements(?:-fix)?|session-ui-fix)\.js[^"']*)["'][^>]*><\/script>/gi)]
    .map(match => normalizedAsset(match[1]));
  assert.equal(directEnhancements.length, 3);
  for (const source of directEnhancements) {
    assert.ok(assets.includes(source), `${source} must be pre-cached exactly as referenced`);
  }
  assert.ok(assets.some(asset => asset.split("?")[0] === "compact.html"), "compact.html must remain available offline");
});

test("timer UI includes the 440px iPhone breakpoint and start-time editor hooks", () => {
  const source = read("app-session-ui-fix.js");
  assert.match(source, /datetime-local/);
  assert.match(source, /sessionStartAt/);
  assert.match(source, /\.remainSync/);
  assert.match(
    source,
    /@media\s*\(\s*max-width\s*:\s*(?:4[4-9]\d|5\d\d)px\s*\)[\s\S]{0,1800}\.remainSync/,
    "the responsive timer fix must cover a 440px-wide iPhone"
  );
  assert.match(source, /@media\s*\(\s*max-width\s*:\s*370px\s*\)/);
});

test("the maximum minute-only remaining-time label stays legible and fits from 320px through 440px", () => {
  const source = read("app-session-ui-fix.js");
  const baseColumns = source.match(/\.remainSync\s*\{[^}]*grid-template-columns\s*:\s*([^;]+);[^}]*gap\s*:\s*([^;}]+)/);
  const baseLabel = source.match(/\.remainSync \.remainBig\s*\{[^}]*font-size\s*:\s*([^;]+);[^}]*letter-spacing\s*:\s*([^;}]+)/);
  const wideBlock = source.match(/@media\s*\(\s*max-width\s*:\s*440px\s*\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*@media\s*\(\s*max-width\s*:\s*370px/);
  const narrowBlock = source.match(/@media\s*\(\s*max-width\s*:\s*370px\s*\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*`/);
  assert.ok(baseColumns, "the timer columns and gap must remain explicit");
  assert.ok(baseLabel, "the timer label size must remain explicit");
  assert.ok(wideBlock, "the 371–440px timer rules must remain explicit");
  assert.ok(narrowBlock, "the 320–370px two-row timer rules must remain explicit");
  assert.match(baseColumns[1], /clamp\(44px,11\.5vw,50px\)\s+minmax\(0,1fr\)\s+clamp\(44px,11\.5vw,50px\)/);
  assert.match(baseColumns[2], /clamp\(4px,1\.2vw,5px\)/);
  assert.match(baseLabel[1], /clamp\(24px,6\.5vw,26px\)/);
  assert.match(baseLabel[2], /-\.06em/);
  assert.match(wideBlock[1], /padding-left\s*:\s*0\s*;\s*padding-right\s*:\s*0/);
  assert.match(narrowBlock[1], /grid-template-columns\s*:\s*1fr\s+1fr/);
  assert.match(narrowBlock[1], /font-size\s*:\s*26px/);

  const clamp = (minimum, preferred, maximum) => Math.max(minimum, Math.min(preferred, maximum));
  const cases = [320, 350, 370, 371, 375, 390, 391, 393, 402, 430, 440];
  const conservativeLabelWidthEm = 7.5;
  for (const viewport of cases) {
    const twoRows = viewport <= 370;
    const bodyPadding = viewport <= 390 ? 8 : 12;
    const contentWidth = viewport - bodyPadding * 2 - 36 - 26;
    const buttonWidth = clamp(44, viewport * 0.115, 50);
    const gap = clamp(4, viewport * 0.012, 5);
    const textSlot = contentWidth - (twoRows ? 0 : buttonWidth * 2 + gap * 2);
    const fontSize = twoRows
      ? 26
      : clamp(24, viewport * 0.065, 26);
    const maximumLabelWidth = fontSize * conservativeLabelWidthEm;
    assert.ok(
      maximumLabelWidth <= textSlot,
      `残り 12時間59分 must fit at ${viewport}px (${maximumLabelWidth.toFixed(1)}px <= ${textSlot}px)`
    );
    assert.ok(twoRows ? fontSize >= 26 : fontSize >= 24, `the label must stay legible at ${viewport}px`);
    if (viewport === 393) assert.ok(fontSize >= 25.5, "the 393px label must match the screenshot scale");
  }
});

test("remaining and work-session displays stop at minutes while calculations keep sub-minute precision", () => {
  const index = read("index.html");
  const compact = read("compact.html");
  const enhancements = read("app-enhancements.js");
  assert.match(index, /function\s+remainingText\s*\([^)]*\)\s*\{[\s\S]{0,180}Math\.ceil/);
  assert.match(index, /function\s+elapsedText\s*\([^)]*\)\s*\{[\s\S]{0,180}Math\.floor/);
  assert.match(index, /countRemain"\)\.textContent\s*=\s*`残り \$\{remainingText\(remaining\)\}`/);
  assert.match(index, /todaySummaryWork"\)\.textContent\s*=\s*elapsedText\(used\)/);
  assert.match(index, /active\.label}まで\$\{remainingText\(effectiveRemain\)\}/);
  assert.match(compact, /Math\.ceil\(effective\.remainingMs\s*\/\s*60000\)/);
  assert.match(enhancements, /id="workActiveTime">0時間00分<\/strong>/);
  assert.match(enhancements, /id="workElapsedTime">0時間00分<\/strong>/);
  assert.doesNotMatch(enhancements, /id="(?:workActiveTime|workElapsedTime)"[^>]*>[^<]*秒/);
  assert.match(enhancements, /remainingMs/);
  assert.match(enhancements, /activeMs/);
});

test("the enhanced timer is continuous while ON and never requests location", () => {
  const enhancements = read("app-enhancements.js");
  const compact = read("compact.html");
  assert.match(enhancements, /const\s+COUNT_MODE\s*=\s*["']continuous-v1["']/);
  assert.match(enhancements, /const\s+USAGE_MODE\s*=\s*["']remaining-v1["']/);
  assert.match(compact, /const\s+USAGE_MODE\s*=\s*["']remaining-v1["']/);
  assert.match(enhancements, /clockState\.on\s*&&\s*!clockState\.breakOn\s*&&\s*!clockState\.sessionEndedAt/);
  assert.match(enhancements, /clockState\.remainingMs\s*-=?\s*consumed/);
  assert.match(enhancements, /WORK_LIMIT_MS\s*-\s*finite\(remainingMs/);
  assert.match(enhancements, /clockUsedMs\(\)\s*\/\s*elapsed\s*\*\s*100/);
  assert.match(enhancements, /sharedMode\s*=\s*clockState\.on\s*\?\s*["']otherCompany["']\s*:\s*["']break["']/);
  assert.match(enhancements, /clockState\.on\s*&&\s*clockState\.otherCompanyOn/);
  assert.match(enhancements, /id="workUberTime">0時間00分<\/strong>/);
  assert.match(enhancements, /id="workOtherCompanyTime">0時間00分<\/strong>/);
  assert.match(enhancements, /他社稼働中も残り時間をカウントしています/);
  assert.match(compact, /activeMs:\s*usedMsFromRemaining\(remainingMs\)/);
  assert.doesNotMatch(enhancements, /navigator\.geolocation|watchPosition|clearWatch/);
  assert.doesNotMatch(enhancements, /GPS|位置情報/);
  assert.match(enhancements, /案件の有無や移動状態は自動判定しません/);
});

test("the settings header is a dedicated swipe-to-close surface without taking over form scrolling", () => {
  const html = read("index.html");
  assert.match(html, /id="settingsDragArea"\s+class="settingsDragArea"/);
  assert.match(html, /\.settingsDragArea\{[^}]*touch-action:none[^}]*user-select:none/);
  assert.match(html, /settingsDragArea[\s\S]{0,1000}settingsSheetHeader/);
  assert.match(html, /function\s+setupSettingsSwipe\s*\([^)]*\)[\s\S]{0,900}pointerdown[\s\S]{0,900}pointercancel/);
  assert.match(html, /event\.target\.closest\("button,a,input,select,textarea,\[role='button'\]"\)/);
  assert.match(html, /\.settingsScroll\{overflow:auto[^}]*overscroll-behavior:contain/);
  assert.doesNotMatch(html, /\$\("settingsScroll"\)\.addEventListener\("pointerdown"/);
});

test("settings swipe rendering stays on the compositor path without per-move layout reads", () => {
  const html = read("index.html");
  const move = html.match(/function\s+continueSettingsSwipe\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(move, "the pointer move handler must remain inspectable");
  assert.match(html, /function\s+scheduleSettingsSwipeRender[\s\S]{0,500}requestSettingsSwipeFrame/);
  assert.match(move[1], /scheduleSettingsSwipeRender\(swipe\)/);
  assert.doesNotMatch(move[1], /getBoundingClientRect|settingsSwipeSheetHeight|settingsSwipeCloseDistance/);
  assert.doesNotMatch(move[1], /settingsBackdrop|opacity/);
  assert.match(html, /const\s+sheetHeight\s*=\s*settingsSwipeSheetHeight\(\)[\s\S]{0,700}closeDistance:\s*settingsSwipeCloseDistance\(sheetHeight\)/);
  assert.match(html, /style\.setProperty\("transform",\s*`translate3d/);
});

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.contains(name) : Boolean(force);
    if (next) this.add(name); else this.remove(name);
    return next;
  }
}

class FakeStyle {
  constructor() {
    this.values = new Map();
    this.writes = [];
  }
  setProperty(name, value) {
    const text = String(value);
    this.values.set(name, text);
    this.writes.push([name, text]);
  }
  removeProperty(name) { this.values.delete(name); }
  getPropertyValue(name) { return this.values.get(name) || ""; }
}

class FakeElement {
  constructor(id, height = 0) {
    this.id = id;
    this.hidden = false;
    this.inert = false;
    this.isConnected = true;
    this.offsetHeight = height;
    this.dataset = {};
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.capturedPointers = new Set();
    this.focusCount = 0;
    this.rectReadCount = 0;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type, extra = {}) {
    const event = {
      type,
      pointerId: 1,
      isPrimary: true,
      pointerType: "touch",
      button: 0,
      clientX: 100,
      clientY: 100,
      timeStamp: 0,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...extra
    };
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
    return event;
  }
  setPointerCapture(pointerId) { this.capturedPointers.add(pointerId); }
  hasPointerCapture(pointerId) { return this.capturedPointers.has(pointerId); }
  releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
  getBoundingClientRect() {
    this.rectReadCount += 1;
    return { height: this.offsetHeight };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  focus() { this.focusCount += 1; }
  closest() { return null; }
}

function instrumentedIndexSource() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, "index.html should keep one inline application script");
  const source = scripts[0][1];
  const setupAt = source.lastIndexOf("\nsetup();");
  assert.ok(setupAt > 0, "the test harness must stop before application setup");
  return `${source.slice(0, setupAt)}
globalThis.__settingsSwipeTestApi = {
  setupSettingsSwipe,
  setSettingsOpen,
  getSwipe: () => settingsSwipe,
  closeDistance: settingsSwipeCloseDistance
};`;
}

function settingsHarness({ reducedMotion = false } = {}) {
  const elements = new Map();
  const element = (id, height = 0) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id, height));
    return elements.get(id);
  };
  element("settingsLayer").hidden = true;
  element("settingsDialog", 800);
  const openButton = element("settingsOpen");
  const timers = new Map();
  const animationFrames = new Map();
  let nextTimer = 1;
  let nextAnimationFrame = 1;
  let animationFrameRequests = 0;
  const requestAnimationFrame = callback => {
    const id = nextAnimationFrame++;
    animationFrameRequests += 1;
    animationFrames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = id => animationFrames.delete(id);
  const document = {
    activeElement: openButton,
    body: element("body"),
    documentElement: { clientHeight: 800 },
    getElementById: id => element(id),
    addEventListener() {}
  };
  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    JSON,
    document,
    window: {
      matchMedia: () => ({ matches: reducedMotion }),
      requestAnimationFrame,
      cancelAnimationFrame
    },
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(instrumentedIndexSource(), context, { filename: "index.html" });
  const api = context.__settingsSwipeTestApi;
  api.setupSettingsSwipe();
  api.setSettingsOpen(true);
  return {
    api,
    element,
    area: element("settingsDragArea"),
    pendingAnimationFrames: () => animationFrames.size,
    animationFrameRequests: () => animationFrameRequests,
    runAnimationFrame(time = 16) {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      callbacks.forEach(callback => callback(time));
    },
    runTimers() {
      while (timers.size) {
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach(callback => callback());
      }
    }
  };
}

test("a downward swipe past the threshold closes settings and clears drag state", () => {
  const app = settingsHarness();
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  const move = app.area.dispatch("pointermove", { clientY: 210, timeStamp: 180 });
  assert.equal(move.defaultPrevented, true);
  assert.equal(app.pendingAnimationFrames(), 1);
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "");
  app.runAnimationFrame();
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "translate3d(0,110px,0)");
  assert.equal(app.element("settingsDialog").rectReadCount, 1);
  assert.equal(app.area.hasPointerCapture(1), true);

  app.area.dispatch("pointerup", { clientY: 210, timeStamp: 200 });
  assert.equal(app.pendingAnimationFrames(), 0);
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "translate3d(0,832px,0)");
  assert.equal(app.api.getSwipe(), null);
  assert.equal(app.element("settingsLayer").hidden, false, "the exit animation completes before hiding the modal");
  assert.equal(app.area.hasPointerCapture(1), false);
  app.runTimers();

  assert.equal(app.element("settingsLayer").hidden, true);
  assert.equal(app.element("appRoot").inert, false);
  assert.equal(app.element("settingsOpen").getAttribute("aria-expanded"), "false");
  assert.equal(app.element("settingsOpen").focusCount, 1, "focus returns to the settings button");
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "");
  assert.equal(app.element("settingsBackdrop").style.getPropertyValue("opacity"), "");
});

test("multiple pointer moves render only the newest position once per animation frame", () => {
  const app = settingsHarness();
  const sheet = app.element("settingsDialog");
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  app.area.dispatch("pointermove", { clientY: 120, timeStamp: 20 });
  app.area.dispatch("pointermove", { clientY: 155, timeStamp: 40 });
  app.area.dispatch("pointermove", { clientY: 180, timeStamp: 60 });

  assert.equal(app.animationFrameRequests(), 1);
  assert.equal(app.pendingAnimationFrames(), 1);
  assert.equal(sheet.style.getPropertyValue("transform"), "");
  assert.equal(sheet.rectReadCount, 1);

  app.runAnimationFrame();
  assert.equal(sheet.style.getPropertyValue("transform"), "translate3d(0,80px,0)");
  assert.equal(app.pendingAnimationFrames(), 0);
  assert.equal(sheet.rectReadCount, 1, "drag rendering must not trigger another layout measurement");

  app.area.dispatch("pointercancel", { clientY: 180, timeStamp: 70 });
  app.runTimers();
});

test("swipe height and close distance stay cached from pointer down through settling", () => {
  const app = settingsHarness();
  const sheet = app.element("settingsDialog");
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  assert.equal(app.api.getSwipe().sheetHeight, 800);
  assert.equal(app.api.getSwipe().closeDistance, 96);
  assert.equal(sheet.rectReadCount, 1);

  sheet.offsetHeight = 300;
  app.area.dispatch("pointermove", { clientY: 180, timeStamp: 200 });
  app.runAnimationFrame();
  app.area.dispatch("pointerup", { clientY: 180, timeStamp: 400 });
  assert.equal(sheet.rectReadCount, 1);
  app.runTimers();
  assert.equal(app.element("settingsLayer").hidden, false, "80px remains below the cached 96px threshold");

  const closing = settingsHarness();
  const closingSheet = closing.element("settingsDialog");
  closing.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  closingSheet.offsetHeight = 300;
  closing.area.dispatch("pointermove", { clientY: 197, timeStamp: 200 });
  closing.runAnimationFrame();
  closing.area.dispatch("pointerup", { clientY: 197, timeStamp: 400 });
  assert.equal(closingSheet.rectReadCount, 1);
  assert.equal(closingSheet.style.getPropertyValue("transform"), "translate3d(0,832px,0)");
  closing.runTimers();
  assert.equal(closing.element("settingsLayer").hidden, true);
});

test("pointer up cancels an unpainted frame before the exit transform is applied", () => {
  const app = settingsHarness();
  const sheet = app.element("settingsDialog");
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  app.area.dispatch("pointermove", { clientY: 140, timeStamp: 100 });
  assert.equal(app.pendingAnimationFrames(), 1);

  app.area.dispatch("pointerup", { clientY: 210, timeStamp: 200 });
  assert.equal(app.pendingAnimationFrames(), 0);
  assert.equal(sheet.style.getPropertyValue("transform"), "translate3d(0,832px,0)");
  app.runAnimationFrame();
  assert.equal(sheet.style.getPropertyValue("transform"), "translate3d(0,832px,0)");
  app.runTimers();
  assert.equal(app.element("settingsLayer").hidden, true);
});

test("a short slow drag snaps back without closing settings", () => {
  const app = settingsHarness();
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  app.area.dispatch("pointermove", { clientY: 145, timeStamp: 300 });
  app.runAnimationFrame();
  app.area.dispatch("pointerup", { clientY: 145, timeStamp: 330 });
  assert.equal(app.element("settingsLayer").hidden, false);
  app.runTimers();

  assert.equal(app.element("settingsLayer").hidden, false);
  assert.equal(app.api.getSwipe(), null);
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "");
  assert.equal(app.area.hasPointerCapture(1), false);
});

test("a short fast flick closes settings", () => {
  const app = settingsHarness();
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  app.area.dispatch("pointermove", { clientY: 140, timeStamp: 40 });
  app.area.dispatch("pointerup", { clientY: 140, timeStamp: 55 });
  app.runTimers();
  assert.equal(app.element("settingsLayer").hidden, true);
});

test("a short flick followed by a pause does not reuse stale velocity", () => {
  const app = settingsHarness();
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  app.area.dispatch("pointermove", { clientY: 135, timeStamp: 35 });
  assert.equal(app.pendingAnimationFrames(), 1);
  app.area.dispatch("pointerup", { clientY: 135, timeStamp: 300 });
  assert.equal(app.pendingAnimationFrames(), 0);
  app.runTimers();
  assert.equal(app.element("settingsLayer").hidden, false);
});

test("reduced motion closes immediately and still clears swipe visuals", () => {
  const app = settingsHarness({ reducedMotion: true });
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  app.area.dispatch("pointermove", { clientY: 210, timeStamp: 180 });
  app.area.dispatch("pointerup", { clientY: 210, timeStamp: 200 });

  assert.equal(app.element("settingsLayer").hidden, true);
  assert.equal(app.api.getSwipe(), null);
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "");
  assert.equal(app.element("settingsBackdrop").style.getPropertyValue("opacity"), "");
});

test("cancelled, upward, and horizontal gestures never close settings", () => {
  const app = settingsHarness();
  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 0 });
  app.area.dispatch("pointermove", { clientY: 220, timeStamp: 100 });
  app.area.dispatch("pointercancel", { clientY: 220, timeStamp: 110 });
  app.runTimers();
  assert.equal(app.element("settingsLayer").hidden, false);

  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 200, pointerId: 2 });
  app.area.dispatch("pointermove", { clientY: 70, timeStamp: 230, pointerId: 2 });
  assert.equal(app.api.getSwipe(), null);
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "");

  app.area.dispatch("pointerdown", { clientX: 100, clientY: 100, timeStamp: 300, pointerId: 3 });
  app.area.dispatch("pointermove", { clientX: 160, clientY: 115, timeStamp: 330, pointerId: 3 });
  assert.equal(app.api.getSwipe(), null);
  assert.equal(app.element("settingsLayer").hidden, false);
});

test("close controls are excluded and an external close cleans an active swipe", () => {
  const app = settingsHarness();
  const closeTarget = { closest: selector => selector.includes("button") ? app.element("settingsClose") : null };
  app.area.dispatch("pointerdown", { target: closeTarget, clientY: 100, timeStamp: 0 });
  assert.equal(app.api.getSwipe(), null);
  assert.equal(app.area.hasPointerCapture(1), false);

  app.area.dispatch("pointerdown", { clientY: 100, timeStamp: 10, pointerId: 4 });
  app.area.dispatch("pointermove", { clientY: 150, timeStamp: 60, pointerId: 4 });
  assert.ok(app.api.getSwipe());
  assert.equal(app.pendingAnimationFrames(), 1);
  app.api.setSettingsOpen(false);
  assert.equal(app.api.getSwipe(), null);
  assert.equal(app.pendingAnimationFrames(), 0);
  assert.equal(app.area.hasPointerCapture(4), false);
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "");
  app.runAnimationFrame();
  assert.equal(app.element("settingsDialog").style.getPropertyValue("transform"), "");

  app.api.setSettingsOpen(true);
  app.area.dispatch("pointerup", { clientY: 250, timeStamp: 100, pointerId: 4 });
  app.runTimers();
  assert.equal(app.element("settingsLayer").hidden, false, "an old pointer cannot close a reopened sheet");
});
