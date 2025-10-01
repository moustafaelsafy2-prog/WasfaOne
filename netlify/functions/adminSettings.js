// /netlify/functions/adminSettings.js — Netlify Functions (V1) + Node 18

const {
  ADMIN_PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REF = "main",
} = process.env;

const SETTINGS_PATH = "data/settings.json";
const PUBLIC_SETTINGS_PATH = "public/data/settings.json";

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

    // تحقّق كلمة الأدمن
    const key =
      event.headers["x-admin-key"] ||
      event.headers["X-Admin-Key"] ||
      event.headers["x-admin-key".toLowerCase()];
    if (!key || key !== ADMIN_PASSWORD) {
      return resp(401, { ok: false, error: "unauthorized" });
    }

    if (method === "GET") {
      const { data: settings = {}, sha } = await ghGetJson(SETTINGS_PATH);
      return resp(200, { ok: true, settings, sha });
    }

    if (method === "POST") {
      let body = {};
      try {
        body = JSON.parse(event.body || "{}");
      } catch (e) {
        body = {};
      }
      const next = body.settings || {};

      // قراءة النسخ الحالية
      const { data: current = {}, sha } = await ghGetJson(SETTINGS_PATH);
      const { data: currentPublic = {}, sha: shaPublic } = await ghGetJson(PUBLIC_SETTINGS_PATH);

      // دمج آمن للإعدادات
      const merged = {
        ...current,
        ...next,
        contact: { ...(current.contact || {}), ...(next.contact || {}) },
        brand: {
          ...(current.brand || {}),
          ...(next.brand || {}),
          logo: { ...(current.brand?.logo || {}), ...(next.brand?.logo || {}) },
          hero: { ...(current.brand?.hero || {}), ...(next.brand?.hero || {}) },
        },
        text: { ...(current.text || {}), ...(next.text || {}) },
        legal: { ...(current.legal || {}), ...(next.legal || {}) },
      };

      // حفظ settings.json (الخاص)
      await ghPutJson(SETTINGS_PATH, merged, `admin: update data/settings.json`, sha);

      // تحديث نسخة public/data/settings.json (فرونت)
      const publicSchema = {
        default_lang: merged.default_lang || "ar",
        contact: merged.contact || {},
        brand: merged.brand || {},
        text: merged.text || {},
        legal: merged.legal || {},
      };
      await ghPutJson(
        PUBLIC_SETTINGS_PATH,
        publicSchema,
        `admin: update public/data/settings.json`,
        shaPublic
      );

      return resp(200, { ok: true, settings: next });
    }

    return resp(405, { ok: false, error: "method_not_allowed" });
  } catch (e) {
    return resp(500, { ok: false, error: "exception", message: e.message });
  }
};
