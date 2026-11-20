"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseText } = require("../src/quest-image.js");

const now = Date.parse("2026-11-20T19:23:00+09:00");
const grouped = String.raw`19:23 999 56
<
クエ スト の 進捗 ビ ば
11 月 20 日 ( 金 ) 4.00 11 月 23 日 (月 ) 4:.00
後 100 回 の 配達 を 完了 する と 、\13,220 を 獲得 で き 、
別 の 特典 が 利用 可能 に な り ま す
207/120 回 の 乗車 \13,220
画 間 問
ロ 10 回 の 乗車 + 半 \1,730
詳細`;
const separated = grouped
  .replace("乗車 \\13,220", "乗車\n\\13,220")
  .replace("乗車 + 半", "乗車\n+ 半")
  .replaceAll("\n", "\n\n");

test("recover the November 20 Safari readings when both printed base rewards agree", () => {
  for (const text of [grouped, separated]) {
    const result = parseText(text, now);
    assert.deepEqual(result.candidates, [{
      label: "進行中のクエスト", completed: 20,
      tiers: [{ target: 120, reward: 13220 }, { target: 130, reward: 1730 }]
    }]);
    assert.equal(result.inferredProgress, true);
    assert.equal(result.period.startDate, "2026-11-20");
    assert.equal(result.period.startTime, "04:00");
    assert.equal(result.period.endDate, "2026-11-23");
    assert.equal(result.period.endTime, "04:00");
  }
});

test("reject the two readings that lost the independently printed base reward", () => {
  for (const text of [grouped, separated]) {
    const missingBase = text.replace(/(207\/120 回 の 乗車)\s*\\13,220/, "$1")
      .replace("4:.00", "4:00").replace("+ 半 ", "+");
    assert.deepEqual(parseText(missingBase, now).candidates, []);
  }
});

test("a duplicated slash requires the extra 7, matching remaining count and matching rewards", () => {
  for (const text of [
    grouped.replace("後 100 回", "残数不明"),
    grouped.replace("後 100 回", "後 101 回"),
    grouped.replace("乗車 \\13,220", "乗車 \\13,200"),
    grouped.replace("207/120", "208/120"),
    grouped.replace("207/120", "270/120"),
    grouped.replace("207/120", "-207/120"),
    grouped.replace("207/120", "1.207/120"),
    grouped.replace("207/120", "207/120 回\n20/120"),
    grouped.replace("+ 半 \\1,730", "+ 半 \\1,73")
  ]) {
    assert.deepEqual(parseText(text, now).candidates, [], text);
  }
});

test("a valid completed count ending in seven stays intact", () => {
  const result = parseText(grouped.replace("207/120", "207/307"), now);
  assert.equal(result.candidates[0].completed, 207);
  assert.deepEqual(result.candidates[0].tiers, [{ target: 307, reward: 13220 }, { target: 317, reward: 1730 }]);
  assert.equal(result.inferredProgress, false);
});
