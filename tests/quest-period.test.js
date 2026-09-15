"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/app-core.js");
const image = require("../src/quest-image.js");
const at = value => Date.parse(`${value}+09:00`);
const period = { startAt: at("2026-09-14T04:00:00"), endAt: at("2026-09-18T04:00:00") };

test("quest forms display the last included minute, with no change to stored 04:00 boundaries", () => {
  const fields = core.questPeriodFields(period);
  assert.deepEqual(fields, { startDate: "2026-09-14", startTime: "04:00", endDate: "2026-09-18", endTime: "03:59" });
  assert.deepEqual(core.questPeriodTimes(fields), period);
  assert.deepEqual(core.questPeriodTimes(fields, period), period);
});

test("03:59 includes the entire minute, then exactly 04:00 belongs to the next quest", () => {
  const times = core.questPeriodTimes({ startDate: "2026-09-14", startTime: "04:00", endDate: "2026-09-18", endTime: "03:59" });
  const first = { ...times, id: "first", boundaryMinutes: 240, tiers: [{ target: 100, reward: 9590 }], goalIndex: 0 };
  const second = { ...first, id: "second", startAt: times.endAt, endAt: at("2026-09-21T04:00:00") };
  const entries = ["2026-09-18T03:59:00", "2026-09-18T03:59:59.999", "2026-09-18T04:00:00"].map((time, id) => ({ id, at: at(time), quantity: 1 }));
  assert.equal(core.calculateQuest(first, entries, first.endAt - 1).phase, "active");
  assert.equal(core.calculateQuest(first, entries, first.endAt).phase, "ended");
  assert.equal(core.calculateQuest(first, entries, first.endAt).total, 2);
  assert.equal(core.calculateQuest(second, entries, second.startAt).total, 1);
  assert.equal(core.questDailyCounts(first, entries)["2026-09-17"], 2);
  assert.equal(core.questDailyCounts(second, entries)["2026-09-18"], 1);
  assert.equal(core.validateQuest(second, [first]), "");
  assert.deepEqual(core.questDateKeys(first), ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]);
});

test("an unchanged edit retains original seconds, including legacy/custom deadlines", () => {
  for (const endAt of [at("2026-09-18T03:59:00"), at("2026-09-18T11:42:23.123"), period.endAt]) {
    const previous = { startAt: period.startAt + 12345, endAt };
    const fields = core.questPeriodFields(previous);
    assert.deepEqual(core.questPeriodTimes(fields, previous), previous);
    assert.equal(core.questPeriodTimes({ ...fields, startTime: "05:00" }, previous).endAt, endAt);
    assert.equal(core.questPeriodTimes({ ...fields, endTime: "12:34" }, previous).startAt, previous.startAt);
  }
});

test("midnight and year-end deadlines display the previous date's final minute", () => {
  const previous = { startAt: at("2026-12-28T04:00:00"), endAt: at("2027-01-01T00:00:00") };
  const fields = core.questPeriodFields(previous);
  assert.equal(fields.endDate, "2026-12-31");
  assert.equal(fields.endTime, "23:59");
  assert.deepEqual(core.questPeriodTimes(fields), previous);
  assert.equal(core.questPeriodTimes({ ...fields, endTime: "00:00" }).endAt, at("2026-12-31T00:01:00"));
});

test("unknown dates and times remain invalid instead of silently filling a deadline", () => {
  for (const key of ["startDate", "startTime", "endDate", "endTime"]) {
    const times = core.questPeriodTimes({ ...core.questPeriodFields(period), [key]: "" });
    assert.ok(Number.isNaN(key.startsWith("start") ? times.startAt : times.endAt));
  }
});

test("the supplied progress and selection periods round-trip through a 03:59 form", () => {
  for (const text of ["9月14日(月)4:00〜9月18日(金)4:00", "次のクエスト\n金曜日 午前4時00分〜月曜日 午前4時00分"]) {
    const raw = image.readPeriod(text, at("2026-09-15T19:13:00"));
    const original = { startAt: at(`${raw.startDate}T${raw.startTime}:00`), endAt: at(`${raw.endDate}T${raw.endTime}:00`) };
    const fields = core.questPeriodFields(original);
    assert.equal(fields.endTime, "03:59");
    assert.deepEqual(core.questPeriodTimes(fields), original);
    assert.equal(raw.endTime, "04:00", "OCR source text is not rewritten or confused with form semantics");
  }
});

test("a screenshot already saying 03:59 remains in its current period throughout that minute", () => {
  const text = "金曜日 午前4時00分〜月曜日 午前3時59分";
  const before = image.readPeriod(text, at("2026-09-21T03:59:59.999"));
  assert.equal(before.startDate, "2026-09-18");
  assert.equal(before.endTime, "03:59");
  assert.equal(image.readPeriod(text, at("2026-09-21T04:00:00")).startDate, "2026-09-25");
  assert.equal(core.questPeriodTimes(before).endAt, at("2026-09-21T04:00:00"));
});
