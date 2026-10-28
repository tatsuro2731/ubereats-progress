"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const image = require("../src/quest-image.js");

test("a missing yen glyph on an intact bonus row keeps the printed digits", () => {
  const selection = "クエスト1\n110回の乗車 ¥13,780\n+10回の乗車 +1,820";
  assert.deepEqual(image.parseText(selection).candidates[0].tiers,
    [{target:110,reward:13780},{target:120,reward:1820}]);
  const progress = "クエストの進捗\n後105回の配達を完了すると、¥13,780を獲得\n5/110回の乗車 ¥13,780\n10回の乗車 +1,820\n詳細";
  assert.deepEqual(image.parseText(progress).candidates[0].tiers,
    [{target:110,reward:13780},{target:120,reward:1820}]);
});

test("a missing yen glyph is not inferred from ambiguous or malformed rewards", () => {
  for (const bonus of ["+1,82", "+1820", "+米1,820", "+1,8200", "+1,820円外", "1,820", "+1,820\n+10回", "-+1,820"]) {
    const result = image.parseText(`クエスト1\n110回 ¥13,780\n+10回の乗車 ${bonus}`);
    assert.equal(result.candidates.length, 0, bonus);
  }
  // A number on a different OCR line lacks the row context needed to infer currency.
  assert.equal(image.parseText("クエスト1\n110回 ¥13,780\n+10回の乗車\n+1,820").candidates.length, 0);
});
