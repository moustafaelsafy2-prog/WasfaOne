// /netlify/functions/adminSettings.js — Netlify Functions (V1) + Node 18
// تغييرات رئيسية:
// - دعم CORS + OPTIONS.
// - دعم GET لاسترجاع الإعدادات.
// - دعم PUT لحفظ الإعدادات (الواجهة ترسل payload مباشر، وليس {settings}).
// - دمج آمن مع القيم الحالية وعدم فقدان الحقول.
// - كتابة نسختين: data/settings.json (الكاملة) + public/data/settings.json (نسخة للفرونت).
//   * النسخة العلنية تشمل: default_lang, branding, contact, diet_systems, images, images_meta, text, legal
//   * ذلك لأن الواجهة تستخدم diet_systems و images و images_meta مباشرة.
// - استخدام GitHub Contents API (commit) بنفس أسلوب باقي الوظائف.

const {
  ADMIN_PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REF = "main",
} = process.env;

const SETTINGS_PATH = "data/settings.json";               // المصدر الكامل (مرجعي)
const PUBLIC_SETTINGS_PATH = "public/data/settings.json"; // نسخة للاستهلاك من الفرونت

const BASE_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/`;
const baseHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "WasfaOne-Netlify",
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-key",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function resp(status, obj) {
  return {
    statusCode: status,
    headers: CORS_HEADERS,
    body: JSON.stringify(obj),
  };
}

async function ghGetJson(path) {
  const url = `${BASE_URL}${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_REF)}`;
  const r = await fetch(url, { headers: baseHeaders });
  if (r.status === 404) return { data: {}, sha: null }; // قد لا يكون الملف موجودًا بعد
  if (!r.ok) throw new Error(`gh_get_failed_${r.status}`);
  const j = await r.json();
  const content = Buffer.from(j.content || "", "base64").toString("utf-8");
  let data = {};
  try { data = JSON.parse(content); } catch (_) { data = {}; }
  return { data, sha: j.sha || null };
}

async function ghPutJson(path, data, message, sha) {
  const url = `${BASE_URL}${encodeURIComponent(path)}`;
  const body = {
    message: message || `update ${path}`,
    content: Buffer.from(JSON.stringify(data, null, 2), "utf-8").toString("base64"),
    branch: GITHUB_REF,
  };
  if (sha) body.sha = sha; // تمرير sha لو الملف موجود
  const r = await fetch(url, { method: "PUT", headers: baseHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`gh_put_failed_${r.status}`);
  return await r.json();
}

/* دمج بسيط للحقول الكائنية لتفادي فقدان الحقول الفرعية */
function deepMerge(current = {}, next = {}) {
  const out = { ...current };
  for (const k of Object.keys(next)) {
    const v = next[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(current[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* تصحيح أسماء الحقول لضمان التوافق (branding vs brand) */
function normalizeIncoming(payload = {}) {
  const p = { ...payload };

  // دعم كلا الاسمين: branding و brand (نحو توحيد "branding")
  if (p.brand && !p.branding) {
    p.branding = p.brand;
    delete p.brand;
  }

  // هياكل متوقعة
  p.branding = p.branding || {};
  p.contact = p.contact || {};
  p.text = p.text || {};
  p.legal = p.legal || {};
  p.diet_systems = Array.isArray(p.diet_systems) ? p.diet_systems : [];
  p.images = p.images || {};
  p.images_meta = p.images_meta || {};

  return p;
}

/* توليد نسخة علنية للفرونت */
function toPublicSchema(mergedFull) {
  return {
    default_lang: mergedFull.default_lang || "ar",
    branding: mergedFull.branding || {},
    contact: mergedFull.contact || {},
    text: mergedFull.text || {},
    legal: mergedFull.legal || {},
    diet_systems: Array.isArray(mergedFull.diet_systems) ? mergedFull.diet_systems : [],
    images: mergedFull.images || {},
    images_meta: mergedFull.images_meta || {},
  };
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod || "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: CORS_HEADERS,
        body: "",
      };
    }

    // تحقق من المتغيرات
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

    if (method === "PUT") {
      let incoming = {};
      try { incoming = JSON.parse(event.body || "{}"); } catch { incoming = {}; }

      // تطبيع الحمولة الواردة
      const next = normalizeIncoming(incoming);

      // قراءة النسخ الحالية
      const { data: current = {}, sha } = await ghGetJson(SETTINGS_PATH);
      const { data: currentPublic = {}, sha: shaPublic } = await ghGetJson(PUBLIC_SETTINGS_PATH);

      // دمج آمن (حقول كائنية تُدمج بدل الاستبدال الأعمى)
      // NB: المصفوفات (مثل diet_systems) تُستبدل بالكامل كما وردت.
      const merged = {
        ...deepMerge(current, next),
        diet_systems: Array.isArray(next.diet_systems) ? next.diet_systems : (current.diet_systems || []),
        images: deepMerge(current.images || {}, next.images || {}),
        images_meta: deepMerge(current.images_meta || {}, next.images_meta || {}),
      };

      // حفظ النسخة الكاملة
      await ghPutJson(SETTINGS_PATH, merged, `admin: update ${SETTINGS_PATH}`, sha);

      // حفظ النسخة العلنية (للفرونت)
      const publicSchema = toPublicSchema(merged);
      await ghPutJson(PUBLIC_SETTINGS_PATH, publicSchema, `admin: update ${PUBLIC_SETTINGS_PATH}`, shaPublic);

      return resp(200, { ok: true, settings: merged });
    }

    return resp(405, { ok: false, error: "method_not_allowed" });
  } catch (e) {
    return resp(500, { ok: false, error: "exception", message: e.message });
  }
};
