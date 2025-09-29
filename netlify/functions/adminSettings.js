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
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error(`GH_GET_${r.status}`);
  const j = await r.json();
  const txt = Buffer.from(j.content || "", "base64").toString("utf8");
  return { data: txt ? JSON.parse(txt) : null, sha: j.sha };
}

async function ghPutJson(path, nextData, message, sha) {
  const url = `${BASE_URL}${path}`;
  const body = {
    message,
    content: Buffer.from(JSON.stringify(nextData, null, 2), "utf8").toString("base64"),
    branch: GITHUB_REF,
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, { method: "PUT", headers: baseHeaders, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GH_PUT_${r.status}:${t.slice(0,200)}`);
  }
  return r.json();
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204 };

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

    const method = event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};

    // إرجاع الإعدادات الحالية (خاصة بالأدمن)
    if (method === "GET") {
      const { data } = await ghGetJson(SETTINGS_PATH);
      const defaults = {
        branding: { site_name_ar: "WasfaOne", site_name_en: "WasfaOne", logo_url: "" },
        contact: { phone_display: "", whatsapp_link: "", email: "", social: {} },
        diet_systems: [],
        images: {},
        images_meta: {}
      };
      return resp(200, { ok: true, settings: data || defaults });
    }

    if (method === "PUT") {
      // حفظ الإعدادات الرسمية
      const next = {
        branding: body.branding || {},
        contact: body.contact || {},
        diet_systems: Array.isArray(body.diet_systems) ? body.diet_systems : [],
        images: body.images || {},
        images_meta: body.images_meta || {}
      };

      // 1) تحديث الملف الرسمي: data/settings.json
      const { sha } = await ghGetJson(SETTINGS_PATH);
      await ghPutJson(SETTINGS_PATH, next, `admin: update settings.json`, sha);

      // 2) إنتاج نسخة عامة تقرؤها الواجهات: public/data/settings.json
      //    نحافظ على توافق قديم إن وُجد: حقل diets= diet_systems، مع نقل بسيط للحقول.
      const publicSchema = {
        branding: next.branding || {},
        contact: {
          phone_display: next.contact?.phone_display || "",
          whatsapp_link: next.contact?.whatsapp_link || "",
          email: next.contact?.email || "",
          social: next.contact?.social || {}
        },
        // الحقل العام الذي ستستعمله الواجهات مباشرة
        diets: (next.diet_systems || []).map(d => ({
          id: d.id || "",
          name_ar: d.name_ar || "",
          name_en: d.name_en || "",
          description_ar: d.description_ar || "",
          description_en: d.description_en || ""
        })),
        images: next.images || {},
        alts: Object.fromEntries(
          Object.entries(next.images_meta || {}).map(([k, v]) => [k, {
            ar: v?.alt_ar || "",
            en: v?.alt_en || ""
          }])
        )
      };

      const { sha: shaPublic } = await ghGetJson(PUBLIC_SETTINGS_PATH);
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
