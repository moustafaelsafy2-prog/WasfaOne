// /netlify/functions/login.js
// Login with strong reasoned responses (ALL errors return 200 + ok:false)
// Order: suspended -> expired -> out_of_window -> inactive -> device -> success.
// (تعديل طفيف): عند النجاح نعيد أيضًا حقول الخطة trial/plans لاحتياج الواجهة لاحقًا.

import crypto from "crypto";

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;

const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";

/* ------------- GitHub helpers ------------- */
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

/* ------------- Date & status utils ------------- */
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
  if (s && cmpDate(today, s) < 0) return false; // before start
  if (e && cmpDate(today, e) > 0) return false; // after end
  return true;
}
function norm(x){ return String(x||"").trim().toLowerCase(); }

/* ------------- Response helpers (ALL errors as 200) ------------- */
function emitOk(payload){
  return {
    statusCode: 200,
    headers: { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" },
    body: JSON.stringify(payload),
  };
}
function emitError(reason, ar, en, extra = {}){
  return {
    statusCode: 200, // IMPORTANT: force FE to read body instead of mapping by status code
    headers: {
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "X-Error-Reason": reason,
      "X-UI-Message-Ar": encodeURIComponent(ar),
      "X-UI-Message-En": encodeURIComponent(en),
    },
    body: JSON.stringify({ ok:false, reason, message: ar, message_en: en, ...extra }),
  };
}

/* ------------- Handler ------------- */
export async function handler(event){
  if(event.httpMethod !== "POST"){
    return emitError("method_not_allowed", "الطريقة غير مسموحة", "Method Not Allowed");
  }

  try{
    const body = JSON.parse(event.body||"{}");
    const email = String(body.email||"").toLowerCase().trim();
    const password = String(body.password||"");
    const deviceHash = String(body.device_fingerprint_hash||"").trim();

    if(!email || !password || !deviceHash){
      return emitError("missing_fields", "بيانات مفقودة", "Missing required fields");
    }

    const { json: users, sha } = await ghGetJson(USERS_PATH);
    const idx = users.findIndex(u => String(u.email||"").toLowerCase().trim() === email);
    if(idx === -1){
      return emitError("invalid_credentials", "بيانات الدخول غير صحيحة", "Invalid credentials");
    }

    const user = users[idx];
    if(String(user.password||"") !== password){
      return emitError("invalid_credentials", "بيانات الدخول غير صحيحة", "Invalid credentials");
    }

    // Normalize dates & status
    const startN = normalizeDate(user.start_date);
    const endN   = normalizeDate(user.end_date);
    const status = norm(user.status);

    // 1) Already suspended -> specific message
    if (status === "suspended") {
      const isExpired = norm(user.lock_reason) === "expired";
      const ar = isExpired ? "انتهت صلاحية الاشتراك وتم تعليق الحساب" : "هذا الحساب معلّق";
      const en = isExpired ? "Your subscription has expired and your account is suspended" : "This account is suspended";
      return emitError("suspended", ar, en, { lock_reason: user.lock_reason || null });
    }

    // 2) Expired by date -> auto-suspend & persist
    const today = todayDubai();
    if (endN && cmpDate(today, endN) > 0) {
      user.status = "suspended";
      user.lock_reason = "expired";
      users[idx] = user;
      await ghPutJson(USERS_PATH, users, sha, `login: auto-suspend expired ${user.email}`);
      return emitError(
        "subscription_expired",
        "انتهت صلاحية الاشتراك وتم تعليق الحساب",
        "Your subscription has expired and your account is suspended",
        { lock_reason: "expired" }
      );
    }

    // 3) Outside window
    if (!withinWindow(startN, endN)) {
      return emitError(
        "inactive_or_out_of_window",
        "الحساب خارج فترة الاشتراك",
        "Account is out of subscription window"
      );
    }

    // 4) Not active
    if (status !== "active") {
      return emitError(
        "inactive",
        "الحساب غير نشط",
        "Account is not active"
      );
    }

    // 5) Device checks (only reached if all above passed)
    if(!user.device_fingerprint){
      user.device_fingerprint = deviceHash;
    } else if(user.device_fingerprint !== deviceHash){
      return emitError(
        "device_locked",
        "الحساب مرتبط بجهاز آخر. لإعادة الربط: 00971502061209",
        "This account is linked to another device. For relink: 00971502061209"
      );
    }

    // 6) Tokens & persist
    user.session_nonce = crypto.randomUUID();
    if(!user.auth_token) user.auth_token = crypto.randomUUID();

    users[idx] = user;
    await ghPutJson(USERS_PATH, users, sha, `login: refresh session for ${user.email}`);

    // (جديد) إرجاع حقول الخطة حتى تستفيد الواجهة لاحقًا
    const plan = user.plan ?? null;
    const trial_expires_at = user.trial_expires_at ?? null;
    const daily_limit = Object.prototype.hasOwnProperty.call(user, "daily_limit") ? user.daily_limit : null;
    const used_today = Object.prototype.hasOwnProperty.call(user, "used_today") ? user.used_today : null;
    const last_reset = user.last_reset ?? null;

    return emitOk({
      ok: true,
      name: user.name || "",
      email: user.email,
      token: user.auth_token,
      session_nonce: user.session_nonce,
      plan,
      trial_expires_at,
      daily_limit,
      used_today,
      last_reset
    });

  }catch(err){
    return emitError("exception", "حدث خطأ في الخادم", "Server error", { error: String(err && err.message || err) });
  }
}
