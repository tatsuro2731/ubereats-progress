"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../src/app-core.js");

const ROOT = path.resolve(__dirname, "..");
const QUEST_KEY = core.QUEST_STORAGE_KEY;
const PROGRESS_KEY = core.STORAGE_KEYS.progress;
const at = value => Date.parse(`${value}+09:00`);
const NOW = at("2026-09-09T12:00:00");

function quest(overrides = {}) {
  const result = {
    id: "test-quest",
    startAt: at("2026-09-07T04:00:00"),
    endAt: at("2026-09-11T04:00:00"),
    boundaryMinutes: 240,
    tiers: [{ target: 120, reward: 12000 }, { target: 130, reward: 1300 }, { target: 140, reward: 1400 }],
    goalIndex: 0,
    adjustments: {},
    sales: {},
    ...overrides
  };
  if (!result.workDays) result.workDays = core.questDateKeys(result);
  return result;
}

function entriesByDay(counts) {
  return Object.entries(counts).map(([day, quantity], index) => ({
    id: index + 1, epoch: 0, at: at(`${day}T12:00:00`), quantity
  }));
}

function allocationSum(item, entries, time) {
  return core.questDateKeys(item).reduce((sum, day) => sum + core.calculateQuest(item, entries, time, day).allocation, 0);
}

test("quest averages use cumulative rewards and cumulative deliveries for both screenshot formats", () => {
  const examples = [
    [[110, 9310], [120, 1910]],
    [[120, 20190], [130, 2650]],
    [[110, 17130], [120, 2450]],
    [[100, 14330], [110, 2240]]
  ];
  const expected = [[9310, 11220], [20190, 22840], [17130, 19580], [14330, 16570]];
  examples.forEach((example, index) => {
    const tiers = example.map(([target, reward]) => Object.freeze({ target, reward }));
    const totals = core.questTierTotals(tiers);
    assert.deepEqual(totals.map(tier => tier.totalReward), expected[index]);
    assert.equal(totals[0].averageReward, expected[index][0] / tiers[0].target);
    assert.equal(totals[1].averageReward, expected[index][1] / tiers[1].target);
    assert.notEqual(totals[1].averageReward, tiers[1].reward / 10);
    assert.deepEqual(tiers.map(tier => [tier.target, tier.reward]), example);
  });
});

test("quest registration baseline never backfills the existing progress count", () => {
  const item = quest();
  const initial = core.createQuestState(12, NOW);
  const unchanged = core.changeQuestCount(initial, 12, { at: NOW });
  assert.equal(core.calculateQuest(item, unchanged.entries, NOW).total, 0);
  const added = core.changeQuestCount(unchanged, 13, { at: NOW + 1000 });
  assert.equal(core.calculateQuest(item, added.entries, NOW + 1000).total, 1);
  assert.equal(initial.entries.length, 0, "pure transitions must not mutate prior state");
});

test("a true reset preserves quest cumulative and starts an independent counter epoch", () => {
  const item = quest();
  let state = core.createQuestState(0, NOW);
  state = core.changeQuestCount(state, 8, { at: NOW });
  const beforeReset = state;
  state = core.changeQuestCount(state, 0, { reset: true, at: NOW + 1000 });
  assert.equal(state.counter.done, 0);
  assert.equal(state.counter.epoch, beforeReset.counter.epoch + 1);
  assert.equal(core.calculateQuest(item, state.entries, NOW + 1000).total, 8);
  state = core.changeQuestCount(state, 2, { at: NOW + 2000 });
  state = core.changeQuestCount(state, 1, { at: NOW + 3000 });
  assert.equal(core.calculateQuest(item, state.entries, NOW + 3000).total, 9);
  assert.equal(core.calculateQuest(item, beforeReset.entries, NOW).total, 8);
});

test("a decrement after cutoff removes deliveries from their original quest and day", () => {
  const previous = quest();
  const next = quest({ id: "next", startAt: previous.endAt, endAt: previous.endAt + 3 * 86400000 });
  let state = core.createQuestState(0, previous.endAt - 5000);
  state = core.changeQuestCount(state, 2, { at: previous.endAt - 1000 });
  state = core.changeQuestCount(state, 1, { at: previous.endAt + 1000 });
  assert.equal(core.calculateQuest(previous, state.entries, previous.endAt + 1000).total, 1);
  assert.equal(core.calculateQuest(next, state.entries, previous.endAt + 1000).total, 0);
  assert.equal(core.questDailyCounts(previous, state.entries)["2026-09-10"], 1);
});

test("quest interval includes its start and excludes its deadline, with JST day cutoffs", () => {
  const item = quest();
  const entries = [item.startAt - 1, item.startAt, item.endAt - 1, item.endAt].map((time, id) => ({ id, epoch: 0, at: time, quantity: 1 }));
  assert.equal(core.calculateQuest(item, entries, item.endAt).total, 2);
  assert.equal(core.questDayKey(item.startAt - 1, 240), "2026-09-06");
  assert.equal(core.questDayKey(item.startAt, 240), "2026-09-07");
  assert.equal(core.calculateQuest(item, [], item.startAt - 1).phase, "upcoming");
  assert.equal(core.calculateQuest(item, [], item.startAt).phase, "active");
  assert.equal(core.calculateQuest(item, [], item.endAt).phase, "ended");
  const next = quest({ id: "next", startAt: item.endAt, endAt: item.endAt + 86400000 });
  assert.equal(core.validateQuest(next, [item]), "", "adjacent periods do not overlap");
  assert.notEqual(core.validateQuest({ ...next, startAt: item.endAt - 1 }, [item]), "");
});

test("today's proposed target stays fixed as deliveries are completed", () => {
  const item = quest();
  const time = at("2026-09-08T13:00:00");
  const before = core.calculateQuest(item, entriesByDay({ "2026-09-07": 20 }), time);
  const during = core.calculateQuest(item, entriesByDay({ "2026-09-07": 20, "2026-09-08": 10 }), time);
  const reached = core.calculateQuest(item, entriesByDay({ "2026-09-07": 20, "2026-09-08": 34 }), time);
  assert.equal(before.suggestedToday, 34);
  assert.equal(during.suggestedToday, 34);
  assert.equal(during.additionalToday, 24);
  assert.equal(reached.additionalToday, 0);
});

test("holidays are excluded from target sharing and do not get an apply recommendation", () => {
  const item = quest({ workDays: ["2026-09-09", "2026-09-10"] });
  const counts = entriesByDay({ "2026-09-07": 20 });
  const holiday = core.calculateQuest(item, counts, at("2026-09-08T12:00:00"));
  assert.equal(holiday.worksToday, false);
  assert.equal(holiday.additionalToday, null);
  const workday = core.calculateQuest(item, counts, NOW);
  assert.equal(workday.additionalToday, 50);
});

test("all incremental tier rewards count once and allocation remains capped after the goal", () => {
  const item = quest({ goalIndex: 2 });
  const counts = entriesByDay({ "2026-09-07": 100, "2026-09-08": 50 });
  const value = core.calculateQuest(item, counts, NOW);
  assert.equal(value.plannedReward, 14700);
  assert.equal(value.earnedReward, 14700);
  assert.equal(value.remaining, 0);
  assert.equal(value.nextTier, null);
  assert.equal(allocationSum(item, counts, NOW), 14700);
  const afterExtra = [...counts, { id: 3, epoch: 0, at: NOW, quantity: 20 }];
  assert.equal(allocationSum(item, afterExtra, NOW), 14700);
});

test("an achieved higher tier contributes even when the selected target remains lower", () => {
  const item = quest({ goalIndex: 0 });
  const counts = entriesByDay({ "2026-09-07": 60, "2026-09-08": 70 });
  const value = core.calculateQuest(item, counts, NOW);
  assert.equal(value.earnedReward, 13300);
  assert.equal(allocationSum(item, counts, NOW), 13300);
});

test("after deadline only achieved rewards are allocated; missing the first tier yields zero", () => {
  const item = quest({ goalIndex: 2 });
  const missed = entriesByDay({ "2026-09-07": 60, "2026-09-08": 59 });
  assert.ok(allocationSum(item, missed, item.endAt - 1) > 0);
  assert.equal(allocationSum(item, missed, item.endAt), 0);
  const partial = entriesByDay({ "2026-09-07": 60, "2026-09-08": 65 });
  assert.equal(allocationSum(item, partial, item.endAt), 12000);
});

test("daily yen rounding sums exactly and earned rewards are not added twice to sales", () => {
  const item = quest({ tiers: [{ target: 3, reward: 100 }], goalIndex: 0, sales: { "2026-09-09": 1000 } });
  const counts = entriesByDay({ "2026-09-07": 1, "2026-09-08": 1, "2026-09-09": 1 });
  for (const time of [NOW, item.endAt]) {
    assert.equal(allocationSum(item, counts, time), 100);
    const value = core.calculateQuest(item, counts, time, "2026-09-09");
    assert.equal(value.earnedReward, 100);
    assert.equal(value.estimatedSales, 1000 + value.allocation);
  }
});

test("a no-op official alignment preserves recorded historical days", () => {
  const item = quest();
  const counts = entriesByDay({ "2026-09-07": 10, "2026-09-08": 20, "2026-09-09": 5 });
  const aligned = core.alignQuestCounts(item, counts, 35, 5, NOW);
  assert.deepEqual(core.questDailyCounts(aligned, counts), core.questDailyCounts(item, counts));
  const value = core.calculateQuest(aligned, counts, NOW);
  assert.equal(value.total, 35);
  assert.equal(value.today, 5);
});

test("imported official totals and later decrements stay consistent without relying on past-day attribution", () => {
  let state = core.createQuestState(10, NOW);
  const item = core.alignQuestCounts(quest(), state.entries, 35, 10, NOW);
  assert.equal(core.calculateQuest(item, state.entries, NOW).total, 35);
  assert.equal(core.calculateQuest(item, state.entries, NOW).today, 10);
  state = core.changeQuestCount(state, 9, { at: NOW + 1000 });
  const value = core.calculateQuest(item, state.entries, NOW + 1000);
  assert.equal(value.total, 34);
  assert.equal(value.today, 9);
});

test("a quest ending earlier in the same business day can still be officially aligned", () => {
  const item = quest({ startAt: at("2026-09-09T04:00:00"), endAt: at("2026-09-09T11:00:00") });
  const aligned = core.alignQuestCounts(item, [], 8, 8, NOW);
  const value = core.calculateQuest(aligned, [], NOW);
  assert.equal(value.phase, "ended");
  assert.equal(value.total, 8);
  assert.equal(value.today, 8);
});

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); this.failNextKey = null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (this.failNextKey === key) { this.failNextKey = null; throw new Error("simulated storage write failure"); }
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

function storeHarness(storage = new MemoryStorage()) {
  const alerts = [];
  const window = { UberProgressCore: core, alert: message => alerts.push(message) };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "src/quest-store.js"), "utf8"), { window, localStorage: storage, Date, Number, JSON, Math }, { filename: "src/quest-store.js" });
  return { store: window.UberQuestStore, storage, alerts };
}

function seedStore(done = 0) {
  const state = core.createQuestState(done);
  return new MemoryStorage({
    [PROGRESS_KEY]: JSON.stringify({ done: String(done), target: "46", remainH: "12", remainM: "0", displayCards: ["need", "eta"], futureField: { keep: true } }),
    [QUEST_KEY]: JSON.stringify(state)
  });
}

function savedProgress(storage) { return JSON.parse(storage.getItem(PROGRESS_KEY)); }
function countTotal(store) { return store.read().entries.reduce((sum, entry) => sum + entry.quantity, 0); }

test("normal and compact-style writers share one cumulative count and preserve legacy fields", () => {
  const storage = seedStore();
  const normal = storeHarness(storage).store;
  const compact = storeHarness(storage).store;
  assert.equal(normal.saveProgress({ ...savedProgress(storage), done: "1", endLimit: "22:00" }, { countChange: true }), true);
  assert.equal(compact.saveProgress({ ...savedProgress(storage), done: "2" }, { countChange: true }), true);
  assert.equal(normal.saveProgress({ ...savedProgress(storage), done: "1" }, { countChange: true }), true);
  assert.equal(countTotal(normal), 1);
  const saved = savedProgress(storage);
  assert.equal(saved.done, "1");
  assert.equal(saved.endLimit, "22:00");
  assert.deepEqual(saved.displayCards, ["need", "eta"]);
  assert.deepEqual(saved.futureField, { keep: true });
  assert.equal(Object.hasOwn(saved, "quests"), false);
  assert.equal(Object.hasOwn(saved, "entries"), false);
});

test("timer and settings saves with a stale done value preserve newer counts", () => {
  const storage = seedStore();
  const first = storeHarness(storage).store;
  const second = storeHarness(storage).store;
  const stale = savedProgress(storage);
  assert.equal(first.saveProgress({ ...savedProgress(storage), done: "3" }, { countChange: true }), true);
  const questBefore = storage.getItem(QUEST_KEY);
  assert.equal(second.saveProgress({ ...stale, remainM: "59" }), true);
  assert.equal(savedProgress(storage).done, "3");
  assert.equal(savedProgress(storage).remainM, "59");
  assert.equal(storage.getItem(QUEST_KEY), questBefore, "unrelated saves must not rewrite or recount quest records");
});

test("store reset preserves accumulated deliveries and future deliveries count once", () => {
  const storage = seedStore();
  const { store } = storeHarness(storage);
  store.saveProgress({ ...savedProgress(storage), done: "5" }, { countChange: true });
  assert.equal(store.resetCounter(), true);
  assert.equal(savedProgress(storage).done, "0");
  assert.equal(countTotal(store), 5);
  store.saveProgress({ ...savedProgress(storage), done: "1" }, { countChange: true });
  assert.equal(countTotal(store), 6);
});

test("a progress write failure rolls back the quest addition and retains original data", () => {
  const storage = seedStore();
  const { store, alerts } = storeHarness(storage);
  const originalProgress = storage.getItem(PROGRESS_KEY);
  const originalQuest = storage.getItem(QUEST_KEY);
  storage.failNextKey = PROGRESS_KEY;
  assert.equal(store.saveProgress({ ...savedProgress(storage), done: "1" }, { countChange: true }), false);
  assert.equal(storage.getItem(PROGRESS_KEY), originalProgress);
  assert.equal(storage.getItem(QUEST_KEY), originalQuest);
  assert.equal(alerts.length, 1);
});

test("rollback also removes a newly-created quest key when the first progress write fails", () => {
  const storage = new MemoryStorage({ [PROGRESS_KEY]: JSON.stringify({ done: "12", target: "46" }) });
  const { store } = storeHarness(storage);
  const originalProgress = storage.getItem(PROGRESS_KEY);
  storage.failNextKey = PROGRESS_KEY;
  assert.equal(store.saveProgress({ ...savedProgress(storage), done: "13" }, { countChange: true }), false);
  assert.equal(storage.getItem(PROGRESS_KEY), originalProgress);
  assert.equal(storage.getItem(QUEST_KEY), null);
});

test("malformed quest data is not overwritten by a delivery edit", () => {
  const storage = seedStore();
  storage.setItem(QUEST_KEY, "{broken-json");
  const originalProgress = storage.getItem(PROGRESS_KEY);
  const { store } = storeHarness(storage);
  assert.equal(store.saveProgress({ ...savedProgress(storage), done: "1" }, { countChange: true }), false);
  assert.equal(storage.getItem(QUEST_KEY), "{broken-json");
  assert.equal(storage.getItem(PROGRESS_KEY), originalProgress);
});

test("a pre-upgrade reset does not erase deliveries already recorded by the new version", () => {
  const storage = seedStore();
  const { store } = storeHarness(storage);
  store.saveProgress({ ...savedProgress(storage), done: "5" }, { countChange: true });
  storage.setItem(PROGRESS_KEY, JSON.stringify({ ...savedProgress(storage), done: "0" }));
  store.saveProgress({ ...savedProgress(storage), done: "1" }, { countChange: true });
  assert.equal(countTotal(store), 6);
  assert.equal(store.read().needsCountCheck, true);
});

test("an undated past import does not present invented daily sales allocations", () => {
  const item = core.alignQuestCounts(quest(), [], 80, 20, NOW);
  const today = core.calculateQuest(item, [], NOW);
  const past = core.calculateQuest(item, [], NOW, "2026-09-08");
  assert.equal(today.total, 80);
  assert.equal(today.today, 20);
  assert.equal(today.shownDayVerified, true);
  assert.equal(past.shownDayVerified, false);
  assert.equal(past.allocation, null);
  assert.equal(past.estimatedSales, null);
});

test("a manual downward correction never makes counts negative or redistributes unrelated days", () => {
  const item = quest();
  const entries = entriesByDay({ "2026-09-07": 10, "2026-09-08": 20, "2026-09-09": 5 });
  const aligned = core.alignQuestCounts(item, entries, 16, 6, NOW);
  const counts = core.questDailyCounts(aligned, entries);
  assert.deepEqual(counts, { "2026-09-07": 10, "2026-09-08": 0, "2026-09-09": 6, "2026-09-10": 0 });
  assert.equal(core.calculateQuest(aligned, entries, NOW).total, 16);
});

// Run the shipped registration/import event handlers. The DOM checks data flow,
// and does not replace browser or iPhone screen verification.
function imageImportHarness({ period = null } = {}) {
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      return Promise.all((this.listeners.get(event.type) || []).map(callback => callback(event)));
    }
  }
  const document = new Events();
  class Element extends Events {
    constructor(tagName = "div") {
      super();
      Object.assign(this, { tagName, value: "", textContent: "", hidden: false, children: [], dataset: {}, attributes: {}, className: "", open: false });
      this.classList = { toggle() {} };
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = [...children]; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() { document.activeElement = this; }
    set innerHTML(markup) { this.children = parseElements(markup); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [child, ...child.querySelectorAll("*")]).filter(child => {
        if (selector === "*") return true;
        if (selector.startsWith(".")) return child.className.split(/\s+/).includes(selector.slice(1));
        const match = selector.match(/^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (match) return (!match[1] || child.tagName === match[1]) && Object.hasOwn(child.attributes, match[2]) && (match[3] === undefined || child.attributes[match[2]] === match[3]);
        return child.tagName === selector;
      });
    }
  }
  function parseElements(markup) {
    return Array.from(markup.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g), match => {
      const element = new Element(match[1]);
      for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) element.setAttribute(attribute[1], attribute[2] ?? "");
      element.id = element.attributes.id || ""; element.className = element.attributes.class || "";
      element.hidden = Object.hasOwn(element.attributes, "hidden"); element.value = element.attributes.value || "";
      return element;
    });
  }
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const elements = new Map(parseElements(html).filter(element => element.id).map(element => [element.id, element]));
  const formHtml = html.match(/<form\b[^>]*id="questConfigForm"[^>]*>([\s\S]*?)<\/form>/)[1];
  const formElements = parseElements(formHtml);
  const form = elements.get("questConfigForm"); form.children = formElements;
  form.reset = () => {
    for (const field of formElements.filter(item => item.id && ["input", "select"].includes(item.tagName))) {
      const options = formHtml.match(new RegExp(`<select\\b[^>]*id="${field.id}"[^>]*>([\\s\\S]*?)<\\/select>`));
      elements.get(field.id).value = options?.[1].match(/<option\b[^>]*value="([^"]*)"/)?.[1] ?? field.value;
    }
  };
  document.body = new Element("body"); document.head = new Element("head");
  document.hidden = false; document.activeElement = document.body;
  document.getElementById = id => elements.get(id) || null; document.createElement = tag => new Element(tag);
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  class Event { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } preventDefault() {} }
  const storage = seedStore();
  const window = new Events();
  Object.assign(window, { window, document, Date: FakeDate, Event, CustomEvent: Event, AbortController,
    localStorage: storage, location: { hash: "#quest", pathname: "/", search: "" }, history: { replaceState() {} },
    URL: { createObjectURL: () => "blob:quest-test", revokeObjectURL() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {},
    UberQuestImage: { recognize: async () => ({ candidates: [{ label: "進行中のクエスト", tiers: [{ target: 110, reward: 11550 }, { target: 120, reward: 1500 }] }], period, skipped: 0, diagnosticText: "テスト用の読み取り結果" }) }
  });
  const context = vm.createContext(window);
  for (const name of ["app-core.js", "quest-store.js", "quest-ui.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, "src", name), "utf8"), context, { filename: `src/${name}` });
  const element = id => { assert.ok(elements.has(id), `Missing real HTML element: ${id}`); return elements.get(id); };
  return { element, storage, emit: (id, type) => element(id).dispatchEvent(new Event(type)),
    period: () => Object.fromEntries(["StartDate", "StartTime", "EndDate", "EndTime"].map(key => [key, element(`quest${key}`).value])),
    importImage: () => element("questImageFile").dispatchEvent(new Event("change", { target: { files: [{ name: "quest.png", type: "image/png", size: 100 }] } }))
  };
}

test("image import keeps template dates and times when OCR has no period", async () => {
  const app = imageImportHarness();
  await app.emit("questNew", "click");
  const before = app.period();
  assert.deepEqual(before, { StartDate: "2026-09-07", StartTime: "04:00", EndDate: "2026-09-11", EndTime: "03:59" });
  const stored = app.storage.getItem(QUEST_KEY);
  await app.importImage();
  assert.deepEqual(app.period(), before);
  assert.equal(app.element("questTemplate").value, "weekday");
  assert.equal(app.element("questTierInputs").querySelectorAll("[data-tier-count]")[1].value, "120");
  assert.equal(app.element("questImageDateNote").hidden, false);
  assert.match(app.element("questImageDateNote").textContent, /読み取れなかった.*入力済みの日時を保持.*確認してください/);
  assert.equal(app.element("questImageError").hidden, true);
  assert.equal(app.storage.getItem(QUEST_KEY), stored, "import must remain an unsaved form edit");
});

test("image import preserves manual dates, times, and custom template when OCR has no period", async () => {
  const app = imageImportHarness();
  await app.emit("questNew", "click");
  app.element("questTemplate").value = "custom"; await app.emit("questTemplate", "change");
  for (const [key, value] of Object.entries({ StartDate: "2026-09-09", StartTime: "07:30", EndDate: "2026-09-12", EndTime: "23:45" })) {
    app.element(`quest${key}`).value = value; await app.emit(`quest${key}`, "change");
  }
  const before = app.period();
  await app.importImage();
  assert.deepEqual(app.period(), before);
  assert.equal(app.element("questTemplate").value, "custom");
  assert.match(app.element("questImageStatus").textContent, /入力しました/);
});

test("image import leaves missing dates and times empty instead of filling unread OCR values", async () => {
  const app = imageImportHarness();
  await app.emit("questNew", "click");
  app.element("questTemplate").value = "custom"; await app.emit("questTemplate", "change");
  for (const [key, value] of Object.entries({ StartDate: "", StartTime: "07:30", EndDate: "", EndTime: "" })) {
    app.element(`quest${key}`).value = value; await app.emit(`quest${key}`, "change");
  }
  const before = app.period();
  await app.importImage();
  assert.deepEqual(app.period(), before);
  assert.equal(app.element("questTemplate").value, "custom");
  assert.match(app.element("questImageDateNote").textContent, /未入力の日時は入力してください/);
});

test("image import replaces entered dates with its recognized period and presents the 04:00 boundary as 03:59", async () => {
  const period = { startDate: "2026-09-11", startTime: "04:00", endDate: "2026-09-14", endTime: "04:00", dateSource: "calendar", template: "weekend", inferred: false };
  const app = imageImportHarness({ period });
  await app.emit("questNew", "click");
  const before = app.period();
  await app.importImage();
  assert.notDeepEqual(app.period(), before);
  assert.deepEqual(app.period(), { StartDate: "2026-09-11", StartTime: "04:00", EndDate: "2026-09-14", EndTime: "03:59" });
  assert.equal(app.element("questTemplate").value, "weekend");
  assert.match(app.element("questImageDateNote").textContent, /2026-09-11 04:00.*2026-09-14 03:59までを入力しました/);
  assert.equal(period.endTime, "04:00", "presentation must not rewrite the raw OCR period");
});
