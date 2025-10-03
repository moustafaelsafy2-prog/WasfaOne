// /netlify/functions/signup.js
// Self-signup with single-device policy + 7-day Trial window
// - Stores users in GitHub (data/users.json) just like existing functions
// - Returns HTTP 200 for both success and friendly errors (consistent UX)
// - Timezone: Asia/Dubai for all date decisions (trial/window)

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;

const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";

/* ------------- HTTP helpers (always 200 to keep FE simple) ------------- */
function resOk(payload){
  return {
    statusCode: 200,
    headers: {
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify({ ok:true, ...payload })
  };
}
function resErr(reason, ar, en, extra = {}){
  return {
    statusCode: 200,
    headers: {
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "X-Error-Reason": reason,
      "X-UI-Message-Ar": encodeURIComponent(ar),
      "X-UI-Message-En": encodeURIComponent(en)
    },
    body: JSON.stringify({ ok:false, reason, message: ar, message_en: en, ...extra })
  };
}

/* ------------- GitHub helpers ------------- */
async function ghGetJson(path){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if (r.status === 404) {
    // create-on-first-write semantics
    return { json: [], sha: null };
  }
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  const parsed = content ? JSON.parse(content) : [];
  return { json: parsed, sha: data.sha };
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
  if(!r.ok){
    const t = await r.text();
    throw new Error(`GitHub PUT ${path} ${r.status}: ${t.slice(0,180)}`);
  }
  return r.json();
}

/* ------------- Date helpers (Asia/Dubai) ------------- */
function todayDubai(){
  return new Date().toLocaleDateString("en-CA", {
    timeZone:"Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit"
  });
}
function addDaysDubai(days){
  // add days based on UTC then format in Dubai calendar day
  const now = new Date();
  const plus = new Date(now.getTime() + days*24*60*60*1000);
  return plus.toLocaleDateString("en-CA", {
    timeZone:"Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit"
  });
}
function normEmail(x){ return String(x||"").trim().toLowerCase(); }

/* ------------- Handler ------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type", "Access-Control-Allow-Methods":"POST, OPTIONS" } };
  if (event.httpMethod !== "POST"){
    return resErr("method_not_allowed", "الطريقة غير مسموحة", "Method Not Allowed");
  }

  try{
    if (!OWNER || !REPO || !GH_TOKEN) {
      return resErr("server_config_missing", "إعدادات الخادم غير كاملة", "Server configuration is missing");
    }

    const body = JSON.parse(event.body || "{}");
    const name  = String(body.name||"").trim();
    const email = normEmail(body.email);
    const pass  = String(body.password||"");
    const device = String(body.device_fingerprint_hash||"").trim();

    if (!name || !email || !pass || !device) {
      return resErr("missing_fields", "الرجاء إدخال جميع البيانات المطلوبة", "Missing required fields");
    }

    // load users
    const { json: users, sha } = await ghGetJson(USERS_PATH);
    const list = Array.isArray(users) ? users : [];

    // 1) prevent duplicate email
    if (list.some(u => normEmail(u.email) === email)) {
      return resErr("email_exists", "البريد مسجّل مسبقًا", "Email already exists");
    }
    // 2) prevent multiple accounts on the same device
    if (list.some(u => String(u.device_fingerprint||"").trim() === device)) {
      return resErr("device_already_registered", "هذا الجهاز مسجّل مسبقًا بحساب آخر", "This device is already registered with another account");
    }

    // Prepare 7-day trial window (aligned with login/generation window checks)
    const start = todayDubai();
    const end   = addDaysDubai(7);

    // NEW trial fields (for future daily limit logic)
    const trialExpires = end; // same day as end_date for alignment
    const dailyLimit   = 2;   // suggested daily cap during trial

    const nu = {
      email,
      password: pass,
      name,
      status: "active",
      start_date: start,
      end_date: end,
      device_fingerprint: device,
      session_nonce: null,
      lock_reason: null,
      auth_token: null,

      // Trial model (will be leveraged by future steps in generateRecipe.js)
      plan: "trial",
      trial_expires_at: trialExpires,
      daily_limit: dailyLimit,
      used_today: 0,
      last_reset: start
    };

    const next = list.concat([nu]);
    await ghPutJson(USERS_PATH, next, sha, `signup: create ${email}`);

    // success
    return resOk({
      user: { email: nu.email, name: nu.name, plan: nu.plan, trial_expires_at: nu.trial_expires_at }
    });
  } catch (e){
    return resErr("exception", "حدث خطأ في الخادم", "Server error", { error: String(e && e.message || e) });
  }
};
