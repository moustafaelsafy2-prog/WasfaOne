// /netlify/functions/adminUsers.js
import fetch from "node-fetch";

const {
  ADMIN_PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REF = "main",
} = process.env;

const USERS_PATH = "data/users.json";

const ghHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "WasfaOne-Netlify",
};

async function ghGetJson(path) {
  const url = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${path}?ref=${GITHUB_REF}`;
  const res = await fetch(url, { headers: { ...ghHeaders, Authorization: `Bearer ${GITHUB_TOKEN}` } });
  if (!res.ok) throw new Error(`GitHub GET failed ${res.status}`);
  const json = await res.json();
  const content = Buffer.from(json.content, "base64").toString("utf8");
  return { data: JSON.parse(content || "[]"), sha: json.sha };
}

async function ghPutJson(path, nextData, message, sha) {
  const url = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${path}`;
  const body = {
    message,
    content: Buffer.from(JSON.stringify(nextData, null, 2), "utf8").toString("base64"),
    branch: GITHUB_REF,
    sha,
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders, Authorization: `Bearer ${GITHUB_TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT failed ${res.status}`);
  return res.json();
}

function json(res, status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function ensureAdmin(event) {
  const key = event.headers["x-admin-key"] || event.headers["X-Admin-Key"];
  if (!ADMIN_PASSWORD || key !== ADMIN_PASSWORD) throw new Error("unauthorized");
}

function sanitizeUser(u) {
  const allowed = ["email","password","name","status","start_date","end_date","device_fingerprint","session_nonce","lock_reason"];
  const out = {};
  for (const k of allowed) out[k] = u?.[k] ?? null;
  // Basic required fields
  if (!out.email || !out.password || !out.name) throw new Error("missing_fields");
  if (!out.status) out.status = "active";
  return out;
}

export default async (event) => {
  try {
    ensureAdmin(event);

    const method = event.httpMethod;
    const action = (event.queryStringParameters?.action || "").toLowerCase();

    if (method === "GET") {
      const { data } = await ghGetJson(USERS_PATH);
      return json(event, 200, { ok: true, users: data });
    }

    const body = event.body ? JSON.parse(event.body) : {};

    // Load current
    const { data: users, sha } = await ghGetJson(USERS_PATH);

    if (method === "POST") {
      if (action === "resetDevice") {
        const email = body?.email;
        const idx = users.findIndex(u => (u.email||"").toLowerCase() === (email||"").toLowerCase());
        if (idx === -1) return json(event, 404, { ok:false, error:"not_found" });
        users[idx].device_fingerprint = null;
        users[idx].session_nonce = null;
        await ghPutJson(USERS_PATH, users, `admin: reset device for ${email}`, sha);
        return json(event, 200, { ok:true, user: users[idx] });
      }
      // Create
      const nu = sanitizeUser(body);
      const exists = users.some(u => (u.email||"").toLowerCase() === nu.email.toLowerCase());
      if (exists) return json(event, 409, { ok:false, error:"exists" });
      users.push(nu);
      await ghPutJson(USERS_PATH, users, `admin: create user ${nu.email}`, sha);
      return json(event, 201, { ok:true, user: nu });
    }

    if (method === "PUT") {
      // Update by email (immutable key)
      const email = body?.email;
      if (!email) return json(event, 400, { ok:false, error:"missing_email" });
      const idx = users.findIndex(u => (u.email||"").toLowerCase() === email.toLowerCase());
      if (idx === -1) return json(event, 404, { ok:false, error:"not_found" });
      const merged = { ...users[idx], ...sanitizeUser({ ...users[idx], ...body, email }) };
      users[idx] = merged;
      await ghPutJson(USERS_PATH, users, `admin: update user ${email}`, sha);
      return json(event, 200, { ok:true, user: merged });
    }

    if (method === "DELETE") {
      const email = body?.email;
      if (!email) return json(event, 400, { ok:false, error:"missing_email" });
      const next = users.filter(u => (u.email||"").toLowerCase() !== email.toLowerCase());
      if (next.length === users.length) return json(event, 404, { ok:false, error:"not_found" });
      await ghPutJson(USERS_PATH, next, `admin: delete user ${email}`, sha);
      return json(event, 200, { ok:true, removed: email });
    }

    return json(event, 405, { ok:false, error:"method_not_allowed" });
  } catch (e) {
    const code = e.message === "unauthorized" ? 401 : 500;
    return new Response(JSON.stringify({ ok:false, error:e.message }), {
      status: code,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
};
