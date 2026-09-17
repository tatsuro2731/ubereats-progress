"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../src/app-core.js");

const ROOT = path.resolve(__dirname, "..");
const at = value => Date.parse(`${value}+09:00`);
const BOUNDARY = at("2026-09-18T04:00:00");
const QUEST_KEY = core.QUEST_STORAGE_KEY;
const PROGRESS_KEY = core.STORAGE_KEYS.progress;

function quest(id, startAt, endAt, overrides = {}) {
  const item = { id, startAt, endAt, boundaryMinutes: 240, tiers: [{ target: 100, reward: 9000 }], goalIndex: 0, adjustments: {}, sales: {}, ...overrides };
  item.workDays = core.questDateKeys(item);
  return item;
}

function periods() {
  return [
    quest("past", at("2026-09-11T04:00:00"), at("2026-09-14T04:00:00")),
    quest("weekday", at("2026-09-14T04:00:00"), BOUNDARY, { sales: { "2026-09-17": 12345 } }),
    quest("weekend", BOUNDARY, at("2026-09-21T04:00:00"), { tiers: [{ target: 60, reward: 5000 }] })
  ];
}

function stateFor(quests = periods()) {
  return { ...core.createQuestState(7, BOUNDARY - 3600000), selectedId: "past", quests,
    sequence: 1, entries: [{ id: 1, epoch: 0, at: BOUNDARY - 3600000, quantity: 7 }], futureField: { keep: true } };
}

// Execute the shipped scripts unchanged. This small DOM only supports their
// event/data contracts; these tests do not substitute for browser UI checks.
function harness({ state = stateFor(), now = BOUNDARY - 1, compact = false } = {}) {
  let time = now;
  let timerId = 0;
  let writes = 0;
  const timers = new Map();
  const intervals = new Map();
  const toggles = new Set();
  const alerts = [];
  const storage = new Map([
    [QUEST_KEY, JSON.stringify(state)],
    [PROGRESS_KEY, JSON.stringify({ done: "7", target: "46", remainH: "9", remainM: "31", futureField: "keep" })]
  ]);
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      for (const callback of this.listeners.get(event.type) || []) callback(event);
      return true;
    }
  }
  class Event {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
    preventDefault() { this.defaultPrevented = true; }
  }
  const document = new Events();
  class Element extends Events {
    constructor(tagName = "div", id = "") {
      super();
      Object.assign(this, { tagName, id, hidden: false, value: "", textContent: "", children: [], dataset: {}, style: {}, attributes: {}, checked: false, _open: false });
      this.classList = { toggle() {} };
    }
    set open(value) { if (this._open !== Boolean(value)) { this._open = Boolean(value); toggles.add(this); } }
    get open() { return this._open; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = [...children]; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [child, ...(child.querySelectorAll?.("*") || [])])
        .filter(child => selector === "*" || child.tagName === selector);
    }
    focus() { document.activeElement = this; }
  }
  const elements = new Map();
  const html = fs.readFileSync(path.join(ROOT, compact ? "compact.html" : "index.html"), "utf8");
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1], match[2]);
    element.hidden = /\shidden(?:\s|>|=)/.test(match[0]);
    elements.set(element.id, element);
  }
  document.body = new Element("body");
  document.activeElement = document.body;
  document.hidden = false;
  document.getElementById = id => elements.get(id) || null;
  document.createElement = tag => new Element(tag);
  document.createTextNode = text => ({ textContent: text });
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const window = new Events();
  Object.assign(window, {
    window, document, Event, CustomEvent: Event, Date: FakeDate,
    location: { hash: "#quest", pathname: compact ? "/compact.html" : "/", search: "" },
    history: { replaceState() {} },
    alert: message => alerts.push(message),
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)); writes += 1; },
      removeItem: key => { storage.delete(key); writes += 1; }
    },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => { const id = ++timerId; intervals.set(id, callback); return id; }
  });
  const context = vm.createContext(window);
  for (const name of ["app-core.js", "quest-store.js", "quest-ui.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "src", name), "utf8"), context, { filename: `src/${name}` });
  }
  function flushToggles() {
    let count = 0;
    while (toggles.size) {
      assert.ok(++count < 20, "details toggle handlers must settle");
      const pending = [...toggles]; toggles.clear();
      pending.forEach(element => element.dispatchEvent(new Event("toggle")));
    }
  }
  const element = id => { assert.ok(elements.has(id), `Missing real HTML element: ${id}`); return elements.get(id); };
  function emit(target, type, options) { target.dispatchEvent(new Event(type, options)); flushToggles(); }
  flushToggles();
  return {
    element, storage, alerts, document, timers, writes: () => writes,
    read: () => JSON.parse(storage.get(QUEST_KEY)),
    selected: () => element("questSelect").value,
    emitWindow: (type, options) => emit(window, type, options),
    emitDocument: type => emit(document, type),
    emit: (id, type) => emit(element(id), type),
    choose(id) { element("questSelect").value = id; emit(element("questSelect"), "change"); },
    details(open) { element("questAlignDetails").open = open; flushToggles(); },
    periodic() { [...intervals.values()].forEach(callback => callback()); flushToggles(); },
    setTime(value) { time = value; },
    advanceTo(value) {
      time = value;
      let count = 0;
      for (;;) {
        const due = [...timers.entries()].find(([, timer]) => timer.at <= time);
        if (!due) break;
        assert.ok(++count < 20, "boundary timers must settle");
        timers.delete(due[0]); due[1].callback(); flushToggles();
      }
    }
  };
}

test("currentQuest selects the active period at the exact cutoff without mutating its input", () => {
  const quests = periods().reverse();
  const before = JSON.stringify(quests);
  assert.equal(core.currentQuest(quests, BOUNDARY - 1).id, "weekday");
  assert.equal(core.currentQuest(quests, BOUNDARY).id, "weekend");
  assert.equal(JSON.stringify(quests), before);
});

test("currentQuest picks the closest future period, then the latest ended period, or no period", () => {
  const quests = periods().reverse();
  assert.equal(core.currentQuest(quests, at("2026-09-10T12:00:00")).id, "past");
  const gap = [quests[0], quests[2]];
  assert.equal(core.currentQuest(gap, at("2026-09-15T12:00:00")).id, "weekend");
  assert.equal(core.currentQuest(quests, at("2026-09-22T12:00:00")).id, "weekend");
  assert.equal(core.currentQuest([], BOUNDARY), undefined);
});

test("startup ignores an old saved selection and automatic rendering never rewrites saved data", () => {
  const state = stateFor();
  const app = harness({ state });
  const progressBefore = app.storage.get(PROGRESS_KEY);
  assert.equal(app.selected(), "weekday");
  assert.equal(app.element("questPhase").textContent, "進行中");
  assert.equal([...app.timers.values()][0].at, BOUNDARY);
  app.advanceTo(BOUNDARY);
  assert.equal(app.selected(), "weekend");
  assert.equal(app.element("questTotal").textContent, "0");
  assert.equal(app.element("questGoal").textContent, "/ 60件");
  assert.equal(app.element("questSalesDay").value, "2026-09-18");
  assert.equal(app.element("questSalesInput").value, "");
  assert.equal(app.storage.get(QUEST_KEY), JSON.stringify(state));
  assert.equal(app.storage.get(PROGRESS_KEY), progressBefore);
  assert.equal(app.writes(), 0);
});

test("manual history viewing survives refreshes but releases at the next period boundary", () => {
  const app = harness();
  app.choose("past");
  app.periodic();
  app.emitWindow("questchange");
  app.emitWindow("storage", { key: QUEST_KEY });
  assert.equal(app.selected(), "past");
  assert.equal(app.element("questPhase").textContent, "期間終了");
  app.advanceTo(BOUNDARY);
  assert.equal(app.selected(), "weekend");
  assert.equal(app.writes(), 0);
});

test("returning to the quest tab or its summary opens the automatic current period", () => {
  for (const entry of ["questTab", "questBrief"]) {
    const app = harness();
    app.choose("past");
    app.emit("progressTab", "click");
    app.emit(entry, "click");
    assert.equal(app.selected(), "weekday");
    assert.equal(app.element("questView").hidden, false);
  }
});

test("foreground recovery switches periods even when no background boundary timer fired", () => {
  for (const event of ["visibilitychange", "pageshow", "focus"]) {
    const app = harness();
    app.document.hidden = true;
    app.emitDocument("visibilitychange");
    assert.equal(app.timers.size, 0);
    app.setTime(BOUNDARY + 60000);
    assert.equal(app.selected(), "weekday");
    app.document.hidden = false;
    if (event === "visibilitychange") app.emitDocument(event); else app.emitWindow(event);
    assert.equal(app.selected(), "weekend", event);
    assert.equal(app.writes(), 0);
  }
});

test("upcoming quests become active at their start and absent next registrations keep ended history", () => {
  const quests = periods();
  const upcoming = harness({ state: stateFor([quests[2]]), now: BOUNDARY - 1 });
  assert.equal(upcoming.selected(), "weekend");
  assert.equal(upcoming.element("questPhase").textContent, "開始前");
  assert.equal(upcoming.element("questBrief").hidden, true);
  upcoming.advanceTo(BOUNDARY);
  assert.equal(upcoming.element("questPhase").textContent, "進行中");
  assert.equal(upcoming.element("questBrief").hidden, false);

  const ended = harness({ state: stateFor(quests.slice(0, 2)) });
  ended.advanceTo(BOUNDARY);
  assert.equal(ended.selected(), "weekday");
  assert.equal(ended.element("questPhase").textContent, "期間終了");
  assert.match(ended.element("questAutoNotice").textContent, /次のクエストを登録/);
  assert.equal(ended.element("questBrief").hidden, true);
  assert.equal(ended.read().quests.length, 2, "no new terms or reward levels may be invented");

  const empty = harness({ state: stateFor([]) });
  assert.equal(empty.element("questEmpty").hidden, false);
  assert.equal(empty.element("questContent").hidden, true);
  assert.equal(empty.timers.size, 0);
});

test("normal and compact summaries use the active period and switch at the same instant", () => {
  const normal = harness();
  const compact = harness({ compact: true });
  normal.choose("past");
  assert.match(normal.element("questBriefCount").textContent, /7 \/ 100件/);
  assert.match(compact.element("compactQuestBrief").textContent, /7 \/ 100件/);
  for (const app of [normal, compact]) app.advanceTo(BOUNDARY);
  assert.match(normal.element("questBriefCount").textContent, /0 \/ 60件/);
  assert.match(compact.element("compactQuestBrief").textContent, /0 \/ 60件/);
  compact.advanceTo(periods()[2].endAt);
  assert.equal(compact.element("compactQuestBrief").hidden, true);
  assert.equal(compact.writes(), 0);
});

test("a focused but unchanged sales field receives the new period's value at cutoff", () => {
  const app = harness();
  app.element("questSalesInput").focus();
  assert.equal(app.element("questSalesInput").value, "12345");
  app.advanceTo(BOUNDARY);
  assert.equal(app.selected(), "weekend");
  assert.equal(app.element("questSalesInput").value, "");
  assert.equal(app.writes(), 0);
});

test("unsaved sales stay on their original period and switch only after a successful save", () => {
  const app = harness();
  app.element("questSalesInput").focus();
  app.element("questSalesInput").value = "19000";
  app.emit("questSalesInput", "input");
  app.advanceTo(BOUNDARY);
  assert.equal(app.selected(), "weekday");
  assert.equal(app.element("questSalesInput").value, "19000");
  assert.equal(app.element("questSalesDay").value, "2026-09-17");
  assert.match(app.element("questAutoNotice").textContent, /入力を保存/);
  assert.match(app.element("questBriefCount").textContent, /0 \/ 60件/);
  app.emit("questSalesForm", "submit");
  assert.equal(app.selected(), "weekend");
  assert.equal(app.read().quests.find(item => item.id === "weekday").sales["2026-09-17"], 19000);
  assert.deepEqual(app.read().quests.find(item => item.id === "weekend").sales, {});
  assert.equal(app.element("questSalesInput").value, "");
  assert.equal(app.alerts.length, 0);
});

test("invalid unsaved sales are retained across the boundary until corrected", () => {
  const app = harness();
  app.element("questSalesInput").value = "-1";
  app.emit("questSalesInput", "input");
  app.advanceTo(BOUNDARY);
  app.emit("questSalesForm", "submit");
  assert.equal(app.selected(), "weekday");
  assert.equal(app.element("questSalesInput").value, "-1");
  assert.equal(app.element("questError").hidden, false);
  assert.equal(app.writes(), 0);
});

test("sales input stays attached to its business day across a daily cutoff within one quest", () => {
  const midnight = at("2026-09-17T04:00:00");
  const app = harness({ now: midnight - 1 });
  app.element("questSalesInput").value = "8000";
  app.emit("questSalesInput", "input");
  app.setTime(midnight);
  app.periodic();
  assert.equal(app.element("questSalesDay").value, "2026-09-16");
  app.emit("questSalesForm", "submit");
  const saved = app.read().quests.find(item => item.id === "weekday");
  assert.equal(saved.sales["2026-09-16"], 8000);
  assert.equal(saved.sales["2026-09-17"], 12345);
});

test("official count correction opened before cutoff saves to that period and day", () => {
  const app = harness();
  const progressBefore = app.storage.get(PROGRESS_KEY);
  app.details(true);
  assert.equal(app.element("questAlignToday").value, "7");
  app.element("questAlignTotal").value = "17";
  app.element("questAlignToday").value = "17";
  app.advanceTo(BOUNDARY);
  assert.equal(app.selected(), "weekday");
  assert.equal(app.element("questAlignToday").value, "17");
  app.emit("questAlignForm", "submit");
  const saved = app.read();
  const old = saved.quests.find(item => item.id === "weekday");
  assert.equal(core.questDailyCounts(old, saved.entries)["2026-09-17"], 17);
  assert.equal(core.calculateQuest(saved.quests.find(item => item.id === "weekend"), saved.entries, BOUNDARY).total, 0);
  assert.equal(app.selected(), "weekend");
  assert.equal(app.element("questAlignDetails").open, false);
  assert.equal(app.storage.get(PROGRESS_KEY), progressBefore);
  assert.equal(app.element("questError").hidden, true);
});

test("closing an unsaved official correction releases the held period without writes", () => {
  const app = harness();
  app.details(true);
  app.advanceTo(BOUNDARY);
  assert.equal(app.selected(), "weekday");
  app.details(false);
  assert.equal(app.selected(), "weekend");
  assert.equal(app.writes(), 0);
});
