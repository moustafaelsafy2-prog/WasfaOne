// /netlify/functions/adminUsers.js  — Netlify Functions (V1) + Node 18
// + NEW actions: setTrial, upgradeMonthly, upgradeAnnual, setWindow
// + Normalize status based on dates:
//   - if end_date < today -> status="suspended", lock_reason="expired"
//   - if start_date > today -> status="inactive" (unless admin insists on "active")
//   - if window valid and previously suspended due to expiry and dates extended -> reactivate
// + PUT now also accepts {notes} in addition to name/status/dates/password
// + Server-side date computation for quick-upgrade actions (trial/monthly/annual)

const {
  ADMIN_PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REF = "main",
} = process.env;

const USERS_PATH = "data/users.json";
const BASE_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/`;
const baseHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "WasfaOne-Netlify",
};

/* ---------------- HTTP helpers ---------------- */
function resp(status, obj) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

/* ---------------- Date helpers (Asia/Dubai) ---------------- */
function pad2(n){ return String(n).padStart(2,"0"); }
function todayDubai(){
  const now = new Date();
  return now.toLocaleDateString("en-CA", { timeZone:"Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit" });
}
function addDaysISO(iso, days){
  const [y,m,d] = String(iso||"").split("-").map(x=>parseInt(x,10));
  const dt = new Date(Date.UTC(y||1970,(m||1)-1,d||1));
  dt.setUTCDate(dt.getUTCDate() + (Number(days)||0));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth()+1)}-${pad2(dt.getUTCDate())}`;
}
function cmpISO(a,b){ if(!a||!b) return 0; return a<b?-1:(a>b?1:0); }
function withinWindow(start,end,today = todayDubai()){
  if (start && cmpISO(today,start)<0) return false;
  if (end   && cmpISO(today,end)>0)   return false;
  return true;
}

/* ---------------- Status normalization ---------------- */
function normalizeStatusByDates(user, today = todayDubai()) {
  const u = { ...user };
  const status = (u.status || "").toLowerCase();

  // Ended -> suspended/expired
  if (u.end_date && today > u.end_date) {
    u.status = "suspended";
    u.lock_reason = "expired";
    return u;
  }

  // Not started yet -> inactive (unless admin explicitly sets active)
  if (u.start_date && today < u.start_date) {
    u.status = status === "active" ? "active" : "inactive";
    if (u.status !== "suspended") u.lock_reason = null;
    return u;
  }

  // Inside window
  if (status === "suspended" && u.lock_reason === "expired") {
    // Window extended -> reactivate
    u.status = "active";
    u.lock_reason = null;
  } else {
    u.status = status || "active";
    if (u.status !== "suspended") u.lock_reason = null;
  }
  return u;
}

/* ---------------- GitHub helpers ---------------- */
async function ghGetJson(path) {
  const url = `${BASE_URL}${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_REF)}`;
  const r = await fetch(url, { headers: baseHeaders });
  if (r.status === 404) return { data: [], sha: null }; // ملف غير موجود بعد
  if (!r.ok) throw new Error(`GH_GET_${r.status}`);
  const j = await r.json();
  const txt = Buffer.from(j.content || "", "base64").toString("utf8");
  return { data: txt ? JSON.parse(txt) : [], sha: j.sha };
}

async function ghPutJson(path, nextData, message, sha) {
  const url = `${BASE_URL}${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(JSON.stringify(nextData, null, 2), "utf8").toString("base64"),
    branch: GITHUB_REF,
  };
  if (sha) body.sha = sha; // لو الملف موجود نمرر sha، وإلا GitHub ينشئه
  const r = await fetch(url, {
    method: "PUT",
    headers: baseHeaders,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GH_PUT_${r.status}:${t.slice(0,200)}`);
  }
  return r.json();
}

/* ---------------- Core ops ---------------- */
function findUserIndexByEmail(users, email){
  const e = String(email||"").toLowerCase().trim();
  return users.findIndex(u => String(u.email||"").toLowerCase().trim() === e);
}

function applyWindow(u, { start_date, end_date, status }){
  const today = todayDubai();
  const next = {
    ...u,
    start_date: start_date ?? u.start_date ?? today,
    end_date:   end_date   ?? u.end_date   ?? today,
    status:     status     ?? "active",
    lock_reason: null
  };
  return normalizeStatusByDates(next, today);
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204 };

    // تحقق من الإعدادات
    if (!ADMIN_PASSWORD || !GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
      return resp(500, { ok: false, error: "config_missing" });
    }

    // تحقق من صلاحية الأدمن
    const key =
      event.headers["x-admin-key"] ||
      event.headers["X-Admin-Key"] ||
      event.headers["x-admin-key".toLowerCase()];
    if (key !== ADMIN_PASSWORD) return resp(401, { ok: false, error: "unauthorized" });

    const method = event.httpMethod;
    const action = String(event.queryStringParameters?.action || "").toLowerCase();
    const body = event.body ? JSON.parse(event.body) : {};

    /* -------- GET: list users -------- */
    if (method === "GET") {
      const { data } = await ghGetJson(USERS_PATH);
      return resp(200, { ok: true, users: Array.isArray(data) ? data : [] });
    }

    // حمل الحالة الحالية
    const { data: users, sha } = await ghGetJson(USERS_PATH);
    const today = todayDubai();

    /* -------- POST: actions / create -------- */
    if (method === "POST") {
      // --- Action: reset device ---
      if (action === "resetdevice") {
        const email = (body.email || "").toLowerCase();
        const idx = findUserIndexByEmail(users, email);
        if (idx === -1) return resp(404, { ok: false, error: "not_found" });
        users[idx].device_fingerprint = null;
        users[idx].session_nonce = null;
        await ghPutJson(USERS_PATH, users, `admin: reset device ${email}`, sha);
        return resp(200, { ok: true, user: users[idx] });
      }

      // --- Action: setTrial (server computes window) ---
      if (action === "settrial") {
        const email = (body.email || "").toLowerCase();
        const idx = findUserIndexByEmail(users, email);
        if (idx === -1) return resp(404, { ok: false, error: "not_found" });

        const days = Number(body.days)||7;
        const start_date = today;
        const end_date = addDaysISO(today, days); // نهاية بعد 7 أيام (شاملة اليوم الحالي)
        users[idx] = applyWindow(users[idx], { start_date, end_date, status: "active" });

        await ghPutJson(USERS_PATH, users, `admin: set trial ${email} (${days}d)`, sha);
        return resp(200, { ok: true, user: users[idx] });
      }

      // --- Action: upgradeMonthly (30 days from today) ---
      if (action === "upgrademonthly") {
        const email = (body.email || "").toLowerCase();
        const idx = findUserIndexByEmail(users, email);
        if (idx === -1) return resp(404, { ok: false, error: "not_found" });

        const start_date = today;
        const end_date = addDaysISO(today, 30);
        users[idx] = applyWindow(users[idx], { start_date, end_date, status: "active" });

        await ghPutJson(USERS_PATH, users, `admin: upgrade monthly ${email}`, sha);
        return resp(200, { ok: true, user: users[idx] });
      }

      // --- Action: upgradeAnnual (365 days from today) ---
      if (action === "upgradeannual") {
        const email = (body.email || "").toLowerCase();
        const idx = findUserIndexByEmail(users, email);
        if (idx === -1) return resp(404, { ok: false, error: "not_found" });

        const start_date = today;
        const end_date = addDaysISO(today, 365);
        users[idx] = applyWindow(users[idx], { start_date, end_date, status: "active" });

        await ghPutJson(USERS_PATH, users, `admin: upgrade annual ${email}`, sha);
        return resp(200, { ok: true, user: users[idx] });
      }

      // --- Action: setWindow (admin-custom window) ---
      if (action === "setwindow") {
        const email = (body.email || "").toLowerCase();
        const idx = findUserIndexByEmail(users, email);
        if (idx === -1) return resp(404, { ok: false, error: "not_found" });

        const start_date = body.start_date || users[idx].start_date || today;
        const end_date   = body.end_date   || users[idx].end_date   || today;
        // يسمح بتحديد الحالة يدويًا، الافتراضي active
        const status     = body.status || "active";

        users[idx] = applyWindow(users[idx], { start_date, end_date, status });

        await ghPutJson(USERS_PATH, users, `admin: set window ${email} [${start_date}..${end_date}]`, sha);
        return resp(200, { ok: true, user: users[idx] });
      }

      // --- Create user (no action) ---
      const required = ["email", "password", "name"];
      for (const r of required) if (!body[r]) return resp(400, { ok: false, error: `missing_${r}` });

      const email = String(body.email).toLowerCase();
      if (users.some(u => (u.email || "").toLowerCase() === email)) {
        return resp(409, { ok: false, error: "exists" });
      }

      const nuRaw = {
        email,
        password: String(body.password),
        name: String(body.name),
        status: body.status || "active",
        start_date: body.start_date || null,
        end_date: body.end_date || null,
        device_fingerprint: null,
        session_nonce: null,
        lock_reason: body.lock_reason || null,
        auth_token: null,
        notes: body.notes || null
      };
      const nu = normalizeStatusByDates(nuRaw, today);

      users.push(nu);
      await ghPutJson(USERS_PATH, users, `admin: create ${email}`, sha);
      return resp(201, { ok: true, user: nu });
    }

    /* -------- PUT: update user -------- */
    if (method === "PUT") {
      const email = (body.email || "").toLowerCase();
      const idx = findUserIndexByEmail(users, email);
      if (!email || idx === -1) return resp(404, { ok: false, error: "not_found" });

      const current = users[idx];
      const merged = {
        ...current,
        name: body.name ?? current.name,
        status: body.status ?? current.status,
        start_date: body.start_date ?? current.start_date,
        end_date: body.end_date ?? current.end_date,
        notes: (typeof body.notes === "string" ? body.notes : (current.notes ?? null))
      };
      if (typeof body.password === "string" && body.password.trim() !== "") {
        merged.password = body.password;
      }

      const next = normalizeStatusByDates(merged, today);
      users[idx] = next;
      await ghPutJson(USERS_PATH, users, `admin: update ${email}`, sha);
      return resp(200, { ok: true, user: next });
    }

    /* -------- DELETE: remove user -------- */
    if (method === "DELETE") {
      const email = (body.email || "").toLowerCase();
      const next = users.filter(u => (u.email || "").toLowerCase() !== email);
      if (next.length === users.length) return resp(404, { ok: false, error: "not_found" });
      await ghPutJson(USERS_PATH, next, `admin: delete ${email}`, sha);
      return resp(200, { ok: true, removed: email });
    }

    return resp(405, { ok: false, error: "method_not_allowed" });
  } catch (e) {
    return resp(500, { ok: false, error: "exception", message: e.message });
  }
};
