// /netlify/functions/adminSettings.js — Netlify Functions (Node 18) — إدارة إعدادات WasfaOne
// - Auth via x-admin-password == ADMIN_PASSWORD
// - Reads/Writes data/settings.json AND public/data/settings.json using GitHub Contents API
// - Strict schema validation (branding, contact, diet_systems[]), enforces presence of Dr. Mohamed Saeed system
// - Fully deterministic responses

const {
  ADMIN_PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REF = "main",
  GIT_COMMIT_AUTHOR_NAME = "WasfaOne Bot",
  GIT_COMMIT_AUTHOR_EMAIL = "bot@wasfaone.local"
} = process.env;

const SETTINGS_PATH = "data/settings.json";
const PUBLIC_SETTINGS_PATH = "public/data/settings.json";

const BASE_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/`;
const baseHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "User-Agent": "WasfaOne-AdminSettings/1.0",
  Accept: "application/vnd.github+json"
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-password"
};

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  body: JSON.stringify(body)
});

function requireEnv() {
  const miss = [];
  if (!ADMIN_PASSWORD) miss.push("ADMIN_PASSWORD");
  if (!GITHUB_TOKEN) miss.push("GITHUB_TOKEN");
  if (!GITHUB_REPO_OWNER) miss.push("GITHUB_REPO_OWNER");
  if (!GITHUB_REPO_NAME) miss.push("GITHUB_REPO_NAME");
  if (miss.length) {
    throw new Error(`missing_env:${miss.join(",")}`);
  }
}

/* ---------------- GitHub Contents helpers ---------------- */
async function ghGetJson(path) {
  const url = `${BASE_URL}${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_REF)}`;
  const r = await fetch(url, { headers: baseHeaders });
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error(`GH_GET_${r.status}`);
  const j = await r.json();
  const txt = Buffer.from(j.content || "", "base64").toString("utf8");
  return { data: txt ? JSON.parse(txt) : null, sha: j.sha };
}

async function ghPutJson(path, obj, message, sha) {
  const url = `${BASE_URL}${encodeURIComponent(path)}`;
  const payload = {
    message,
    content: Buffer.from(JSON.stringify(obj, null, 2), "utf8").toString("base64"),
    sha: sha || undefined,
    branch: GITHUB_REF,
    committer: { name: GIT_COMMIT_AUTHOR_NAME, email: GIT_COMMIT_AUTHOR_EMAIL }
  };
  const r = await fetch(url, {
    method: "PUT",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GH_PUT_${r.status}:${t.slice(0,200)}`);
  }
  const j = await r.json();
  return { ok: true, sha: j.content?.sha || null };
}

/* ---------------- Schema validation ---------------- */
function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function isOptionalUrl(v) { if (v == null) return true; try { new URL(String(v)); return true; } catch { return false; } }

function validateBranding(b) {
  if (!b || typeof b !== "object") return "branding_object_required";
  if (!isNonEmptyString(b.site_name_ar)) return "branding.site_name_ar_required";
  if (!isNonEmptyString(b.site_name_en)) return "branding.site_name_en_required";
  if (b.logo_url != null && !isOptionalUrl(b.logo_url)) return "branding.logo_url_must_be_url";
  return null;
}

function validateContact(c) {
  if (!c || typeof c !== "object") return "contact_object_required";
  if (!isNonEmptyString(c.phone_display)) return "contact.phone_display_required";
  if (!isNonEmptyString(c.whatsapp_link)) return "contact.whatsapp_link_required";
  if (!isNonEmptyString(c.email)) return "contact.email_required";
  if (c.social && typeof c.social === "object") {
    const s = c.social;
    for (const k of Object.keys(s)) {
      if (!isOptionalUrl(s[k])) return `contact.social.${k}_must_be_url`;
    }
  }
  return null;
}

function validateDietItem(d) {
  if (!d || typeof d !== "object") return "diet_item_must_be_object";
  if (!isNonEmptyString(d.id)) return "diet_item.id_required";
  if (!isNonEmptyString(d.name_ar)) return "diet_item.name_ar_required";
  if (!isNonEmptyString(d.name_en)) return "diet_item.name_en_required";
  if (!isNonEmptyString(d.description_ar)) return "diet_item.description_ar_required";
  if (!isNonEmptyString(d.description_en)) return "diet_item.description_en_required";
  return null;
}

function validateSettings(next) {
  if (!next || typeof next !== "object") return { ok: false, error: "settings_object_required" };

  // branding
  const e1 = validateBranding(next.branding);
  if (e1) return { ok: false, error: e1 };

  // contact
  const e2 = validateContact(next.contact);
  if (e2) return { ok: false, error: e2 };

  // diet_systems
  const list = next.diet_systems;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "diet_systems_required_nonempty" };

  for (let i = 0; i < list.length; i++) {
    const e = validateDietItem(list[i]);
    if (e) return { ok: false, error: `${e}@index_${i}` };
  }

  // must include Dr. Mohamed Saeed
  const dr = list.find(x => String(x.id) === "dr_mohamed_saeed");
  if (!dr) return { ok: false, error: "dr_mohamed_saeed_missing" };

  // must include Custom if desired (اختياري)، لا نُلزم وجوده لكن نسمح به
  // لا قيود إضافية على باقي الحقول مثل images/images_meta، إن وجدت نسمح بوجودها كما هي

  return { ok: true };
}

/* ---------------- Sanitization / Canonicalization ---------------- */
function canonicalize(next) {
  // فرز الأنظمة اختياريًا لإبقاء "د. محمد سعيد" في الأعلى إن وُجد، والباقي حسب الاسم العربي
  try {
    const arr = Array.isArray(next.diet_systems) ? [...next.diet_systems] : [];
    arr.sort((a, b) => {
      if (a.id === "dr_mohamed_saeed") return -1;
      if (b.id === "dr_mohamed_saeed") return 1;
      return String(a.name_ar || "").localeCompare(String(b.name_ar || ""), "ar");
    });
    next.diet_systems = arr;
  } catch {}
  return next;
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  try {
    requireEnv();

    const method = event.httpMethod || "GET";
    if (method === "OPTIONS") {
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    // Auth
    const pass = event.headers?.["x-admin-password"] || event.headers?.["X-Admin-Password"];
    if (!pass || pass !== ADMIN_PASSWORD) {
      return json(401, { ok: false, error: "unauthorized" });
    }

    if (method === "GET") {
      const { data: settings, sha: shaPrivate } = await ghGetJson(SETTINGS_PATH);
      const { data: pubSettings, sha: shaPublic } = await ghGetJson(PUBLIC_SETTINGS_PATH);

      if (!settings && !pubSettings) {
        return json(404, { ok: false, error: "settings_not_found" });
      }

      // نعيد الخاص ونضمّن SHA للإدارة المتقدمة (لو أردت التفاف متفائل)
      return json(200, {
        ok: true,
        settings: settings || pubSettings,
        shaPrivate: shaPrivate || null,
        shaPublic: shaPublic || null
      });
    }

    if (method === "POST") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { ok: false, error: "invalid_json_body" });
      }

      const next = body && body.settings;
      if (!next) return json(400, { ok: false, error: "settings_field_required" });

      // تحقق
      const v = validateSettings(next);
      if (!v.ok) return json(400, { ok: false, error: v.error });

      // ترتيب/تطبيع
      const canon = canonicalize({ ...next });

      // إحضار SHA الحالية
      const { sha: shaPrivate } = await ghGetJson(SETTINGS_PATH);
      const { sha: shaPublic } = await ghGetJson(PUBLIC_SETTINGS_PATH);

      // كتابة ملفات الإعدادات (خاص وعام)
      await ghPutJson(
        SETTINGS_PATH,
        canon,
        body.commitMessage || "admin: update data/settings.json",
        shaPrivate
      );

      await ghPutJson(
        PUBLIC_SETTINGS_PATH,
        canon,
        body.commitMessage || "admin: update public/data/settings.json",
        shaPublic
      );

      return json(200, { ok: true, settings: canon });
    }

    return json(405, { ok: false, error: "method_not_allowed" });
  } catch (e) {
    return json(500, { ok: false, error: "exception", message: e && e.message ? e.message : String(e) });
  }
};
