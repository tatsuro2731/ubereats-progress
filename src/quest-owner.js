(function setupQuestOwner() {
  "use strict";
  const relay = "https://ubereats-quest-reader.netlify.app";
  const readUrl = relay + "/api/quest-progress";
  const identity = relay + "/.netlify/identity";
  // These keys deliberately live outside the app's data-backup namespace.
  const sessionKey = "questOwnerIdentity.v1";
  const pendingKey = "questOwnerAuthorization.v1";
  const authMessage = "本人確認の有効期限が切れました。もう一度ログインしてください。";
  let refreshing = null;

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function hasSession() {
    return Boolean(load(sessionKey)?.refresh);
  }

  async function signIn() {
    const { startTransfer } = await import("./quest-owner-transfer.mjs?v=107");
    const request = await startTransfer();
    try { localStorage.setItem(pendingKey, JSON.stringify(request)); } catch {
      throw new Error("本人確認には、このブラウザーのサイトデータ保存を許可してください。");
    }
    const query = new URLSearchParams({ "quest-start": request.state, peer: request.publicKey });
    location.assign(relay + "/#" + query);
  }

  async function exchange(refresh) {
    const response = await fetch(identity + "/token", {
      method: "POST", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh })
    });
    if (!response.ok) {
      const invalid = [400, 401, 403].includes(response.status);
      if (invalid && load(sessionKey)?.refresh === refresh) localStorage.removeItem(sessionKey);
      throw new Error(invalid ? authMessage : "本人確認サービスに接続できませんでした。");
    }
    const data = await response.json();
    if (typeof data.access_token !== "string" || !data.access_token || typeof data.refresh_token !== "string" ||
        !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error(authMessage);
    return { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000 };
  }

  async function init() {
    const result = new URLSearchParams(location.hash.slice(1));
    if (!result.has("quest-finish")) return false;
    history.replaceState(history.state, "", location.pathname + location.search);
    const pending = load(pendingKey);
    if (!pending || pending.state !== result.get("quest-finish")) {
      throw new Error("本人確認を開始したブラウザーでアプリを開き、もう一度お試しください。");
    }
    try {
      const { openCredential } = await import("./quest-owner-transfer.mjs?v=107");
      const refresh = await openCredential(pending, result);
      const session = await exchange(refresh);
      // The encrypted handoff identifies the recipient, not the issuer.
      // Confirm ownership with the relay before enabling uploads on this device.
      const verified = await fetch(readUrl, { method: "GET", credentials: "omit", redirect: "error",
        cache: "no-store", referrerPolicy: "no-referrer", headers: { Authorization: "Bearer " + session.access } });
      if (verified.status !== 204) throw new Error(authMessage);
      if (load(pendingKey)?.state !== pending.state) throw new Error(authMessage);
      localStorage.setItem(sessionKey, JSON.stringify(session));
      return true;
    } catch {
      throw new Error("本人確認を完了できませんでした。アプリからもう一度お試しください。");
    } finally {
      if (load(pendingKey)?.state === pending.state) localStorage.removeItem(pendingKey);
    }
  }

  async function currentAccess() {
    const saved = load(sessionKey);
    if (!saved?.refresh) throw new Error(authMessage);
    if (saved.access && saved.expires > Date.now() + 60000) return saved.access;
    const session = await exchange(saved.refresh);
    if (load(sessionKey)?.refresh !== saved.refresh) throw new Error(authMessage);
    localStorage.setItem(sessionKey, JSON.stringify(session));
    return session.access;
  }

  async function getAccess() {
    // Identity rotates refresh tokens. Other tabs must observe the new value
    // before using it, and concurrent reads in this tab share the same work.
    if (!refreshing) {
      const work = navigator.locks ? navigator.locks.request(sessionKey, currentAccess) : currentAccess();
      refreshing = work.finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function prepareRead() {
    // The file picker can stay open while a stale session is renewed. A read
    // that starts sooner joins the same refresh and still verifies the owner.
    if (hasSession()) await getAccess().catch(() => {});
  }

  function signOut() {
    const access = load(sessionKey)?.access;
    localStorage.removeItem(sessionKey);
    localStorage.removeItem(pendingKey);
    if (access) fetch(identity + "/logout", {
      method: "POST", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      headers: { Authorization: "Bearer " + access }
    }).catch(() => {});
  }

  function jpegBytes(imageUrl) {
    const prefix = "data:image/jpeg;base64,";
    const max = 2 * 1024 * 1024;
    const error = "送信するクエスト画像の範囲を小さくしてください。";
    if (typeof imageUrl !== "string" || imageUrl.length > prefix.length + Math.ceil(max / 3) * 4 ||
        !imageUrl.startsWith(prefix + "/9j/")) throw new Error(error);
    let binary;
    try { binary = atob(imageUrl.slice(prefix.length)); } catch { throw new Error(error); }
    if (binary.length > max) throw new Error(error);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  async function read({ imageUrl, signal, progressHint }) {
    const image = jpegBytes(imageUrl);
    const access = await getAccess();
    if (signal?.aborted) throw new DOMException("読み取りを中止しました。", "AbortError");
    const headers = { Authorization: "Bearer " + access, "Content-Type": "image/jpeg" };
    if (progressHint) headers["X-Quest-Progress"] = JSON.stringify(progressHint);
    const response = await fetch(readUrl, {
      method: "POST", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal,
      headers, body: image
    });
    if (response.status === 401 || response.status === 403) {
      if (load(sessionKey)?.access === access) signOut();
      throw new Error(response.status === 403 ? "このアカウントには利用権限がありません。" : authMessage);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || "クエストのAPI読み取りに失敗しました。");
    if (payload?.screen === "count" && progressHint && Number.isInteger(payload.completed) &&
        payload.completed >= 0 && payload.completed <= progressHint.tiers[0].target) {
      return { screen: "count", completed: payload.completed };
    }
    const selection = payload?.screen === "selection";
    const candidates = payload?.candidates;
    if ((!selection && payload?.screen !== "progress") || !Array.isArray(candidates) ||
        !candidates.length || candidates.length > (selection ? 20 : 1) ||
        !Number.isInteger(payload.skipped) || payload.skipped < 0 ||
        !candidates.every(c => typeof c?.label === "string" && Array.isArray(c.tiers) &&
          c.tiers.length > 0 && c.tiers.length <= 5 &&
          c.tiers.every((t, i) => Number.isInteger(t?.target) && t.target > (i ? c.tiers[i - 1].target : 0) &&
            t.target <= 9999 && Number.isInteger(t.reward) && t.reward >= 0 && t.reward <= 9999999) &&
          (selection ? c.completed === undefined : Number.isInteger(c.completed) && c.completed >= 0 && c.completed <= c.tiers[0].target))) {
      throw new Error("読み取り結果から件数と報酬を確認できませんでした。");
    }
    return { screen: payload.screen, periodText: typeof payload.periodText === "string" ? payload.periodText : null, candidates, skipped: payload.skipped };
  }

  window.UberQuestOwner = { hasSession, signIn, signOut, init, prepareRead, read };
})();
