// /netlify/functions/adminSettings.js — Netlify Functions (V1) + Node 18
// - accepts GET (read), POST/PUT (update)
// - merges both "branding" and legacy "brand"
// - writes private:   data/settings.json
// - writes public:    public/data/settings.json (frontend-safe subset)

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
    // If file doesn't exist yet for the public copy, return empty object
    if (r.status === 404) return { data: {}, sha: null };
    throw new Error(`gh_get_failed_${r.status}`);
  }
  const j = await r.json();
  const content = Buffer.from(j.content || "", "base64").toString("utf-8");
  let data = {};
  try { data = JSON.parse(content || "{}"); } catch { data = {}; }
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
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`gh_put_failed_${r.status}:${t.slice(0,200)}`);
  }
  return await r.json();
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod || "GET";

    // Basic config guard
    if (!ADMIN_PASSWORD || !GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
      return resp(500, { ok: false, error: "config_missing" });
    }

    // Admin auth
    const key =
      event.headers["x-admin-key"] ||
      event.headers["X-Admin-Key"] ||
      event.headers["x-admin-key".toLowerCase()];
    if (!key || key !== ADMIN_PASSWORD) {
      return resp(401, { ok: false, error: "unauthorized" });
    }

    // ===== GET => read private settings =====
    if (method === "GET") {
      const { data: settings = {}, sha } = await ghGetJson(SETTINGS_PATH);
      return resp(200, { ok: true, settings, sha });
    }

    // ===== POST/PUT => update settings =====
    if (method === "POST" || method === "PUT") {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

      // Support both body.settings and raw body
      const incoming = body.settings || body || {};

      // Load current files
      const { data: current = {}, sha } = await ghGetJson(SETTINGS_PATH);
      const { data: currentPublic = {}, sha: shaPublic } = await ghGetJson(PUBLIC_SETTINGS_PATH);

      // Backward-compat for "brand" vs "branding"
      const mergedBranding = {
        ...(current.branding || current.brand || {}),
        ...(incoming.branding || incoming.brand || {}),
      };

      // Safe deep merges for known sections
      const merged = {
        ...current,
        ...incoming,
        branding: mergedBranding,
        contact: { ...(current.contact || {}), ...(incoming.contact || {}) },
        text: { ...(current.text || {}), ...(incoming.text || {}) },
        legal: { ...(current.legal || {}), ...(incoming.legal || {}) },
        pricing: { ...(current.pricing || {}), ...(incoming.pricing || {}) },
        images: { ...(current.images || {}), ...(incoming.images || {}) },
        images_meta: { ...(current.images_meta || {}), ...(incoming.images_meta || {}) },
        // diet_systems: take incoming array if provided, else keep current
        diet_systems: Array.isArray(incoming.diet_systems) ? incoming.diet_systems : (current.diet_systems || []),
        default_lang: incoming.default_lang || current.default_lang || "ar",
      };

      // Write private settings
      await ghPutJson(SETTINGS_PATH, merged, `admin: update ${SETTINGS_PATH}`, sha);

      // Build public subset (frontend)
      const publicSchema = {
        default_lang: merged.default_lang || "ar",
        branding: merged.branding || {},
        contact: merged.contact || {},
        diet_systems: merged.diet_systems || [],
        images: merged.images || {},
        images_meta: merged.images_meta || {},
        pricing: merged.pricing || {},
        legal: merged.legal || {},
        // Optional public text blocks (if you want to expose them)
        text: merged.text || {}
      };

      await ghPutJson(
        PUBLIC_SETTINGS_PATH,
        publicSchema,
        `admin: update ${PUBLIC_SETTINGS_PATH}`,
        shaPublic
      );

      return resp(200, { ok: true, settings: merged });
    }

    return resp(405, { ok: false, error: "method_not_allowed" });
  } catch (e) {
    return resp(500, { ok: false, error: "exception", message: e.message });
  }
};
