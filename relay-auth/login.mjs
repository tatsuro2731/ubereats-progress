import { getSettings, oauthLogin, handleAuthCallback } from "@netlify/identity";
import { isCurrent, sealCredential } from "../src/quest-owner-transfer.mjs";

const pages = "https://tatsuro2731.github.io/ubereats-progress/";
const pendingKey = "questOwnerLogin";
const status = document.getElementById("status");
const cleanUrl = () => history.replaceState(null, "", "/");
class LoginError extends Error {}

async function login() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has("quest-start")) {
    cleanUrl();
    const request = { state: fragment.get("quest-start"), publicKey: fragment.get("peer"), started: Date.now() };
    if (!isCurrent(request)) throw new LoginError("配達進捗のアプリから本人確認を開始してください。");
    sessionStorage.setItem(pendingKey, JSON.stringify(request));
    const settings = await getSettings();
    if (!settings.providers.google) throw new LoginError("Googleでの本人確認が有効になっていません。");
    status.textContent = "Googleで本人確認を行います。";
    // The official SDK initiates navigation and then throws synchronously.
    try { oauthLogin("google"); } catch (error) {
      if (error?.message !== "Redirecting to OAuth provider") throw error;
    }
    return;
  }
  const request = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
  sessionStorage.removeItem(pendingKey);
  if (!isCurrent(request)) {
    cleanUrl();
    throw new LoginError("配達進捗のアプリから本人確認を開始してください。");
  }
  if (!fragment.get("access_token") || !fragment.get("refresh_token")) {
    cleanUrl();
    throw new LoginError("本人確認が完了しませんでした。アプリからもう一度お試しください。");
  }
  let result;
  try { result = await handleAuthCallback(); } finally { cleanUrl(); }
  if (result?.type !== "oauth" || !result.user) throw new LoginError("本人確認を完了できませんでした。");
  const verified = await fetch("/api/quest-progress", { method: "GET", credentials: "omit", redirect: "error",
    cache: "no-store", headers: { Authorization: "Bearer " + fragment.get("access_token") } });
  if (verified.status !== 204) {
    throw new LoginError(verified.status === 403 ? "このアカウントにはクエスト読み取りの利用権限がありません。" :
      "本人確認サービスでアカウントを確認できませんでした。");
  }
  const reply = await sealCredential(request, fragment.get("refresh_token"));
  location.replace(pages + "#" + reply);
}

login().catch(error => {
  cleanUrl();
  // Third-party SDK/network errors may include provider data. Display only
  // the messages explicitly written for this page.
  status.textContent = error instanceof LoginError ? error.message : "本人確認に失敗しました。通信を確認し、アプリからもう一度お試しください。";
});
