(function setupQuestUI() {
  "use strict";
  const core = UberProgressCore;
  const store = UberQuestStore;
  const byId = id => document.getElementById(id);
  const full = Boolean(byId("questView"));
  const yen = value => `¥${Math.round(value).toLocaleString("ja-JP")}`;
  const dateLabel = day => new Date(`${day}T12:00:00+09:00`).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" });
  const timeLabel = at => new Date(at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const jstInput = at => new Date(at + 540 * 60000).toISOString().slice(0, 16);
  const text = (id, value) => { const element = byId(id); if (element) element.textContent = String(value); };
  let editingId = null;
  let displayDay = null;
  let salesDirty = false;
  let tierSerial = 0;
  let lastSelectedId = null;
  let workDaysSignature = "";

  function selected(state) {
    const now = Date.now();
    return state.quests.find(quest => quest.id === state.selectedId)
      || state.quests.find(quest => quest.startAt <= now && now < quest.endAt)
      || state.quests.slice().sort((a, b) => b.startAt - a.startAt)[0];
  }
  function errorMessage(error, id = "questError") {
    const element = byId(id);
    if (element) { element.textContent = error.message || String(error); element.hidden = false; }
  }
  function attempt(action, message) {
    try {
      action();
      if (full) { byId("questError").hidden = true; text("questLive", message || "保存しました。"); }
    } catch (error) { errorMessage(error); }
  }
  function options(select, values, chosen) {
    const signature = JSON.stringify(values);
    if (select.dataset.options !== signature) {
      select.replaceChildren(...values.map(([value, label]) => {
        const option = document.createElement("option"); option.value = value; option.textContent = label; return option;
      }));
      select.dataset.options = signature;
    }
    select.value = String(chosen);
  }
  function renderBrief(state) {
    const now = Date.now();
    const quest = state.quests.find(item => item.startAt <= now && now < item.endAt);
    const brief = byId(full ? "questBrief" : "compactQuestBrief");
    if (!brief) return;
    brief.hidden = !quest;
    if (!quest) return;
    const value = core.calculateQuest(quest, state.entries, now);
    const count = `クエスト ${value.total} / ${value.goal}件`;
    const next = value.nextTier ? `次の報酬まで${value.nextTier.target - value.total}件 ›` : "全段階達成 ›";
    if (full) { text("questBriefCount", count); text("questBriefNext", next); }
    else brief.textContent = `${count} · ${next}`;
  }
  function render() {
    let state;
    try { state = store.read(); } catch (error) { errorMessage(error); return; }
    renderBrief(state);
    if (!full) return;
    const quest = selected(state);
    const formOpen = !byId("questConfigForm").hidden;
    byId("questEmpty").hidden = Boolean(quest) || formOpen;
    byId("questContent").hidden = !quest || formOpen;
    byId("questNew").hidden = formOpen;
    if (!quest) return;
    if (quest.id !== lastSelectedId) { lastSelectedId = quest.id; displayDay = null; salesDirty = false; byId("questAlignDetails").open = false; }
    const value = core.calculateQuest(quest, state.entries, Date.now(), displayDay);
    options(byId("questSelect"), state.quests.slice().sort((a, b) => b.startAt - a.startAt).map(item => [item.id, `${timeLabel(item.startAt)} 〜 ${timeLabel(item.endAt)}`]), quest.id);
    text("questPeriod", `${timeLabel(quest.startAt)} 〜 ${timeLabel(quest.endAt)}`);
    text("questPhase", value.phase === "active" ? "進行中" : value.phase === "upcoming" ? "開始前" : "期間終了");
    text("questTotal", value.total); text("questGoal", `/ ${value.goal}件`);
    const percentage = Math.min(100, value.total / value.goal * 100);
    byId("questFill").style.width = `${percentage}%`;
    byId("questProgress").setAttribute("aria-valuenow", String(Math.round(percentage)));
    byId("questProgress").setAttribute("aria-valuetext", `${value.total}件 / ${value.goal}件`);
    text("questRemaining", value.phase === "ended" ? (value.remaining ? `${value.remaining}件未達で終了` : "目標を達成して終了") : value.remaining ? `目標まであと${value.remaining}件` : "設定した目標を達成");
    text("questNext", value.phase === "ended" ? "達成済み報酬は公式アプリでも確認してください。" : value.nextTier ? `次の追加報酬 ${yen(value.nextTier.reward)} まで${value.nextTier.target - value.total}件` : "全段階を達成しました");
    byId("questTiers").replaceChildren(...quest.tiers.map((tier, index) => {
      const row = document.createElement("div"); row.className = "questTier"; row.dataset.reached = String(value.total >= tier.target);
      const copy = document.createElement("div"); const name = document.createElement("span"); const amount = document.createElement("strong"); const status = document.createElement("em");
      name.textContent = `${index + 1}段目 · 累計${tier.target}件${index === quest.goalIndex ? "（目標）" : ""}`;
      amount.textContent = `＋${yen(tier.reward)}`; status.textContent = value.total >= tier.target ? "達成済み" : "未達成";
      copy.append(name, amount); row.append(copy, status); return row;
    }));
    text("questEarned", yen(value.earnedReward));
    text("questSuggested", value.suggestedToday === null ? "—" : `${value.suggestedToday}件`);
    const target = store.currentDone() + (value.additionalToday || 0);
    const canApply = value.phase === "active" && value.additionalToday > 0 && target <= 80;
    byId("questApplyTarget").disabled = !canApply;
    text("questSuggestedNote", value.phase !== "active" ? "期間中に目標を計算します。" : !value.remaining ? "クエスト目標を達成しています。" : !value.worksToday ? "今日は休みの設定です。" : !value.remainingDays ? "残りの稼働日を選んでください。" : !value.additionalToday ? `今日の目安を達成 · 残り稼働${value.remainingDays}日` : target > 80 ? `今日あと${value.additionalToday}件。今回の上限80件を超えるため、稼働日を見直してください。` : `今日あと${value.additionalToday}件 · 残り稼働${value.remainingDays}日`);
    const signature = `${quest.id}:${value.dates.join(",")}`;
    if (signature !== workDaysSignature) {
      workDaysSignature = signature;
      byId("questWorkDays").replaceChildren(...value.dates.map(day => {
        const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.dataset.questDay = day; input.setAttribute("aria-label", `${dateLabel(day)}に稼働する`);
        label.append(input, document.createTextNode(dateLabel(day))); return label;
      }));
    }
    byId("questWorkDays").querySelectorAll("input").forEach(input => { input.checked = quest.workDays.includes(input.dataset.questDay); });
    options(byId("questSalesDay"), value.dates.map(day => [day, dateLabel(day)]), value.shownDay);
    text("questSalesTitle", `${value.shownDay === value.day ? "今日" : dateLabel(value.shownDay)}の${value.phase === "ended" ? "売上" : "見込み売上"}`);
    text("questSalesTotal", !value.shownDayVerified ? "日別件数が未確認" : value.estimatedSales === null ? "配達売上を入力" : yen(value.estimatedSales));
    text("questBaseSales", value.sales === null ? "未入力" : yen(value.sales));
    text("questAllocationLabel", `クエスト配分${value.phase === "ended" ? "（達成分）" : "（見込み）"}`);
    text("questAllocation", value.allocation === null ? "未集計" : `＋${yen(value.allocation)}`);
    text("questRateNote", !value.shownDayVerified ? "過去分を累計で登録したため、この日への配分は未集計です。登録後の日別件数は自動で記録します。" : value.phase === "ended" ? `期間終了：記録上の達成報酬を全${value.total}件に配分。` : `${value.allocationGoal}件達成を前提に、約${value.rate.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円/件で配分。達成済み報酬は重ねて加算しません。`);
    if (!salesDirty && document.activeElement !== byId("questSalesInput")) byId("questSalesInput").value = value.sales === null ? "" : String(value.sales);
    const hh = String(Math.floor(quest.boundaryMinutes / 60)).padStart(2, "0"); const mm = String(quest.boundaryMinutes % 60).padStart(2, "0");
    text("questDayBoundary", `このクエストの「今日」は日本時間${hh}:${mm}に切り替わります。日次リセットでは期間累計を消しません。`);
    if (state.needsCountCheck) errorMessage("別の画面で件数が変更されました。クエスト累計を保持しています。公式アプリの件数に合わせて確認してください。");
  }
  function showTab(questTab, updateHash = true) {
    byId("progressView").hidden = questTab; byId("questView").hidden = !questTab;
    byId("progressTab").setAttribute("aria-selected", String(!questTab)); byId("questTab").setAttribute("aria-selected", String(questTab));
    document.body.classList.toggle("questMode", questTab);
    if (updateHash && typeof history.replaceState === "function") history.replaceState(null, "", questTab ? "#quest" : location.pathname + location.search);
    window.dispatchEvent(new Event("resize"));
    render();
  }
  function tierRows() { return Array.from(byId("questTierInputs").querySelectorAll(".questTierInput")); }
  function refreshTierLabels(wanted) {
    const rows = tierRows();
    rows.forEach((row, index) => { row.querySelector(".questTierNumber").textContent = `${index + 1}段目`; row.querySelector("button").hidden = rows.length === 1; });
    const current = wanted === undefined ? Number(byId("questGoalInput").value) || 0 : wanted;
    options(byId("questGoalInput"), rows.map((row, index) => [String(index), `${index + 1}段目まで達成を目指す`]), Math.min(current, rows.length - 1));
    byId("questAddTier").disabled = rows.length >= 5;
  }
  function addTier(target = "", reward = "") {
    const serial = ++tierSerial;
    const row = document.createElement("div"); row.className = "questTierInput";
    row.innerHTML = `<div class="questBetween"><strong class="questTierNumber"></strong><button type="button" class="questTextButton">この段階を外す</button></div><div class="questFormPair"><label class="questField" for="questTierCount${serial}">必要件数（累計）<input id="questTierCount${serial}" data-tier-count type="number" min="1" max="9999" step="1" inputmode="numeric" required></label><label class="questField" for="questTierReward${serial}">追加報酬（円）<input id="questTierReward${serial}" data-tier-reward type="number" min="0" max="9999999" step="1" inputmode="numeric" required></label></div>`;
    row.querySelector("[data-tier-count]").value = String(target); row.querySelector("[data-tier-reward]").value = String(reward);
    row.querySelector("button").addEventListener("click", () => { row.remove(); refreshTierLabels(); byId("questAddTier").focus(); });
    byId("questTierInputs").appendChild(row); refreshTierLabels();
  }
  function fillTemplate() {
    const kind = byId("questTemplate").value;
    if (kind === "custom") return;
    const date = new Date(`${core.questDayKey(Date.now())}T00:00:00Z`);
    const offset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - offset + (kind === "weekend" ? 4 : 0));
    byId("questStartDate").value = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + (kind === "weekend" ? 3 : 4));
    byId("questEndDate").value = date.toISOString().slice(0, 10);
  }
  function openForm(isNew) {
    try {
      const state = store.read(); const quest = isNew ? null : selected(state);
      editingId = quest ? quest.id : "new";
      byId("questConfigForm").reset(); byId("questConfigForm").hidden = false;
      byId("questConfigError").hidden = true; byId("questTierInputs").replaceChildren();
      text("questFormTitle", quest ? "クエストを編集" : "クエストを登録");
      byId("questInitialCounts").hidden = Boolean(quest);
      byId("questInitialTotal").required = !quest; byId("questInitialToday").required = !quest;
      if (quest) {
        const start = jstInput(quest.startAt).split("T"); const end = jstInput(quest.endAt).split("T");
        byId("questTemplate").value = quest.template || "custom";
        byId("questStartDate").value = start[0]; byId("questStartTime").value = start[1]; byId("questEndDate").value = end[0]; byId("questEndTime").value = end[1];
        quest.tiers.forEach(tier => addTier(tier.target, tier.reward)); refreshTierLabels(quest.goalIndex);
      } else { fillTemplate(); addTier(120, ""); }
      render(); byId("questTemplate").focus();
    } catch (error) { errorMessage(error); }
  }
  function closeForm() { byId("questConfigForm").hidden = true; editingId = null; render(); byId("questNew").focus(); }
  function checkPeriodEdit() {
    if (!editingId || editingId === "new") return;
    try {
      const quest = store.read().quests.find(item => item.id === editingId);
      const changed = `${byId("questStartDate").value}T${byId("questStartTime").value}` !== jstInput(quest.startAt) || `${byId("questEndDate").value}T${byId("questEndTime").value}` !== jstInput(quest.endAt);
      byId("questInitialCounts").hidden = !changed;
      byId("questInitialTotal").required = changed; byId("questInitialToday").required = changed;
    } catch (error) { errorMessage(error, "questConfigError"); }
  }

  window.addEventListener("questchange", event => {
    if (event.detail && event.detail.error) errorMessage(event.detail.error);
    else render();
  });
  window.addEventListener("storage", event => { if (event.key === core.QUEST_STORAGE_KEY || event.key === core.STORAGE_KEYS.progress || event.key === null) render(); });
  window.addEventListener("pageshow", render);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });
  window.setInterval(() => { if (!document.hidden) render(); }, 30000);
  if (!full) { render(); return; }

  byId("progressTab").addEventListener("click", () => showTab(false));
  byId("questTab").addEventListener("click", () => showTab(true));
  for (const id of ["progressTab", "questTab"]) byId(id).addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? false : event.key === "End" ? true : id === "progressTab";
    showTab(next); byId(next ? "questTab" : "progressTab").focus();
  });
  window.addEventListener("hashchange", () => showTab(location.hash === "#quest", false));
  byId("questBrief").addEventListener("click", () => {
    attempt(() => store.update(state => ({ ...state, selectedId: (state.quests.find(quest => quest.startAt <= Date.now() && Date.now() < quest.endAt) || selected(state)).id })), "");
    showTab(true);
  });
  byId("questNew").addEventListener("click", () => openForm(true)); byId("questFirst").addEventListener("click", () => openForm(true));
  byId("questEdit").addEventListener("click", () => openForm(false)); byId("questCancel").addEventListener("click", closeForm);
  byId("questTemplate").addEventListener("change", () => { fillTemplate(); checkPeriodEdit(); });
  for (const id of ["questStartDate", "questStartTime", "questEndDate", "questEndTime"]) byId(id).addEventListener("change", checkPeriodEdit);
  byId("questAddTier").addEventListener("click", () => { if (tierRows().length < 5) { addTier(); refreshTierLabels(tierRows().length - 1); } });
  byId("questSelect").addEventListener("change", event => attempt(() => store.update(state => ({ ...state, selectedId: event.target.value })), "表示する期間を変更しました。"));
  byId("questConfigForm").addEventListener("submit", event => {
    event.preventDefault();
    try {
      const state = store.read(); const old = state.quests.find(quest => quest.id === editingId);
      const startAt = Date.parse(`${byId("questStartDate").value}T${byId("questStartTime").value}:00+09:00`);
      const endAt = Date.parse(`${byId("questEndDate").value}T${byId("questEndTime").value}:00+09:00`);
      const [hours, minutes] = byId("questStartTime").value.split(":").map(Number);
      const quest = { ...old, id: old ? old.id : `quest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, startAt, endAt, boundaryMinutes: hours * 60 + minutes, template: byId("questTemplate").value, tiers: tierRows().map(row => ({ target: Number(row.querySelector("[data-tier-count]").value), reward: Number(row.querySelector("[data-tier-reward]").value) })), goalIndex: Number(byId("questGoalInput").value), adjustments: old ? old.adjustments : {}, sales: old ? old.sales : {} };
      const error = core.validateQuest(quest, state.quests); if (error) throw new Error(error);
      const changedPeriod = old && (old.startAt !== startAt || old.endAt !== endAt);
      const needsAlign = !old || changedPeriod;
      if (needsAlign && (byId("questInitialTotal").value === "" || byId("questInitialToday").value === "")) throw new Error("この期間の公式の累計と今日の件数を入力してください。");
      if (changedPeriod) { quest.adjustments = {}; quest.unverifiedDays = []; }
      quest.workDays = old && !changedPeriod ? old.workDays : core.questDateKeys(quest);
      store.putQuest(quest, { align: needsAlign, total: Number(byId("questInitialTotal").value), today: Number(byId("questInitialToday").value) });
      closeForm(); text("questLive", "クエストを保存しました。");
    } catch (error) { errorMessage(error, "questConfigError"); }
  });
  byId("questWorkDays").addEventListener("change", event => {
    const input = event.target; if (!input.dataset.questDay) return;
    attempt(() => store.update(state => {
      const quest = selected(state); const days = new Set(quest.workDays);
      if (input.checked) days.add(input.dataset.questDay); else days.delete(input.dataset.questDay);
      return { ...state, quests: state.quests.map(item => item.id === quest.id ? { ...item, workDays: [...days].sort() } : item) };
    }), "稼働日を更新しました。");
  });
  byId("questApplyTarget").addEventListener("click", () => attempt(() => {
    const state = store.read(); const value = core.calculateQuest(selected(state), state.entries);
    const target = store.currentDone() + (value.additionalToday || 0);
    if (!value.additionalToday || target < 1 || target > 80) throw new Error("今回の目標を1〜80件に収められるよう、稼働日を確認してください。");
    const select = byId("target");
    if (!Array.from(select.options).some(option => Number(option.value) === target)) { const option = document.createElement("option"); option.value = String(target); option.textContent = `${target}件`; select.appendChild(option); }
    select.value = String(target);
    if (save() === false) throw new Error("目標を保存できませんでした。");
    calc(); text("questLive", `今回の目標を${target}件に設定しました（ここからあと${value.additionalToday}件）。`);
  }, "進捗画面の目標に反映しました。"));
  byId("questSalesDay").addEventListener("change", event => { displayDay = event.target.value; salesDirty = false; render(); });
  byId("questSalesInput").addEventListener("input", () => { salesDirty = true; });
  byId("questSalesForm").addEventListener("submit", event => {
    event.preventDefault(); attempt(() => {
      const amount = Number(byId("questSalesInput").value); if (!Number.isInteger(amount) || amount < 0 || amount > 9999999) throw new Error("配達売上を0〜9,999,999円の整数で入力してください。");
      const day = byId("questSalesDay").value;
      store.update(state => { const quest = selected(state); return { ...state, quests: state.quests.map(item => item.id === quest.id ? { ...item, sales: { ...item.sales, [day]: amount } } : item) }; });
      salesDirty = false; render();
    }, "配達売上を保存しました。");
  });
  byId("questAlignDetails").addEventListener("toggle", () => {
    if (!byId("questAlignDetails").open) return;
    try { const state = store.read(); const value = core.calculateQuest(selected(state), state.entries); byId("questAlignTotal").value = String(value.total); byId("questAlignToday").value = String(value.today); } catch (error) { errorMessage(error); }
  });
  byId("questAlignForm").addEventListener("submit", event => {
    event.preventDefault(); attempt(() => {
      const total = Number(byId("questAlignTotal").value); const today = Number(byId("questAlignToday").value);
      const state = store.read(); store.putQuest(selected(state), { align: true, total, today });
      if (state.needsCountCheck) store.update(next => ({ ...next, needsCountCheck: false }));
      byId("questAlignDetails").open = false;
    }, "公式アプリの件数に合わせました。進捗画面の完了件数は変更しません。");
  });
  showTab(location.hash === "#quest", false);
})();
