// /netlify/functions/adminUsers.js  — Netlify Functions (V1) + Node 18

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

async function ghGetJson(path) {
  const url = `${BASE_URL}${path}?ref=${encodeURIComponent(GITHUB_REF)}`;
  const r = await fetch(url, { headers: baseHeaders });
  if (!r.ok) {
    throw new Error(`gh_get_failed_${r.status}`);
  }
  const j = await r.json();
  const content = Buffer.from(j.content || "", "base64").toString("utf-8");
  let data = null;
  try {
    data = JSON.parse(content);
  } catch (_) {
    data = null;
  }
  return { data, sha: j.sha || null };
}

async function ghPutJson(path, data, message, sha) {
  const url = `${BASE_URL}${path}`;
  const body = {
    message: message || `update ${path}`,
    content: Buffer.from(JSON.stringify(data, null, 2), "utf-8").toString("base64"),
    branch: GITHUB_REF,
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, { method: "PUT", headers: baseHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`gh_put_failed_${r.status}`);
  return await r.json();
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod || "GET";

    if (!ADMIN_PASSWORD || !GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
      return resp(500, { ok: false, error: "config_missing" });
    }

    // تحقق من صلاحية الأدمن
    const key =
      event.headers["x-admin-key"] ||
      event.headers["X-Admin-Key"] ||
      event.headers["x-admin-key".toLowerCase()];
    if (key !== ADMIN_PASSWORD) return resp(401, { ok: false, error: "unauthorized" });

    const { data: users = [], sha } = await ghGetJson(USERS_PATH);

    if (method === "GET") {
      return resp(200, { ok: true, users });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      body = {};
    }

    if (method === "POST") {
      const action = body.action;

      // إعادة تعيين القفل (بصمة/جلسة) لمستخدم معيّن
      if (action === "reset_lock") {
        const email = (body.email || "").toLowerCase();
        const idx = users.findIndex(u => (u.email || "").toLowerCase() === email);
        if (idx === -1) return resp(404, { ok: false, error: "not_found" });

        users[idx].device_fingerprint = null;
        users[idx].session_nonce = null;
        await ghPutJson(USERS_PATH, users, `admin: reset lock ${email}`, sha);
        return resp(200, { ok: true, user: users[idx] });
      }

      // إنشاء/تحديث مستخدم
      if (action === "upsert") {
        const u = body.user || {};
        const email = (u.email || "").toLowerCase();

        if (!email || !u.pass) {
          return resp(400, { ok: false, error: "bad_request" });
        }

        const current = users.find(x => (x.email || "").toLowerCase() === email);
        const nextUser = {
          email,
          name: u.name || "",
          pass: u.pass || "",
          role: u.role || "user",
          enabled: !!u.enabled,
          start_date: u.start_date || null,
          end_date: u.end_date || null,
          device_fingerprint: u.device_fingerprint || null,
          lock_reason: u.lock_reason || null,
        };

        if (current) {
          Object.assign(current, { ...nextUser });
        } else {
          users.push(nextUser);
        }

        await ghPutJson(USERS_PATH, users, `admin: upsert ${email}`, sha);
        return resp(200, { ok: true, user: nextUser });
      }

      return resp(400, { ok: false, error: "unknown_action" });
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
