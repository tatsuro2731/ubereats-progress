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
  assert.match(source, /@media\s*\(\s*max-width\s*:\s*350px\s*\)/);
});
