"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../src/quest-image-crop.js"), "utf8");
const file = new Blob([Uint8Array.from([0xff, 0xd8, 0xff])]);
const jpeg = "data:image/jpeg;base64,example";

function setup({ width = 1320, height = 2868, encoded = jpeg } = {}) {
  const state = { draws: [], canvases: [], releasedImages: 0 };
  class Image {
    naturalWidth = width;
    naturalHeight = height;
    set src(value) { queueMicrotask(() => this.onload()); }
    removeAttribute(name) { if (name === "src") state.releasedImages++; }
  }
  const document = { createElement(name) {
    assert.equal(name, "canvas");
    const canvas = {
      getContext: () => ({ fillRect() {}, drawImage: (image, ...coords) => state.draws.push(coords) }),
      toDataURL: type => { assert.equal(type, "image/jpeg"); return encoded; }
    };
    state.canvases.push(canvas);
    return canvas;
  } };
  const scope = { window: {}, Image, document, URL, DOMException };
  vm.runInNewContext(source, scope);
  return { state, defaultJpeg: scope.window.UberQuestImageCrop.defaultJpeg };
}

test("automatic import retains the entire selection screen and releases the pixels", async () => {
  const { state, defaultJpeg } = setup();
  assert.equal(await defaultJpeg(file), jpeg);
  assert.deepEqual(state.draws, [[0, 0, 1320, 2868, 0, 0, 1012, 2200]]);
  assert.equal(state.canvases[0].width, 1);
  assert.equal(state.canvases[0].height, 1);
  assert.equal(state.releasedImages, 1);
});

test("automatic crop scales large screenshots and discards a failed encoding", async () => {
  const { state, defaultJpeg } = setup({ width: 2650, height: 7900, encoded: "data:," });
  await assert.rejects(defaultJpeg(file), /送信用の画像/);
  const [,,,,,,w,h] = state.draws[0];
  assert.ok(w <= 1600 && h <= 2200 && w * h <= 3000000);
  assert.equal(state.canvases[0].width, 1);
  assert.equal(state.releasedImages, 1);
});

test("automatic crop rejects cancelled and unsupported inputs before allocating a canvas", async () => {
  const { state, defaultJpeg } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(defaultJpeg(file, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(defaultJpeg(new Blob(["<svg/>"], { type: "image/jpeg" })), /PNG・JPEG・WebP/);
  assert.equal(state.canvases.length, 0);
});
