"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const image = require("../src/quest-image.js");
const core = require("../src/app-core.js");
const NOW = Date.parse("2026-09-15T18:18:00+09:00");
const SCREEN = `次のクエストを選択する
このクエストの選択は金曜日 午前12時00分まで変更できます。
金曜日 午前4時00分 〜 月曜日 午前4時00分
クエスト1
120回の乗車 ¥15,700
+10回の乗車 +¥5,300
クエスト2
110回の乗車 ¥11,020
+10回の乗車 +¥3,740
クエスト3`;

test("quest selection screenshot produces independent candidates and incremental rewards", () => {
  const result = image.parseText(SCREEN, NOW);
  assert.deepEqual(result.candidates, [
    { label: "クエスト1", tiers: [{ target: 120, reward: 15700 }, { target: 130, reward: 5300 }] },
    { label: "クエスト2", tiers: [{ target: 110, reward: 11020 }, { target: 120, reward: 3740 }] }
  ]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.period, { startDate: "2026-09-18", endDate: "2026-09-21", startTime: "04:00", endTime: "04:00", inferred: true, next: true, template: "weekend" });
});

test("observed Japanese OCR spaces, currency glyphs and three-digit separators are handled", () => {
  const text = `次 の クエ スト を 選択 する
金曜 日 午前 4 時 00 分 へ 月 曜日 午前 4 時 00 分
クエ スト 1
【 】 120 回 の 乗車 \\15,700
@ +10 回 の 乗車 + 半 5.300
クエ スト 2
【 】 110 回 の 乗車 \\11.020
@ +10 回 の 乗車 + 半 3,740
クエ スト 3`;
  assert.deepEqual(image.parseText(text, NOW), image.parseText(SCREEN, NOW));
});

test("full-width numerals and separated count/money rows preserve the candidate boundaries", () => {
  const result = image.parseText("クエスト１\n１２０回の乗車\n￥１５，７００\n＋１０回の乗車\n＋￥５，３００\nクエスト２\n１１０回の乗車");
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.candidates[0].tiers, [{ target: 120, reward: 15700 }, { target: 130, reward: 5300 }]);
});

test("unpaired counts and an incomplete additional tier exclude the whole affected candidate", () => {
  for (const suffix of ["\n+10回の乗車", "\n+10回の乗車\n+10回の乗車 +¥500"]) {
    const result = image.parseText(`クエスト1\n120回の乗車 ¥15700${suffix}\nクエスト2\n80回の乗車 ¥8000`);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.candidates.map(item => item.label), ["クエスト2"]);
  }
});

test("malformed amounts, missing base tiers and ambiguous additional markers are rejected", () => {
  for (const rows of ["120回の乗車 ¥11.02", "120回の乗車 ¥1,234,56", "120回の乗車 ¥1102O", "120回の乗車 -¥15000", "12000回の乗車 ¥15000", "12.5回の乗車 ¥15000", "+10回の乗車 +¥500", "120回の乗車 ¥15000\n10回の乗車 +¥500", "120回の乗車 ¥15000\n+10回の乗車 ¥500", "9999回の乗車 ¥15000\n+10回の乗車 +¥500"]) {
    assert.equal(image.parseText(`クエスト1\n${rows}`).candidates.length, 0, rows);
  }
  assert.equal(image.parseText("18:18\nバッテリー70\nあと2日\nクエストを選択する").candidates.length, 0);
});

test("spatial OCR output joins left-hand counts and right-hand amounts on the same row", () => {
  const line = (text, x, y) => ({ text, bbox: { x0: x, x1: x + 150, y0: y, y1: y + 40 } });
  const data = { blocks: [{ paragraphs: [{ lines: [line("クエスト1", 20, 100), line("120回の乗車", 80, 180), line("+10回の乗車", 80, 260)] }] }, { paragraphs: [{ lines: [line("¥15,700", 600, 183), line("+¥5,300", 600, 258)] }] }] };
  assert.deepEqual(image.parseText(image.textFromBlocks(data)).candidates[0].tiers, [{ target: 120, reward: 15700 }, { target: 130, reward: 5300 }]);
});

test("selection deadlines and absent or invalid period times are never substituted", () => {
  for (const text of ["金曜日 午前12時00分まで変更できます", "金曜日〜月曜日", "金曜日 午前14時00分〜月曜日 午前4時00分", "金曜日 午前4時70分〜月曜日 午前4時00分"]) assert.equal(image.readPeriod(text, NOW), null);
});

test("weekday-only dates remain explicitly inferred across the 04:00 cutoff and year end", () => {
  const text = "金曜日 午前4時00分〜月曜日 午前4時00分";
  const period = at => image.readPeriod(text, Date.parse(at + "+09:00"));
  assert.equal(period("2026-09-19T10:00:00").startDate, "2026-09-18");
  assert.equal(period("2026-09-21T03:59:00").startDate, "2026-09-18");
  assert.equal(period("2026-09-21T04:00:00").startDate, "2026-09-25");
  assert.equal(period("2026-09-18T03:59:00").startDate, "2026-09-18");
  assert.equal(image.readPeriod("次のクエスト\n" + text, Date.parse("2026-09-18T04:00:00+09:00")).startDate, "2026-09-25");
  assert.equal(image.readPeriod("次のクエスト\n" + text, Date.parse("2026-12-31T18:00:00+09:00")).endDate, "2027-01-04");
  assert.equal(period("2026-09-19T10:00:00").inferred, true);
});

test("imported tiers retain existing reward and count semantics without double-counting", () => {
  const result = image.parseText(SCREEN, NOW);
  const period = result.period;
  for (const [index, candidate] of result.candidates.entries()) {
    const quest = { id: `import-${index}`, startAt: Date.parse(`${period.startDate}T04:00:00+09:00`), endAt: Date.parse(`${period.endDate}T04:00:00+09:00`), boundaryMinutes: 240, tiers: candidate.tiers, goalIndex: 1, adjustments: {}, sales: {} };
    quest.workDays = core.questDateKeys(quest);
    assert.equal(core.validateQuest(quest), "");
    const entries = [{ id: 1, epoch: 0, at: quest.startAt + 60000, quantity: candidate.tiers[1].target }];
    const value = core.calculateQuest(quest, entries, quest.startAt + 120000);
    assert.equal(value.earnedReward, index === 0 ? 21000 : 14760);
    assert.equal(value.total, index === 0 ? 130 : 120);
  }
});
