import questImageApi from "../../src/quest-image-api.js";

const appOrigin = "https://tatsuro2731.github.io";
const maxBytes = 2 * 1024 * 1024;
const unavailable = "自動補完のサーバーを利用できません。時間をおいてお試しください。";
const loginRequired = "もう一度、クエスト読み取りの本人確認をしてください。";
const forbidden = "このアカウントではクエストの自動補完を利用できません。";

// Canvas produces a baseline or progressive JPEG within these bounds (quest-image-crop.js).
function isCroppedJpeg(bytes) {
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  let offset = 2;
  let hasFrame = false;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > bytes.length) return false;
    if (marker === 0xda) return hasFrame && size >= 8 && offset + 2 + size < bytes.length - 2;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (size < 11) return false;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width === 0 || height === 0 || width > 1600 || height > 2200 || width * height > 3000000) return false;
      hasFrame = true;
    }
    offset += 2 + size;
  }
  return false;
}

async function readBody(body) {
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export default async function questProgress(request, context) {
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  const fail = (status, error) => request.method === "HEAD"
    ? new Response(null, { status, headers })
    : Response.json({ error }, { status, headers });
  // Netlify can forward a HEAD request to the function as GET.
  const ownerCheck = request.method === "GET" || request.method === "HEAD";
  const allowedMethods = "POST, GET, HEAD, OPTIONS";
  const origin = request.headers.get("Origin");
  const relayOwnerCheck = ownerCheck && (!origin || origin === context.site?.url?.replace(/\/$/, ""));
  if (origin === appOrigin) headers.set("Access-Control-Allow-Origin", appOrigin);
  else if (!relayOwnerCheck) return fail(403, forbidden);
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", allowedMethods);
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST" && !ownerCheck) {
    headers.set("Allow", allowedMethods);
    return fail(405, "画像はPOSTで送信してください。");
  }
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer [^\s,]+$/i.test(auth) || auth.length > 16384) return fail(401, loginRequired);
  const key = Netlify.env.get("QUEST_OPENAI_API_KEY");
  const ownerId = Netlify.env.get("QUEST_OWNER_ID");
  const ownerEmail = Netlify.env.get("QUEST_OWNER_EMAIL")?.trim().toLowerCase();
  if (!key || !(ownerId || ownerEmail) || !context.site?.url) return fail(503, unavailable);

  try {
    // The site URL comes from Netlify's runtime, never from the client Host header.
    const identity = new URL("/.netlify/identity/", context.site.url);
    if (identity.protocol !== "https:") return fail(503, unavailable);
    const options = { redirect: "error", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]) };
    const verified = await fetch(new URL("user", identity), { ...options, headers: { Authorization: auth } });
    if (verified.status === 401 || verified.status === 403) return fail(401, loginRequired);
    if (!verified.ok) return fail(503, unavailable);
    const user = await verified.json();
    if (!user.id || !user.confirmed_at) return fail(403, forbidden);
    if (ownerId) {
      if (user.id !== ownerId) return fail(403, forbidden);
    } else {
      if (user.email?.toLowerCase() !== ownerEmail) return fail(403, forbidden);
      // An automatically confirmed email does not prove ownership of the address.
      const settings = await fetch(new URL("settings", identity), options);
      if (!settings.ok || (await settings.json()).autoconfirm !== false) return fail(503, unavailable);
    }
  } catch {
    return fail(503, unavailable);
  }
  if (ownerCheck) return new Response(null, { status: 204, headers });

  if (request.headers.get("Content-Type")?.toLowerCase() !== "image/jpeg" || !request.body) {
    return fail(415, "進捗欄を切り出したJPEG画像を選んでください。");
  }
  const tooLarge = "進捗欄を2MB以下に切り出してください。";
  if (Number(request.headers.get("Content-Length")) > maxBytes) return fail(413, tooLarge);
  let bytes;
  try { bytes = await readBody(request.body); } catch { return fail(400, "画像を受信できませんでした。"); }
  if (!bytes) return fail(413, tooLarge);
  if (!isCroppedJpeg(bytes)) return fail(422, "進捗欄を切り出したJPEG画像を選んでください。");

  try {
    const candidate = await questImageApi.read({
      key, imageUrl: "data:image/jpeg;base64," + bytes.toString("base64"),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(35000)])
    });
    return Response.json({ candidate }, { headers });
  } catch {
    return fail(502, "OpenAIで進捗欄を読み取れませんでした。端末内で再試行するか、手入力してください。");
  }
}

export const config = { path: "/api/quest-progress" };
