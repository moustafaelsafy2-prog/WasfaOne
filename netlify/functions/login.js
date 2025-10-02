// /netlify/functions/login.js
// Netlify Function: login (robust expiry-first logic)
// POST: { email, password, device_fingerprint_hash }
// Fix: always short-circuit on suspended/expired BEFORE any device logic,
// and normalize dates/status to avoid format/whitespace issues.

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
  // ISO-like date in Asia/Dubai
  const now = new Date();
  return now.toLocaleDateString("en-CA", { timeZone:"Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit" });
}
function normalizeDate(s){
  if (!s) return null;
  const t = String(s).trim();
  // match YYYY[-/. ]M[D] pattern
  const m = t.match(/^\s*(\d{4})\D?(\d{1,2})\D?(\d{1,2})\s*$/);
  if (!m) return null;
  const y = m[1];
  const mo = String(Math.max(1, Math.min(12, Number(m[2])))).padStart(2,"0");
  const d  = String(Math.max(1, Math.min(31, Number(m[3])))).padStart(2,"0");
  return `${y}-${mo}-${d}`;
}
function cmpDate(d1, d2){
  // compare normalized YYYY-MM-DD strings
  if (!d1 || !d2) return 0;
  if (d1 < d2) return -1;
  if (d1 > d2) return 1;
  return 0;
}
function withinWindow(start, end){
  const today = todayDubai();
  const s = normalizeDate(start);
  const e = normalizeDate(end);
  if (s && cmpDate(today, s) < 0) return false; // before start
  if (e && cmpDate(today, e) > 0) return false; // after end
  return true;
}
function normStatus(x){
  return String(x || "").trim().toLowerCase();
}

/* ---------------- Handler ---------------- */
export async function handler(event){
  if(event.httpMethod !== "POST"){
    return { statusCode: 405, body: JSON.stringify({ ok:false }) };
  }

  try{
    const body = JSON.parse(event.body||"{}");
    const { email, password, device_fingerprint_hash } = body;

    if(!email || !password || !device_fingerprint_hash){
      return { statusCode: 400, body: JSON.stringify({ ok:false, reason:"missing_fields" }) };
    }

    const { json: users, sha } = await ghGetJson(USERS_PATH);
    const idx = users.findIndex(u => (u.email||"").toLowerCase().trim() === String(email).toLowerCase().trim());
    if(idx === -1){
      return { statusCode: 401, body: JSON.stringify({ ok:false, reason:"invalid" }) };
    }

    const user = users[idx];

    if(String(user.password||"") !== String(password)){
      return { statusCode: 401, body: JSON.stringify({ ok:false, reason:"invalid" }) };
    }

    const today = todayDubai();
    const endN  = normalizeDate(user.end_date);
    const startN= normalizeDate(user.start_date);
    const status = normStatus(user.status);

    // --- HARD STOP 1: already suspended ---
    if (status === "suspended") {
      const msg = (String(user.lock_reason||"").toLowerCase().trim() === "expired")
        ? "انتهت صلاحية الاشتراك وتم تعليق الحساب"
        : "الحساب معلّق";
      return { statusCode: 403, body: JSON.stringify({ ok:false, reason:"suspended", message: msg }) };
    }

    // --- HARD STOP 2: expired by date -> auto-suspend & persist, then stop ---
    if (endN && cmpDate(today, endN) > 0) {
      user.status = "suspended";
      user.lock_reason = "expired";
      users[idx] = user;
      await ghPutJson(USERS_PATH, users, sha, `login: auto-suspend expired ${user.email}`);
      return { statusCode: 403, body: JSON.stringify({
        ok:false, reason:"subscription_expired",
        message:"انتهت صلاحية الاشتراك وتم تعليق الحساب"
      }) };
    }

    // --- HARD STOP 3: outside window or not active ---
    if (!withinWindow(startN, endN)) {
      return { statusCode: 403, body: JSON.stringify({ ok:false, reason:"inactive_or_out_of_window" }) };
    }
    if (status !== "active") {
      return { statusCode: 403, body: JSON.stringify({ ok:false, reason:"inactive" }) };
    }

    // --- Device logic (only after all checks above pass) ---
    if(!user.device_fingerprint){
      user.device_fingerprint = device_fingerprint_hash;
    } else if(user.device_fingerprint !== device_fingerprint_hash){
      return { statusCode: 423, body: JSON.stringify({
        ok:false,
        reason:"device_locked",
        message:"الحساب مرتبط بجهاز آخر. لإعادة الربط: 00971502061209"
      }) };
    }

    // Session tokens
    user.session_nonce = crypto.randomUUID();
    if(!user.auth_token){
      user.auth_token = crypto.randomUUID();
    }

    users[idx] = user;
    await ghPutJson(USERS_PATH, users, sha, `login: refresh session for ${user.email}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        name: user.name || "",
        email: user.email,
        token: user.auth_token,
        session_nonce: user.session_nonce
      })
    };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
}
