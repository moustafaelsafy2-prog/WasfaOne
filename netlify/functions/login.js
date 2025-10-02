// /netlify/functions/login.js
// Netlify Function: login (HTTP codes disambiguation)
// - 410 Gone  -> subscription_expired (suspended due to end_date)
// - 409 Conflict -> inactive_or_out_of_window
// - 423 Locked -> device_locked (ONLY for device mismatch)
// - 401 -> invalid credentials
// - 200 -> success

import crypto from "crypto";

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;

const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";

/* ---------------- GitHub helpers ---------------- */
async function ghGetJson(path){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content), sha: data.sha };
}
async function ghPutJson(path, json, sha, message){
  const content = Buffer.from(JSON.stringify(json, null, 2), "utf-8").toString("base64");
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      "User-Agent":"WasfaOne",
      "Content-Type":"application/json"
    },
    body: JSON.stringify({ message, content, sha, branch: REF })
  });
  if(!r.ok) throw new Error(`GitHub PUT ${path} ${r.status}`);
  return r.json();
}

/* ---------------- Date & status utils ---------------- */
function todayDubai(){
  return new Date().toLocaleDateString("en-CA", { timeZone:"Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit" });
}
function normalizeDate(s){
  if (!s) return null;
  const t = String(s).trim();
  const m = t.match(/^\s*(\d{4})\D?(\d{1,2})\D?(\d{1,2})\s*$/);
  if (!m) return null;
  const y = m[1];
  const mo = String(Math.max(1, Math.min(12, Number(m[2])))).padStart(2,"0");
  const d  = String(Math.max(1, Math.min(31, Number(m[3])))).padStart(2,"0");
  return `${y}-${mo}-${d}`;
}
function cmpDate(a,b){ if(!a||!b) return 0; return a<b?-1:a>b?1:0; }
function withinWindow(start, end){
  const today = todayDubai();
  const s = normalizeDate(start);
  const e = normalizeDate(end);
  if (s && cmpDate(today, s) < 0) return false;
  if (e && cmpDate(today, e) > 0) return false;
  return true;
}
function norm(x){ return String(x||"").trim().toLowerCase(); }

/* ---------------- helpers ---------------- */
function json(code, payload, reason, message){
  return {
    statusCode: code,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(reason ? { "X-Error-Reason": reason } : {}),
      ...(message ? { "X-Error-Message": encodeURIComponent(message) } : {}),
    },
    body: JSON.stringify(payload),
  };
}

/* ---------------- Handler ---------------- */
export async function handler(event){
  if(event.httpMethod !== "POST"){
    return json(405, { ok:false, reason:"method_not_allowed" }, "method_not_allowed");
  }

  try{
    const body = JSON.parse(event.body||"{}");
    const email = String(body.email||"").toLowerCase().trim();
    const password = String(body.password||"");
    const deviceHash = String(body.device_fingerprint_hash||"").trim();

    if(!email || !password || !deviceHash){
      return json(400, { ok:false, reason:"missing_fields" }, "missing_fields", "حقول مفقودة");
    }

    const { json: users, sha } = await ghGetJson(USERS_PATH);
    const idx = users.findIndex(u => String(u.email||"").toLowerCase().trim() === email);
    if(idx === -1){
      return json(401, { ok:false, reason:"invalid" }, "invalid_credentials", "بيانات الدخول غير صحيحة");
    }

    const user = users[idx];
    if(String(user.password||"") !== password){
      return json(401, { ok:false, reason:"invalid" }, "invalid_credentials", "بيانات الدخول غير صحيحة");
    }

    // normalize dates & status
    const startN = normalizeDate(user.start_date);
    const endN   = normalizeDate(user.end_date);
    const status = norm(user.status);

    // 1) If already suspended -> return 409 with clear message (not 403 to avoid FE mapping)
    if (status === "suspended") {
      const msg = norm(user.lock_reason) === "expired"
        ? "انتهت صلاحية الاشتراك وتم تعليق الحساب"
        : "هذا الحساب معلّق";
      return json(409, { ok:false, reason:"suspended", message: msg }, "suspended", msg);
    }

    // 2) If expired by date -> flip to suspended, persist, and return 410 Gone
    const today = todayDubai();
    if (endN && cmpDate(today, endN) > 0) {
      user.status = "suspended";
      user.lock_reason = "expired";
      users[idx] = user;
      await ghPutJson(USERS_PATH, users, sha, `login: auto-suspend expired ${user.email}`);
      const msg = "انتهت صلاحية الاشتراك وتم تعليق الحساب";
      return json(410, { ok:false, reason:"subscription_expired", message: msg }, "subscription_expired", msg);
    }

    // 3) Outside subscription window OR not active -> 409 Conflict
    if (!withinWindow(startN, endN)) {
      return json(409, { ok:false, reason:"inactive_or_out_of_window" }, "inactive_or_out_of_window", "خارج فترة الاشتراك");
    }
    if (status !== "active") {
      return json(409, { ok:false, reason:"inactive" }, "inactive", "الحساب غير نشط");
    }

    // 4) Device logic (ONLY after all above checks)
    if(!user.device_fingerprint){
      user.device_fingerprint = deviceHash;
    } else if(user.device_fingerprint !== deviceHash){
      const msg = "الحساب مرتبط بجهاز آخر. لإعادة الربط: 00971502061209";
      return json(423, { ok:false, reason:"device_locked", message: msg }, "device_locked", msg);
    }

    // 5) Tokens
    user.session_nonce = crypto.randomUUID();
    if(!user.auth_token) user.auth_token = crypto.randomUUID();

    users[idx] = user;
    await ghPutJson(USERS_PATH, users, sha, `login: refresh session for ${user.email}`);

    return json(200, {
      ok: true,
      name: user.name || "",
      email: user.email,
      token: user.auth_token,
      session_nonce: user.session_nonce
    });

  }catch(err){
    return json(500, { ok:false, error: String(err && err.message || err) }, "exception", "خطأ في الخادم");
  }
}
