(function exposeQuestStore(root) {
  "use strict";
  const core = root.UberProgressCore;
  const KEY = core.QUEST_STORAGE_KEY;
  const PROGRESS_KEY = core.STORAGE_KEYS.progress;
  let lastError = "";

  function readProgress() {
    const value = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function currentDone() {
    try { return Math.max(0, Number(readProgress().done) || 0); } catch (_) { return 0; }
  }
  function read() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return core.createQuestState(currentDone());
    const state = JSON.parse(raw);
    if (!state || state.version !== 1 || !state.counter || !Number.isInteger(state.counter.done) || !Number.isInteger(state.counter.epoch) || !Number.isFinite(state.counter.startedAt) || !Number.isInteger(state.sequence) || !Array.isArray(state.entries) || !Array.isArray(state.quests)) {
      throw new Error("クエストの保存データを読み込めません。データを上書きせず保持しています。");
    }
    if (state.entries.some(entry => !entry || !Number.isFinite(entry.at) || !Number.isInteger(entry.quantity) || !Number.isInteger(entry.epoch))) throw new Error("クエストの件数記録を読み込めません。");
    if (state.quests.some(quest => core.validateQuest(quest) || !Array.isArray(quest.workDays) || new Set(quest.workDays).size !== quest.workDays.length || quest.workDays.some(day => !core.questDateKeys(quest).includes(day)) || !quest.adjustments || typeof quest.adjustments !== "object" || Array.isArray(quest.adjustments) || !quest.sales || typeof quest.sales !== "object" || Array.isArray(quest.sales))) throw new Error("クエストの設定を読み込めません。");
    return state;
  }
  function notify(error = "") {
    if (typeof root.dispatchEvent === "function" && typeof root.CustomEvent === "function") root.dispatchEvent(new root.CustomEvent("questchange", { detail: { error } }));
  }
  function report(error) {
    const message = error && error.message ? error.message : "クエストを保存できませんでした。端末の空き容量を確認してください。";
    notify(message);
    if (message !== lastError && typeof root.alert === "function") root.alert(message);
    lastError = message;
  }
  function update(mutator) {
    const state = read();
    const next = mutator(state) || state;
    localStorage.setItem(KEY, JSON.stringify(next));
    lastError = "";
    notify();
    return next;
  }
  function saveProgress(data, { reset = false, countChange = false } = {}) {
    const oldQuest = localStorage.getItem(KEY);
    const oldProgress = localStorage.getItem(PROGRESS_KEY);
    let changedQuest = false;
    try {
      const previous = readProgress();
      // Timer/theme/card edits from another view must never overwrite a newer count.
      if (!reset && !countChange && previous.done !== undefined) data = { ...data, done: previous.done };
      const nextDone = Math.max(0, Math.floor(Number(data.done) || 0));
      const beforeDone = Math.max(0, Math.floor(Number(previous.done) || 0));
      if (reset || nextDone !== beforeDone) {
        let state = read();
        // Old versions cannot distinguish resets from corrections. Preserve recorded totals.
        if (state.counter.done !== beforeDone) state = { ...state, counter: { ...state.counter, done: beforeDone, epoch: state.counter.epoch + 1, startedAt: Date.now() }, needsCountCheck: true };
        state = core.changeQuestCount(state, nextDone, { reset });
        localStorage.setItem(KEY, JSON.stringify(state));
        changedQuest = true;
      }
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
      lastError = "";
      notify();
      return true;
    } catch (error) {
      // Never leave an extra quest delivery when the original progress write fails.
      try {
        if (changedQuest) {
          if (oldQuest === null) localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, oldQuest);
        }
        if (oldProgress !== null && localStorage.getItem(PROGRESS_KEY) !== oldProgress) localStorage.setItem(PROGRESS_KEY, oldProgress);
      } catch (_) {}
      report(error);
      return false;
    }
  }
  function resetCounter() {
    try { return saveProgress({ ...readProgress(), done: "0" }, { reset: true }); }
    catch (error) { report(error); return false; }
  }
  function putQuest(quest, { total, today, align = false } = {}) {
    return update(state => {
      const error = core.validateQuest(quest, state.quests);
      if (error) throw new Error(error);
      if (align) quest = core.alignQuestCounts(quest, state.entries, total, today);
      const exists = state.quests.some(item => item.id === quest.id);
      return { ...state, selectedId: quest.id, quests: exists ? state.quests.map(item => item.id === quest.id ? quest : item) : [...state.quests, quest] };
    });
  }
  root.UberQuestStore = Object.freeze({ read, update, currentDone, saveProgress, resetCounter, putQuest, report });
})(typeof window === "object" ? window : globalThis);
