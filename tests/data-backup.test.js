"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const backup = require("../src/data-backup.js");

class MemoryStorage {
  constructor(entries = {}, failOn = null) {
    this.values = new Map(Object.entries(entries));
    this.failOn = failOn;
  }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (key === this.failOn) throw new Error("QuotaExceededError");
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

const saved = {
  ubereatsProgressFixed12Data: JSON.stringify({ target: "46", done: "12" }),
  ubereatsProgressMovementClockV1: JSON.stringify({ on: true, remainingMs: 1234567 }),
  ubereatsProgressWorkHistoryV1: "[]",
  ubereatsProgressQuestV1: JSON.stringify({ version: 1 }),
  ubereatsProgressAppearanceV1: JSON.stringify({ mode: "dark" }),
  "ubereatsProgressPaceDisplayMode:need": "rate"
};

test("a backup copies every app key byte-for-byte and ignores other sites' keys", () => {
  const storage = new MemoryStorage({ ...saved, unrelated: "keep out" });
  const file = backup.createBackup(storage, Date.UTC(2026, 8, 23, 6, 5));
  assert.equal(file.app, "ubereats-progress");
  assert.equal(file.format, 1);
  assert.deepEqual(file.items, saved);
  assert.equal(file.exportedAt, "2026-09-23T06:05:00.000Z");
  assert.match(backup.backupFileName(Date.now()), /^ubereats-progress-backup-\d{8}-\d{4}\.json$/);
});

test("restoring replaces app keys exactly, keeps unrelated keys and round-trips", () => {
  const source = new MemoryStorage(saved);
  const text = JSON.stringify(backup.createBackup(source));
  const target = new MemoryStorage({ ubereatsProgressFixed12Data: "{\"done\":\"99\"}", ubereatsProgressStale: "x", unrelated: "keep" });
  backup.restoreBackup(target, backup.parseBackup(text));
  for (const [key, value] of Object.entries(saved)) assert.equal(target.getItem(key), value);
  assert.equal(target.getItem("ubereatsProgressStale"), null, "keys absent from the backup are removed");
  assert.equal(target.getItem("unrelated"), "keep");
});

test("a failed restore puts every previous value back", () => {
  const before = { ubereatsProgressFixed12Data: "{\"done\":\"5\"}", ubereatsProgressOld: "old" };
  const target = new MemoryStorage(before, "ubereatsProgressWorkHistoryV1");
  assert.throws(() => backup.restoreBackup(target, { items: saved }), /元の記録はそのまま/);
  assert.deepEqual(Object.fromEntries(target.values), before);
});

test("files that are not this app's backup are rejected before anything is written", () => {
  const cases = [
    "",
    "not json",
    JSON.stringify({ app: "other", format: 1, items: saved }),
    JSON.stringify({ app: "ubereats-progress", format: 2, items: saved }),
    JSON.stringify({ app: "ubereats-progress", format: 1, items: {} }),
    JSON.stringify({ app: "ubereats-progress", format: 1, items: { otherKey: "x" } }),
    JSON.stringify({ app: "ubereats-progress", format: 1, items: { ubereatsProgressFixed12Data: { done: 1 } } })
  ];
  for (const text of cases) assert.throws(() => backup.parseBackup(text), Error, text.slice(0, 40));
});
