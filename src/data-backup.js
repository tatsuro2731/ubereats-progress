(function exposeDataBackup(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.UberDataBackup = api;
})(typeof globalThis === "object" ? globalThis : this, function createDataBackup() {
  "use strict";

  // Every saved value of this app uses this prefix. Keys and their formats are
  // copied as-is, so a backup never changes the storage contract.
  const KEY_PREFIX = "ubereatsProgress";
  const APP_ID = "ubereats-progress";
  const FORMAT = 1;
  const MAX_BACKUP_CHARS = 4 * 1024 * 1024;

  function appKeys(storage) {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && key.startsWith(KEY_PREFIX)) keys.push(key);
    }
    return keys.sort();
  }

  function createBackup(storage, now = Date.now()) {
    const items = {};
    for (const key of appKeys(storage)) {
      const value = storage.getItem(key);
      if (value !== null) items[key] = value;
    }
    return { app: APP_ID, format: FORMAT, exportedAt: new Date(now).toISOString(), items };
  }

  function backupFileName(now = Date.now()) {
    const date = new Date(now);
    const pad = value => String(value).padStart(2, "0");
    return `ubereats-progress-backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
  }

  function parseBackup(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("ファイルが空です。");
    if (text.length > MAX_BACKUP_CHARS) throw new Error("ファイルが大きすぎます。このアプリのバックアップか確認してください。");
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error("バックアップファイルの形式ではありません。"); }
    if (!data || typeof data !== "object" || Array.isArray(data) || data.app !== APP_ID) {
      throw new Error("このアプリのバックアップではありません。");
    }
    if (data.format !== FORMAT) throw new Error("対応していないバックアップ形式です。アプリを更新してからお試しください。");
    const items = data.items;
    if (!items || typeof items !== "object" || Array.isArray(items)) throw new Error("バックアップの中身を読み込めません。");
    const entries = Object.entries(items);
    if (!entries.length) throw new Error("バックアップに記録が入っていません。");
    for (const [key, value] of entries) {
      if (!key.startsWith(KEY_PREFIX) || typeof value !== "string") throw new Error("バックアップの中身を読み込めません。");
    }
    return { exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : "", items };
  }

  // Replaces every app key with the backup. If any write fails, the previous
  // values are put back so a half-restored state is never left behind.
  function restoreBackup(storage, backup) {
    const previous = new Map(appKeys(storage).map(key => [key, storage.getItem(key)]));
    try {
      for (const key of previous.keys()) {
        if (!Object.prototype.hasOwnProperty.call(backup.items, key)) storage.removeItem(key);
      }
      for (const [key, value] of Object.entries(backup.items)) storage.setItem(key, value);
      return true;
    } catch (error) {
      try {
        for (const key of appKeys(storage)) if (!previous.has(key)) storage.removeItem(key);
        for (const [key, value] of previous) storage.setItem(key, value);
      } catch (_) {}
      throw new Error("復元できませんでした。元の記録はそのまま残しています。端末の空き容量を確認してください。");
    }
  }

  function exportedLabel(value) {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return "日時不明";
    return new Date(time).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function bindUi(doc, win) {
    const exportButton = doc.getElementById("backupExport");
    const importButton = doc.getElementById("backupImport");
    const fileInput = doc.getElementById("backupFile");
    const status = doc.getElementById("backupStatus");
    if (!exportButton || !importButton || !fileInput || !status) return;
    const say = message => { status.textContent = message; };

    exportButton.addEventListener("click", async () => {
      const now = Date.now();
      let text;
      try { text = JSON.stringify(createBackup(win.localStorage, now), null, 1); }
      catch (_) { say("記録を読み出せませんでした。"); return; }
      const name = backupFileName(now);
      const type = "application/json";
      try {
        const file = typeof win.File === "function" ? new win.File([text], name, { type }) : null;
        if (file && win.navigator.canShare && win.navigator.canShare({ files: [file] })) {
          await win.navigator.share({ files: [file], title: "配達進捗のバックアップ" });
          say(`${name} を書き出しました。「ファイルに保存」などで保管してください。`);
          return;
        }
      } catch (error) {
        if (error && error.name === "AbortError") { say("書き出しをキャンセルしました。"); return; }
      }
      const url = win.URL.createObjectURL(new win.Blob([text], { type }));
      const link = doc.createElement("a");
      link.href = url;
      link.download = name;
      doc.body.appendChild(link);
      link.click();
      link.remove();
      win.setTimeout(() => win.URL.revokeObjectURL(url), 10000);
      say(`${name} を書き出しました。`);
    });

    importButton.addEventListener("click", () => {
      fileInput.value = "";
      fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      let backup;
      try { backup = parseBackup(await file.text()); }
      catch (error) { say(error.message); return; }
      const message = `${exportedLabel(backup.exportedAt)} のバックアップで、今の件数・時計・履歴・クエスト・設定をすべて置き換えます。よろしいですか？`;
      if (!win.confirm(message)) { say("読み込みをキャンセルしました。"); return; }
      const core = win.UberProgressCore;
      if (core && core.setStorageFrozen) core.setStorageFrozen(true);
      try { restoreBackup(win.localStorage, backup); }
      catch (error) {
        if (core && core.setStorageFrozen) core.setStorageFrozen(false);
        say(error.message);
        return;
      }
      say("復元しました。画面を読み込み直します。");
      win.location.reload();
    });
  }

  if (typeof document === "object" && typeof window === "object") {
    const start = () => bindUi(document, window);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }

  return Object.freeze({ KEY_PREFIX, APP_ID, FORMAT, appKeys, createBackup, backupFileName, parseBackup, restoreBackup });
});
