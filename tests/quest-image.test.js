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
const PROGRESS = `クエストの進捗
9月14日(月)4:00〜9月18日(金)4:00
あと91回の乗車サービスを完了すると、¥9,590を獲得できます
9/100回の乗車 ¥9,590
0 10 回の乗車 +¥1,380
詳細`;

// Actual OCR output: the dark green base reward becomes unrelated characters,
// while the explanatory sentence and the locked bonus remain legible.
const LOW_CONTRAST_PROGRESS = `クエ スト の 進捗
9 月 21 日 (月 ) 4:00 へ 9 月 25 日 ( 金 ) 4:.00
あと 92 回 の 乗車 サー ビス を 完了 する と 、\\9.310 を 獲
得 で き 、 別 の 特典 が 利用 可能 に な り ま す
18/110 回 の 乗車
画 間 問
ロ g 10 回 の 乗車 +\\1.910
詳細`;

test("light selection OCR preserves all three choices including the selected badge", () => {
  const text = String.raw`次 の クエ スト を 選択 する
金曜 日 午前 4 時 00 分 へ 月 曜日 午前 4 時 00 分
[ ソ クエ ェ スト 」1|
る 120 回 の 乗車 \\20.,190
ら +10 回 の 乗車 + 半 \\2.650
クエ スト 2
る 110 回 の 乗車 \\17130
ら +10 回 の 乗車 + ギ \\\\2.,450
クエ スト 3
る 100 回 の 乗車 半 14.330
ら +10 回 の 乗車 +\\\\2,240`;
  const result = image.parseText(text, NOW);
  assert.deepEqual(result.candidates, [
    {label: 'クエスト1', tiers: [{target:120, reward:20190}, {target:130, reward:2650}]},
    {label: 'クエスト2', tiers: [{target:110, reward:17130}, {target:120, reward:2450}]},
    {label: 'クエスト3', tiers: [{target:100, reward:14330}, {target:110, reward:2240}]}
  ]);
  assert.equal(result.skipped, 0);
  for (const amount of ['1Z7130', '17.,13', '2..450', '20.,19O']) {
    assert.equal(image.parseText(`クエスト1\n120回 ¥${amount}`).candidates.length, 0, amount);
  }
});

test("low-contrast progress reward is recovered from its matching remaining-count sentence", () => {
  for (const text of [LOW_CONTRAST_PROGRESS, LOW_CONTRAST_PROGRESS.replace(' +\\1.910', '\n\n+\\1.910')]) {
    const result = image.parseText(text, Date.parse('2026-09-22T12:00:00+09:00'));
    assert.deepEqual(result.candidates, [{label:'進行中のクエスト', completed:18, tiers:[{target:110,reward:9310},{target:120,reward:1910}]}]);
    assert.equal(result.period.startDate, '2026-09-21');
    assert.equal(result.period.endDate, '2026-09-25');
    assert.equal(result.period.endTime, '04:00');
  }
});

test("summary recovery requires an intact amount, matching count, and complete bonus", () => {
  for (const text of [
    LOW_CONTRAST_PROGRESS.replace('あと 92', 'あと 82'),
    LOW_CONTRAST_PROGRESS.replace('\\9.310', '\\9.31'),
    LOW_CONTRAST_PROGRESS.replace('\\9.310 を 獲\n得', '\\9.310'),
    LOW_CONTRAST_PROGRESS.replace('18/110 回 の 乗車', ''),
    LOW_CONTRAST_PROGRESS.replace('+\\1.910', ''),
    LOW_CONTRAST_PROGRESS.replace('+\\1.910', '\\1.910'),
    LOW_CONTRAST_PROGRESS.replace('画 間 問', '\\9.31'),
    LOW_CONTRAST_PROGRESS.replace('画 間 問', '+\\9.310'),
    LOW_CONTRAST_PROGRESS.replace('ロ g 10 回', '2/10 回')
  ]) assert.equal(image.parseText(text, NOW).candidates.length, 0, text);
});

test("conflicting summary and displayed rewards are rejected instead of choosing one", () => {
  assert.equal(image.parseText(LOW_CONTRAST_PROGRESS.replace('画 間 問', '\\9.810'), NOW).candidates.length, 0);
  assert.equal(image.parseText(PROGRESS.replace('9/100回の乗車 ¥9,590', '9/100回の乗車 ¥9,580'), NOW).candidates.length, 0);
});

test("progress fractions identify the screen even when the title is not recognized", () => {
  assert.deepEqual(image.parseText(PROGRESS.replace('クエストの進捗', 'クエストの進歩'), NOW).candidates, image.parseText(PROGRESS, NOW).candidates);
});

test("currency glyph confusion is normalized without altering the amount digits", () => {
  assert.deepEqual(image.parseText(PROGRESS.replaceAll('¥', 'Y'), NOW).candidates, image.parseText(PROGRESS, NOW).candidates);
  assert.deepEqual(image.parseText(PROGRESS.replaceAll('¥', '羊'), NOW).candidates, image.parseText(PROGRESS, NOW).candidates);
});

test("observed long-dash range and duplicated time punctuation retain calendar dates", () => {
  assert.equal(image.readPeriod('9月14日(月)4:00 ーー 9月18日(金)4:.00', NOW).endTime, '04:00');
});

test("unequal OCR text heights preserve count-before-money order", () => {
  const line = (text, x0, y0, y1) => ({text, bbox:{x0, x1:x0+150, y0, y1}});
  const data = {blocks:[{paragraphs:[{lines:[line('クエスト1',20,100,130),line('120回',80,180,240),line('¥15,700',600,181,193)]}]}]};
  assert.deepEqual(image.parseText(image.textFromBlocks(data)).candidates[0].tiers,[{target:120,reward:15700}]);
});

test("failed recognition retries once and retains diagnostics while terminating its worker", async () => {
  const vm = require('node:vm'); const fs = require('node:fs');
  let reads = 0; let terminated = 0; let workerOptions;
  const ctx = {fillRect(){},drawImage(){},getImageData(){return {data:new Uint8ClampedArray([255,255,255,255])};},putImageData(){}};
  const scope = {module:{exports:{}},window:{Tesseract:{createWorker:async(l,o,opts)=>{
    workerOptions=opts; return {setParameters:async()=>{},recognize:async()=>({data:{text:++reads===1?'読み取り失敗':PROGRESS}}),terminate:async()=>{terminated++;}};
  }}},document:{createElement:()=>({width:0,height:0,getContext:()=>ctx})},Image:class {naturalWidth=943;naturalHeight=2048;set src(value){queueMicrotask(()=>this.onload());}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},DOMException,setTimeout,clearTimeout,console};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/quest-image.js'),'utf8'),scope);
  const result = await scope.module.exports.recognize({name:'test.png',type:'image/png',size:100});
  assert.equal(reads,2); assert.equal(terminated,1); assert.equal(result.candidates[0].completed,9);
  assert.match(result.diagnosticText,/読み取り失敗/); assert.match(result.diagnosticText,/943×2048/);
  assert.equal(workerOptions.cachePath,'ubereats-quest-jpn-v1');
});

test("progress screenshot imports its actual goal, locked bonus, calendar dates and completed total", () => {
  const result = image.parseText(PROGRESS, NOW);
  assert.deepEqual(result.candidates, [{ label: "進行中のクエスト", completed: 9, tiers: [{ target: 100, reward: 9590 }, { target: 110, reward: 1380 }] }]);
  assert.equal(result.period.startDate, "2026-09-14"); assert.equal(result.period.endDate, "2026-09-18");
  assert.equal(result.period.startTime, "04:00"); assert.equal(result.period.endTime, "04:00");
  assert.equal(result.period.dateSource, "calendar");
});

test("progress description alone, contradictory remaining counts, and ambiguous later stages are rejected", () => {
  for (const text of [PROGRESS.replace('9/100回の乗車 ¥9,590', ''), PROGRESS.replace('あと91', 'あと81'), PROGRESS.replace('0 10 回', '2/10回'), PROGRESS.replace('+¥1,380', ''), PROGRESS.replace('+¥1,380', '¥1,380')]) assert.equal(image.parseText(text, NOW).candidates.length, 0);
});

test("calendar dates validate actual days and roll over the year rather than guessing the current week", () => {
  assert.equal(image.readPeriod('12月29日4:00〜1月2日4:00', Date.parse('2027-01-01T12:00:00+09:00')).startDate, '2026-12-29');
  assert.equal(image.readPeriod('2026年9月14日(月)4:00〜2026年9月18日(金)4:00', NOW).inferred, false);
  assert.equal(image.readPeriod('2月30日4:00〜3月3日4:00', NOW), null);
  assert.equal(image.readPeriod('9月14日4:90〜9月18日4:00', NOW), null);
});

test("calendar periods accept Japanese clocks, shortened weekdays, and mixed OCR punctuation without losing 03:59", () => {
  const now = Date.parse('2026-10-06T08:25:00+09:00');
  for (const text of [
    '10月5日(月)午前4時00分〜10月9日(金)午前3時59分',
    '10月5日(月曜日)4:00から10月9日(金曜日)午前3時59分まで',
    '10月5日(月曜)午前4時→10月9日(金曜)3:59',
    '10月5日月曜日4時00分〜10月9日金曜日3:59',
    '１０月５日（月）午前４：００～１０月９日（金）午前３：５９',
    '10 月 5 日 ( 月 曜 日 ) 午 前 4 時 00 分\nー\n10 月 9 日 ( 金 曜 ) 3 :. 59',
    '10月5日(月)4.00〜10月9日(金)3,59'
  ]) {
    const period = image.readPeriod(text, now);
    assert.deepEqual(period, { startDate: '2026-10-05', endDate: '2026-10-09', startTime: '04:00', endTime: '03:59', inferred: true, dateSource: 'calendar', next: false, template: 'weekday' }, text);
  }
});

test("weekday periods accept colon clocks and Japanese clock combinations while retaining the cutoff minute", () => {
  const now = Date.parse('2026-10-06T08:25:00+09:00');
  for (const text of [
    '月曜日4:00〜金曜日3:59',
    '月曜午前4時から金曜午前3時59分まで',
    '(月)午前4:00→(金)午前3:59',
    '月曜日午前4時00分〜金曜日午前3:59'
  ]) {
    assert.deepEqual(image.readPeriod(text, now), { startDate: '2026-10-05', endDate: '2026-10-09', startTime: '04:00', endTime: '03:59', inferred: true, next: false, template: 'weekday' }, text);
  }
  const period = at => image.readPeriod('月曜4:00〜金曜3:59', Date.parse(at + '+09:00'));
  assert.equal(period('2026-10-09T03:59:59').startDate, '2026-10-05');
  assert.equal(period('2026-10-09T04:00:00').startDate, '2026-10-12');
  assert.equal(image.readPeriod('次のクエスト\n月曜4:00〜金曜3:59', now).startDate, '2026-10-12');
});

test("Japanese calendar clocks retain noon, midnight, and explicit year-end dates", () => {
  const period = image.readPeriod('2026年10月5日(月曜)午前12時〜2026年10月9日(金曜)午後12時00分', NOW);
  assert.equal(period.startTime, '00:00'); assert.equal(period.endTime, '12:00'); assert.equal(period.inferred, false);
  const rollover = image.readPeriod('2026年12月28日(月曜日)午前4時00分から2027年1月1日(金曜日)午前3時59分', NOW);
  assert.equal(rollover.startDate, '2026-12-28'); assert.equal(rollover.endDate, '2027-01-01'); assert.equal(rollover.endTime, '03:59');
  const endYear = image.readPeriod('12月30日(月曜)4時〜2025年1月3日(金曜)3:59', NOW);
  assert.equal(endYear.startDate, '2024-12-30'); assert.equal(endYear.endDate, '2025-01-03');
});

test("expanded period syntax still rejects incomplete clocks, impossible dates, and a single selection deadline", () => {
  for (const text of [
    '月曜午前12時00分まで変更できます',
    '月曜4:00〜金曜',
    '月曜午前4時〜金曜午前3時59',
    '月曜午前14時〜金曜午前3時59分',
    '月曜4:000〜金曜3:59',
    '月曜4:00〜金曜3:590',
    '月曜4:00〜金曜3:59分0',
    '月曜4:00〜金曜3時59分分',
    '月曜午前4時〜金曜午前3時99分',
    '月曜4..00〜金曜3:59',
    '10月5日(月)午前O時00分〜10月9日(金)午前3時59分',
    '2026年9月14日(月曜)4:00〜金曜3:59',
    '10月5日月曜日4:00〜金曜日3:59',
    '2026年9月28日(月曜4:00〜金曜3:59',
    '2026年9月28日(月曜日4:00〜金曜日3:59',
    '2026年9月28日:(月)4:00〜(金)3:59',
    '2026年2月30日(月曜)午前4時〜2026年3月3日(金曜)午前3時59分',
    '2026年10月5日(火曜)午前4時〜2026年10月9日(金曜)午前3時59分',
    '2026年10月5日(月曜)午後12時〜2026年10月5日(月曜)午前12時',
    '2026年10月5日(月曜)4:00〜2027年10月9日(土曜)3:59'
  ]) assert.equal(image.readPeriod(text, NOW), null, text);
});

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

function loadRecognizer({ texts, results, pixels = [255, 255, 255, 255] }) {
  const vm = require('node:vm'); const fs = require('node:fs');
  const calls = { reads: 0, terminated: 0, drawn: [] };
  const ctx = {fillRect(){},drawImage(){},getImageData(){return {data:new Uint8ClampedArray(pixels)};},putImageData(data){calls.drawn.push(Array.from(data.data));}};
  const scope = {module:{exports:{}},window:{Tesseract:{createWorker:async()=>({setParameters:async()=>{},recognize:async()=>({data:results ? results[calls.reads++] : {text:texts[calls.reads++]}}),terminate:async()=>{calls.terminated++;}})}},document:{createElement:()=>({width:0,height:0,getContext:()=>ctx})},Image:class {naturalWidth=1320;naturalHeight=2868;set src(value){queueMicrotask(()=>this.onload());}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},DOMException,setTimeout,clearTimeout,console};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/quest-image.js'),'utf8'),scope);
  return { calls, recognize: () => scope.module.exports.recognize({name:'test.png',type:'image/png',size:100}) };
}

test("a period lost by spatial grouping is recovered without replacing its valid reward candidates", async () => {
  const line = (text, x0, y0) => ({text, bbox:{x0, x1:x0+180, y0, y1:y0+40}});
  const data = {
    // Deliberately different valid amounts verify that only the period is recovered.
    text: '2026年10月5日(月)午前4時00分〜2026年10月9日(金)午前3時59分\nクエスト1\n110回 ¥99999',
    blocks: [{paragraphs:[{lines:[line('クエスト1',20,100),line('110回 ¥11,550',20,180),line('+10回 +¥1,500',20,260)]}]}]
  };
  const recognizer = loadRecognizer({results:[data,data]});
  const result = await recognizer.recognize();
  assert.equal(recognizer.calls.reads, 1);
  assert.equal(recognizer.calls.terminated, 1);
  assert.deepEqual(Array.from(result.candidates[0].tiers, tier => ({...tier})), [{target:110,reward:11550},{target:120,reward:1500}]);
  assert.equal(result.period.startDate, '2026-10-05');
  assert.equal(result.period.endDate, '2026-10-09');
  assert.equal(result.period.endTime, '03:59');
  assert.match(result.diagnosticText, /結果1[\s\S]*結果2/);
});

test("recovering original reward rows retains a period recognized only by spatial grouping", async () => {
  const data = {
    text: 'クエスト1\n110回 ¥11,550\n+10回 +¥1,500',
    blocks: [{paragraphs:[{lines:[{text:'2026年10月5日(月)4:00〜2026年10月9日(金)3:59',bbox:{x0:20,x1:500,y0:100,y1:140}}]}]}]
  };
  const recognizer = loadRecognizer({results:[data,data]});
  const result = await recognizer.recognize();
  assert.equal(recognizer.calls.reads, 1);
  assert.equal(recognizer.calls.terminated, 1);
  assert.equal(result.candidates[0].tiers[1].target, 120);
  assert.equal(result.period.startDate, '2026-10-05');
  assert.equal(result.period.endDate, '2026-10-09');
  assert.equal(result.period.endTime, '03:59');
});

test("pale colored text on a light screen is darkened before OCR while white and dark mode are unchanged", async () => {
  // white, pale green bonus, base green, mid gray, black
  const light = loadRecognizer({ texts: [SCREEN.replace(/\nクエスト3$/, '')], pixels: [255,255,255,255, 163,212,174,255, 59,129,75,255, 128,128,128,255, 0,0,0,255] });
  await light.recognize();
  assert.deepEqual(light.calls.drawn[0].filter((_, i) => i % 4 === 0), [255, 71, 0, 1, 0]);
  const dark = loadRecognizer({ texts: [SCREEN.replace(/\nクエスト3$/, '')], pixels: [0,0,0,255, 163,212,174,255, 255,255,255,255] });
  await dark.recognize();
  assert.deepEqual(dark.calls.drawn[0].filter((_, i) => i % 4 === 0), [255, 43, 0]);
});

test("a read with excluded candidates is retried and only a read with more complete candidates replaces it", async () => {
  const complete = SCREEN.replace(/クエスト3$/, 'クエスト3\n100回の乗車 ¥14,280\n+10回の乗車 +¥2,240');
  const lostBonus = SCREEN.replace('+¥5,300', '').replace('+¥3,740', '').replace(/クエスト3$/, 'クエスト3\n100回の乗車 ¥14,280');
  const improved = loadRecognizer({ texts: [lostBonus, complete] });
  const result = await improved.recognize();
  assert.equal(improved.calls.reads, 2); assert.equal(improved.calls.terminated, 1);
  assert.deepEqual(Array.from(result.candidates, item => item.label), ['クエスト1', 'クエスト2', 'クエスト3']);
  assert.equal(result.skipped, 0); assert.equal(result.period.template, 'weekend');
  assert.match(result.diagnosticText, /読み取り v79[\s\S]*結果1[\s\S]*結果2/);

  const worse = loadRecognizer({ texts: [lostBonus, '読み取り失敗'] });
  const kept = await worse.recognize();
  assert.equal(worse.calls.reads, 2);
  assert.deepEqual(Array.from(kept.candidates, item => item.label), ['クエスト3']); assert.equal(kept.skipped, 2);
  assert.equal(kept.period.template, 'weekend');

  const clean = loadRecognizer({ texts: [complete] });
  await clean.recognize();
  assert.equal(clean.calls.reads, 1);
});
