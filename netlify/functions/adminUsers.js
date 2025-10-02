// /netlify/functions/adminUsers.js  — Netlify Functions (V1) + Node 18
// + NEW: normalize status based on dates:
//   - if end_date < today -> status="suspended", lock_reason="expired"
//   - if start_date > today -> status "inactive" (unless admin insists on "active")
//   - if window valid and previously suspended due to expiry and dates extended -> reactivate

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

function todayDubai(){
  const now = new Date();
  return now.toLocaleDateString("en-CA", { timeZone:"Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit" });
}

function normalizeStatusByDates(user, today = todayDubai()) {
  const u = { ...user };
  const status = (u.status || "").toLowerCase();

  if (u.end_date && today > u.end_date) {
    u.status = "suspended";
    u.lock_reason = "expired";
    return u;
  }

  if (u.start_date && today < u.start_date) {
    // not started yet
    u.status = status === "active" ? "active" : "inactive";
    if (u.status !== "suspended") u.lock_reason = null;
    return u;
  }

  // inside window
  if (status === "suspended" && u.lock_reason === "expired") {
    // admin extended period -> reactivate
    u.status = "active";
    u.lock_reason = null;
  } else {
    u.status = status || "active";
    if (u.status !== "suspended") u.lock_reason = null;
  }
  return u;
}

async function ghGetJson(path) {
  const url = `${BASE_URL}${path}?ref=${encodeURIComponent(GITHUB_REF)}`;
  const r = await fetch(url, { headers: baseHeaders });
  if (r.status === 404) return { data: [], sha: null }; // ملف غير موجود بعد
  if (!r.ok) throw new Error(`GH_GET_${r.status}`);
  const j = await r.json();
  const txt = Buffer.from(j.content || "", "base64").toString("utf8");
  return { data: txt ? JSON.parse(txt) : [], sha: j.sha };
}

async function ghPutJson(path, nextData, message, sha) {
  const url = `${BASE_URL}${path}`;
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
    const action = (event.queryStringParameters?.action || "").toLowerCase();
    const body = event.body ? JSON.parse(event.body) : {};

    if (method === "GET") {
      const { data } = await ghGetJson(USERS_PATH);
      return resp(200, { ok: true, users: Array.isArray(data) ? data : [] });
    }

    // حمل الحالة الحالية
    const { data: users, sha } = await ghGetJson(USERS_PATH);

    if (method === "POST") {
      if (action === "resetdevice") {
        const email = (body.email || "").toLowerCase();
        const idx = users.findIndex(u => (u.email || "").toLowerCase() === email);
        if (idx === -1) return resp(404, { ok: false, error: "not_found" });
        users[idx].device_fingerprint = null;
        users[idx].session_nonce = null;
        await ghPutJson(USERS_PATH, users, `admin: reset device ${email}`, sha);
        return resp(200, { ok: true, user: users[idx] });
      }

      // إنشاء مستخدم
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
        auth_token: null
      };
      const nu = normalizeStatusByDates(nuRaw);

      users.push(nu);
      await ghPutJson(USERS_PATH, users, `admin: create ${email}`, sha);
      return resp(201, { ok: true, user: nu });
    }

    if (method === "PUT") {
      const email = (body.email || "").toLowerCase();
      const idx = users.findIndex(u => (u.email || "").toLowerCase() === email);
      if (!email || idx === -1) return resp(404, { ok: false, error: "not_found" });

      const current = users[idx];
      const merged = {
        ...current,
        name: body.name ?? current.name,
        status: body.status ?? current.status,
        start_date: body.start_date ?? current.start_date,
        end_date: body.end_date ?? current.end_date,
      };
      if (typeof body.password === "string" && body.password.trim() !== "") {
        merged.password = body.password;
      }

      const next = normalizeStatusByDates(merged);
      users[idx] = next;
      await ghPutJson(USERS_PATH, users, `admin: update ${email}`, sha);
      return resp(200, { ok: true, user: next });
    }

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
