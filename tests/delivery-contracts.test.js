"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
  assert.match(baseLabel[1], /clamp\(19px,5\.35vw,23px\)/);
  assert.match(baseLabel[2], /-\.06em/);
  assert.match(wideBlock[1], /padding-left\s*:\s*0\s*;\s*padding-right\s*:\s*0/);
  assert.match(narrowBlock[1], /grid-template-columns\s*:\s*1fr\s+1fr/);
  assert.match(narrowBlock[1], /font-size\s*:\s*22px/);

  const clamp = (minimum, preferred, maximum) => Math.max(minimum, Math.min(preferred, maximum));
  const cases = [320, 351, 370, 371, 375, 390, 430, 440];
  const conservativeLabelWidthEm = 9.5;
  for (const viewport of cases) {
    const twoRows = viewport <= 370;
    const bodyPadding = viewport <= 390 ? 8 : 12;
    const contentWidth = viewport - bodyPadding * 2 - 36 - 26;
    const buttonWidth = clamp(44, viewport * 0.115, 50);
    const gap = clamp(4, viewport * 0.012, 5);
    const textSlot = contentWidth - (twoRows ? 0 : buttonWidth * 2 + gap * 2);
    const fontSize = twoRows
      ? 22
      : clamp(19, viewport * 0.0535, 23);
    const maximumLabelWidth = fontSize * conservativeLabelWidthEm;
    assert.ok(
      maximumLabelWidth <= textSlot,
      `残り 12時間59分 must fit at ${viewport}px (${maximumLabelWidth.toFixed(1)}px <= ${textSlot}px)`
    );
    assert.ok(twoRows ? fontSize >= 22 : fontSize >= 19, `the label must stay legible at ${viewport}px`);
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
  assert.match(compact, /Math\.ceil\(enhanced\.remainingMs\s*\/\s*60000\)/);
  assert.match(enhancements, /id="workActiveTime">0時間00分<\/strong>/);
  assert.match(enhancements, /id="workElapsedTime">0時間00分<\/strong>/);
  assert.doesNotMatch(enhancements, /id="(?:workActiveTime|workElapsedTime)"[^>]*>[^<]*秒/);
  assert.match(enhancements, /remainingMs/);
  assert.match(enhancements, /activeMs/);
});
