// Only the initiating browser keeps the private key. Neither navigation URL
// contains usable Identity credentials, including when browser history syncs.
const agreement = { name: "ECDH", namedCurve: "P-256" };
const encoder = new TextEncoder();

function encode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value, maxLength) {
  if (typeof value !== "string" || !value.length || value.length > maxLength || !/^[\w-]+$/.test(value)) {
    throw new Error("本人確認の情報が正しくありません。");
  }
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}

async function sharedKey(privateKey, publicValue) {
  const publicKey = await crypto.subtle.importKey("raw", decode(publicValue, 88), agreement, false, []);
  return crypto.subtle.deriveKey({ name: "ECDH", public: publicKey }, privateKey,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function startTransfer() {
  const pair = await crypto.subtle.generateKey(agreement, true, ["deriveKey"]);
  return {
    state: encode(crypto.getRandomValues(new Uint8Array(16))),
    publicKey: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    started: Date.now()
  };
}

export function isCurrent(request) {
  return Boolean(request && /^[\w-]{22}$/.test(request.state) && /^[\w-]{87}$/.test(request.publicKey) &&
    Number.isSafeInteger(request.started) && request.started <= Date.now() && Date.now() - request.started < 600000);
}

export async function sealCredential(request, refreshToken) {
  if (!isCurrent(request) || !refreshToken || refreshToken.length > 4096) throw new Error("本人確認をやり直してください。");
  const pair = await crypto.subtle.generateKey(agreement, true, ["deriveKey"]);
  const key = await sharedKey(pair.privateKey, request.publicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(request.state) },
    key, encoder.encode(refreshToken));
  return new URLSearchParams({ "quest-finish": request.state,
    peer: encode(await crypto.subtle.exportKey("raw", pair.publicKey)), iv: encode(iv), data: encode(data) });
}

export async function openCredential(request, result) {
  if (!isCurrent(request) || result.get("quest-finish") !== request.state) throw new Error("本人確認の有効期限が切れました。");
  const privateKey = await crypto.subtle.importKey("jwk", request.privateKey, agreement, false, ["deriveKey"]);
  const key = await sharedKey(privateKey, result.get("peer"));
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(result.get("iv"), 16),
    additionalData: encoder.encode(request.state) }, key, decode(result.get("data"), 5600));
  return new TextDecoder().decode(bytes);
}
