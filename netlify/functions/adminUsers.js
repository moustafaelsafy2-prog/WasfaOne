// /netlify/functions/adminUsers.js — Admin CRUD for users.json (GitHub storage)
// Node 18 (Netlify), V1 functions (CommonJS). All JSON responses.
// Security: X-Admin-Auth must equal process.env.ADMIN_PASSWORD
// Features:
// - Date-window normalization (Asia/Dubai)
// - New plan fields: plan, trial_expires_at, daily_limit, used_today, last_reset
// - Actions: create, update, upgrade, resetdevice, resetdaily, setplan
// - GET (list with normalization), DELETE (by email)

const {
  ADMIN_PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REF = "main",
} = process.env;

const BASE_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/`;
const USERS_PATH = "data/users.json";

/* ---------------- HTTP helpers ---------------- */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Auth",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const resp = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });

/* ---------------- Guard ---------------- */
function requireAdmin(event) {
  const hdr = event.headers?.["x-admin-auth"] || event.headers?.["X-Admin-Auth"];
  if (!ADMIN_PASSWORD) return { ok: false, code: 500, error: "server_admin_password_missing" };
  if (hdr !== ADMIN_PASSWORD) return { ok: false, code: 401, error: "unauthorized_admin" };
  return { ok: true };
}

/* ---------------- Dates (Asia/Dubai) ---------------- */
function todayDubai() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric", month: "2-digit", day: "2-digit"
  });
}
function normalizeDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  const m = t.match(/^(\d{4})-?(\d{1,2})-?(\d{1,2})$/);
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

/* ---------------- GitHub helpers ---------------- */
async function ghGetJson(path) {
  const url = `${BASE_URL}${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_REF)}`;
  const r = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}`, "User-Agent": "WasfaOne" } });
  if (r.status === 404) return { data: [], sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const js = await r.json();
  const content = Buffer.from(js.content || "", "base64").toString("utf-8");
  const data = content ? JSON.parse(content) : [];
  return { data: Array.isArray(data) ? data : [], sha: js.sha };
}
async function ghPutJson(path, json, message, sha) {
  const content = Buffer.from(JSON.stringify(json, null, 2), "utf-8").toString("base64");
  const url = `${BASE_URL}${encodeURIComponent(path)}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      "User-Agent": "WasfaOne",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ message, content, sha, branch: GITHUB_REF })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GitHub PUT ${path} ${r.status}: ${t.slice(0,180)}`);
  }
  return r.json();
}

/* ---------------- Normalization ---------------- */
function normalizeUser(u) {
  if (!u || typeof u !== "object") return u;

  const today = todayDubai();
  const start = normalizeDate(u.start_date);
  const end   = normalizeDate(u.end_date);
  const prevStatus = String(u.status || "").toLowerCase();

  // auto-expire
  if (end && cmpDate(today, end) > 0) {
    u.status = "suspended";
    u.lock_reason = "expired";
  } else {
    // if inside window and previously suspended(expired) -> reactivate
    if (withinWindow(start, end) && prevStatus === "suspended" && String(u.lock_reason||"") === "expired") {
      u.status = "active";
      u.lock_reason = null;
    }
    // future start -> inactive (unless admin insisted active)
    const sOK = !start || cmpDate(today, start) >= 0;
    if (!sOK && prevStatus !== "active") {
      u.status = "inactive";
    }
  }

  // Ensure plan fields exist (do not overwrite if already set)
  if (typeof u.plan === "undefined") u.plan = "trial"; // default for older users if needed
  if (typeof u.daily_limit === "undefined") u.daily_limit = (u.plan === "trial" ? 2 : null);
  if (typeof u.used_today === "undefined") u.used_today = 0;
  if (typeof u.last_reset === "undefined") u.last_reset = today;
  if (typeof u.trial_expires_at === "undefined") u.trial_expires_at = u.end_date || today;

  return u;
}
function normalizeUsers(arr) {
  return (Array.isArray(arr) ? arr : []).map(u => normalizeUser({ ...u }));
}

/* ---------------- Mutations helpers ---------------- */
function findUserIndex(list, email) {
  const e = String(email || "").toLowerCase().trim();
  return (list || []).findIndex(u => String(u.email || "").toLowerCase().trim() === e);
}
function applyPatch(u, patch) {
  const next = { ...u };
  for (const [k,v] of Object.entries(patch || {})) {
    if (v === undefined) continue; // do not unset by accident
    next[k] = v;
  }
  return next;
}

/* ---------------- Actions ---------------- */
function validateCreateInput(body){
  const email = String(body.email || "").toLowerCase().trim();
  const password = String(body.password || "");
  const name = String(body.name || "").trim();
  if (!email || !password) return { ok:false, error:"missing_email_or_password" };
  return { ok:true, email, password, name };
}

function makeUserFromBody(body){
  const today = todayDubai();
  const start = normalizeDate(body.start_date) || today;
  const end   = normalizeDate(body.end_date) || today;

  const plan = (body.plan === "monthly" || body.plan === "yearly") ? body.plan : "trial";
  const trial_expires_at = body.trial_expires_at ? normalizeDate(body.trial_expires_at) : (plan === "trial" ? end : null);
  const daily_limit = (plan === "trial")
    ? (Number.isFinite(Number(body.daily_limit)) ? Number(body.daily_limit) : 2)
    : null;

  return normalizeUser({
    email: String(body.email).toLowerCase().trim(),
    password: String(body.password||""),
    name: String(body.name||""),
    status: String(body.status||"active"),
    start_date: start,
    end_date: end,
    device_fingerprint: body.device_fingerprint || null,
    session_nonce: null,
    lock_reason: null,
    auth_token: body.auth_token || null,

    // plan model
    plan,
    trial_expires_at,
    daily_limit,
    used_today: Number(body.used_today||0),
    last_reset: normalizeDate(body.last_reset) || today
  });
}

/* Quick helpers */
function setPlanPatch(plan, today = todayDubai(), opts = {}){
  if (plan === "monthly" || plan === "yearly") {
    return { plan, daily_limit: null }; // unlimited
  }
  // default trial — allow override daily_limit, trial_expires_at
  const daily = Number.isFinite(Number(opts.daily_limit)) ? Number(opts.daily_limit) : 2;
  const trial_exp = normalizeDate(opts.trial_expires_at) || today;
  return { plan: "trial", daily_limit: daily, trial_expires_at: trial_exp };
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };

  try {
    // Admin guard
    const guard = requireAdmin(event);
    if (!guard.ok) return resp(guard.code, { ok:false, error: guard.error });

    const method = event.httpMethod;
    const action = String(event.queryStringParameters?.action || "").toLowerCase();
    const body = event.body ? JSON.parse(event.body) : {};

    if (method === "GET") {
      const { data } = await ghGetJson(USERS_PATH);
      const normalized = normalizeUsers(data);
      return resp(200, { ok: true, users: normalized });
    }

    // Load current users for mutations
    const { data: usersRaw, sha } = await ghGetJson(USERS_PATH);
    const users = Array.isArray(usersRaw) ? usersRaw : [];

    if (method === "POST") {
      /* ------ resetdevice ------ */
      if (action === "resetdevice") {
        const email = String(body.email || "").toLowerCase().trim();
        const i = findUserIndex(users, email);
        if (i === -1) return resp(404, { ok:false, error:"not_found" });
        users[i].device_fingerprint = null;
        users[i].session_nonce = null;
        await ghPutJson(USERS_PATH, users, `admin: reset device ${email}`, sha);
        return resp(200, { ok:true, email });
      }

      /* ------ resetdaily ------ */
      if (action === "resetdaily") {
        const email = String(body.email || "").toLowerCase().trim();
        const i = findUserIndex(users, email);
        if (i === -1) return resp(404, { ok:false, error:"not_found" });
        users[i].used_today = 0;
        users[i].last_reset = todayDubai();
        await ghPutJson(USERS_PATH, users, `admin: reset daily ${email}`, sha);
        return resp(200, { ok:true, email, used_today: 0, last_reset: todayDubai() });
      }

      /* ------ upgrade (monthly/yearly) ------ */
      if (action === "upgrade") {
        const email = String(body.email || "").toLowerCase().trim();
        const plan  = String(body.plan || "").toLowerCase();
        if (!["monthly","yearly"].includes(plan)) {
          return resp(400, { ok:false, error:"invalid_plan" });
        }
        const i = findUserIndex(users, email);
        if (i === -1) return resp(404, { ok:false, error:"not_found" });

        users[i] = applyPatch(users[i], setPlanPatch(plan));
        // Optionally extend window dates if provided
        if (body.start_date) users[i].start_date = normalizeDate(body.start_date);
        if (body.end_date)   users[i].end_date   = normalizeDate(body.end_date);

        // reactivate if expired but window fixed
        users[i] = normalizeUser(users[i]);

        await ghPutJson(USERS_PATH, users, `admin: upgrade ${email} -> ${plan}`, sha);
        return resp(200, { ok:true, email, plan: users[i].plan, daily_limit: users[i].daily_limit });
      }

      /* ------ setplan (explicit) ------ */
      if (action === "setplan") {
        const email = String(body.email || "").toLowerCase().trim();
        const plan  = String(body.plan || "").toLowerCase() || "trial";
        const i = findUserIndex(users, email);
        if (i === -1) return resp(404, { ok:false, error:"not_found" });

        const patch = (plan === "monthly" || plan === "yearly")
          ? setPlanPatch(plan)
          : setPlanPatch("trial", todayDubai(), {
              daily_limit: body.daily_limit,
              trial_expires_at: body.trial_expires_at
            });

        users[i] = applyPatch(users[i], patch);

        // window optional updates
        if (body.start_date) users[i].start_date = normalizeDate(body.start_date);
        if (body.end_date)   users[i].end_date   = normalizeDate(body.end_date);

        users[i] = normalizeUser(users[i]);

        await ghPutJson(USERS_PATH, users, `admin: setplan ${email} -> ${plan}`, sha);
        return resp(200, { ok:true, email, plan: users[i].plan, daily_limit: users[i].daily_limit, trial_expires_at: users[i].trial_expires_at });
      }

      /* ------ create ------ */
      if (action === "create") {
        const v = validateCreateInput(body);
        if (!v.ok) return resp(400, { ok:false, error: v.error });

        const exists = findUserIndex(users, v.email) !== -1;
        if (exists) return resp(409, { ok:false, error:"email_exists" });

        const nu = makeUserFromBody(body);
        users.push(nu);
        await ghPutJson(USERS_PATH, users, `admin: create ${v.email}`, sha);
        return resp(200, { ok:true, email: v.email });
      }

      /* ------ update ------ */
      if (action === "update") {
        const email = String(body.email || "").toLowerCase().trim();
        const i = findUserIndex(users, email);
        if (i === -1) return resp(404, { ok:false, error:"not_found" });

        const patch = { ...body };
        delete patch.email;

        // normalize certain fields if provided
        if (patch.start_date) patch.start_date = normalizeDate(patch.start_date);
        if (patch.end_date)   patch.end_date   = normalizeDate(patch.end_date);
        if (typeof patch.used_today !== "undefined") patch.used_today = Number(patch.used_today||0);
        if (typeof patch.daily_limit !== "undefined") {
          patch.daily_limit = (patch.daily_limit === null || patch.daily_limit === "null")
            ? null
            : Number(patch.daily_limit);
        }
        if (patch.last_reset) patch.last_reset = normalizeDate(patch.last_reset);
        if (patch.trial_expires_at) patch.trial_expires_at = normalizeDate(patch.trial_expires_at);

        users[i] = applyPatch(users[i], patch);
        users[i] = normalizeUser(users[i]);

        await ghPutJson(USERS_PATH, users, `admin: update ${email}`, sha);
        return resp(200, { ok:true, email });
      }

      // Unknown action
      return resp(400, { ok:false, error:"unknown_action" });
    }

    if (method === "DELETE") {
      const bodyJson = event.body ? JSON.parse(event.body) : {};
      const email = String(bodyJson.email || "").toLowerCase().trim();
      const i = findUserIndex(users, email);
      if (i === -1) return resp(404, { ok:false, error:"not_found" });
      const next = users.slice(0, i).concat(users.slice(i+1));
      await ghPutJson(USERS_PATH, next, `admin: delete ${email}`, sha);
      return resp(200, { ok:true, removed: email });
    }

    return resp(405, { ok:false, error:"method_not_allowed" });
  } catch (e) {
    return resp(500, { ok:false, error:"exception", message: String(e && e.message || e) });
  }
};
