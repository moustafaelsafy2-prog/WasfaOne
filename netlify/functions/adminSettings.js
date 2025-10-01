/**
 * المسار: /netlify/functions/adminSettings.js
 * الوظيفة: إدارة ملف الإعدادات الخاص بمشروع WasfaOne قراءةً وتحديثًا عبر GitHub Contents API.
 * المتطلبات البيئية (Environment Variables):
 *   - ADMIN_PASSWORD           كلمة مرور لوحة الإدارة للمصادقة على الطلبات.
 *   - GITHUB_TOKEN             توكن جيتهاب مع صلاحية repo:contents للقراءة والكتابة.
 *   - GITHUB_REPO_OWNER        اسم صاحب المستودع (owner).
 *   - GITHUB_REPO_NAME         اسم المستودع (repo).
 *   - GITHUB_REF               اسم الفرع (افتراضي: "main").
 *   - GIT_COMMIT_AUTHOR_NAME   اسم كاتب الكومِت (افتراضي: "WasfaOne Bot").
 *   - GIT_COMMIT_AUTHOR_EMAIL  بريد كاتب الكومِت (افتراضي: "bot@wasfaone.local").
 *
 * نقاط النهاية:
 *   OPTIONS  — للـ CORS.
 *   GET      — إرجاع آخر إعدادات محفوظة من المستودع (من data/settings.json أو public/data/settings.json).
 *   POST     — استلام كائن إعدادات جديد والتحقق منه ثم حفظه إلى كلا المسارين في المستودع بكومِتَيْن.
 *
 * بروتوكول المصادقة:
 *   - يجب تمرير الهيدر: x-admin-password ويطابق ADMIN_PASSWORD.
 *
 * قواعد صارمة:
 *   1) يجب أن يحتوي الحقل diet_systems على عنصر معرفه (id) يساوي "dr_mohamed_saeed".
 *   2) كل عنصر في diet_systems يجب أن يحتوي على الحقول:
 *      id, name_ar, name_en, description_ar, description_en (جميعها نصوص غير فارغة).
 *   3) يجب تحقق أقسام branding و contact وفق الشروط المفصلة أدناه.
 *   4) لا يُسمح بإسقاط أي حقل أساسي؛ وإذا وُجدت حقول إضافية فهي مسموحة ولن تُحذف.
 *   5) الاستجابات حتمية، منسقة، ولا يوجد فيها أي اختصار.
 */

const {
  ADMIN_PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REF = "main",
  GIT_COMMIT_AUTHOR_NAME = "WasfaOne Bot",
  GIT_COMMIT_AUTHOR_EMAIL = "bot@wasfaone.local"
} = process.env;

// المسارات التي سنديرها داخل المستودع
const SETTINGS_PATH = "data/settings.json";
const PUBLIC_SETTINGS_PATH = "public/data/settings.json";

// عنوان أساس واجهة GitHub للمحتوى
const BASE_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/`;

// ترويسات أساسية لكل طلبات GitHub API
const baseHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "User-Agent": "WasfaOne-AdminSettings/1.0",
  Accept: "application/vnd.github+json"
};

// ترويسات CORS كاملة
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-password"
};

// دالة مساعدة لإرجاع JSON موحّد
function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
    body: JSON.stringify(body)
  };
}

// التحقق من وجود جميع المتغيرات البيئية المطلوبة
function verifyRequiredEnv() {
  const missing = [];
  if (!ADMIN_PASSWORD) missing.push("ADMIN_PASSWORD");
  if (!GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!GITHUB_REPO_OWNER) missing.push("GITHUB_REPO_OWNER");
  if (!GITHUB_REPO_NAME) missing.push("GITHUB_REPO_NAME");
  if (missing.length > 0) {
    throw new Error(`missing_env:${missing.join(",")}`);
  }
}

// جلب ملف JSON من GitHub Contents API وإرجاعه مفكوكًا مع SHA
async function githubGetJson(path) {
  const url = `${BASE_URL}${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_REF)}`;
  const response = await fetch(url, { headers: baseHeaders });

  if (response.status === 404) {
    return { data: null, sha: null };
  }

  if (!response.ok) {
    throw new Error(`GH_GET_${response.status}`);
  }

  const payload = await response.json();
  const contentBase64 = payload.content || "";
  const decoded = Buffer.from(contentBase64, "base64").toString("utf8");
  const data = decoded ? JSON.parse(decoded) : null;
  const sha = payload.sha || null;

  return { data, sha };
}

// كتابة (PUT) ملف JSON إلى GitHub Contents API مع رسالة كومِت
async function githubPutJson(path, object, message, sha) {
  const url = `${BASE_URL}${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(JSON.stringify(object, null, 2), "utf8").toString("base64"),
    sha: sha || undefined,
    branch: GITHUB_REF,
    committer: { name: GIT_COMMIT_AUTHOR_NAME, email: GIT_COMMIT_AUTHOR_EMAIL }
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GH_PUT_${response.status}:${text.slice(0, 300)}`);
  }

  const payload = await response.json();
  const newSha = payload?.content?.sha || null;

  return { ok: true, sha: newSha };
}

// أدوات تحقق عامة للمدخلات
function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function isOptionalUrl(v) {
  if (v == null) return true;
  try {
    new URL(String(v));
    return true;
  } catch {
    return false;
  }
}

/**
 * التحقق من قسم "branding"
 * مطلوب: site_name_ar, site_name_en
 * اختياري: logo_url (إن وُجد يجب أن يكون URL صالح)
 */
function validateBranding(branding) {
  if (!branding || typeof branding !== "object") return "branding_object_required";
  if (!isNonEmptyString(branding.site_name_ar)) return "branding.site_name_ar_required";
  if (!isNonEmptyString(branding.site_name_en)) return "branding.site_name_en_required";
  if (branding.logo_url != null && !isOptionalUrl(branding.logo_url)) return "branding.logo_url_must_be_url";
  return null;
}

/**
 * التحقق من قسم "contact"
 * مطلوب: phone_display, whatsapp_link, email
 * اختياري: social (إن وُجد يجب أن تكون القيم داخله عناوين URL صالحة)
 */
function validateContact(contact) {
  if (!contact || typeof contact !== "object") return "contact_object_required";
  if (!isNonEmptyString(contact.phone_display)) return "contact.phone_display_required";
  if (!isNonEmptyString(contact.whatsapp_link)) return "contact.whatsapp_link_required";
  if (!isNonEmptyString(contact.email)) return "contact.email_required";
  if (contact.social && typeof contact.social === "object") {
    for (const key of Object.keys(contact.social)) {
      if (!isOptionalUrl(contact.social[key])) return `contact.social.${key}_must_be_url`;
    }
  }
  return null;
}

/**
 * التحقق من عنصر نظام غذائي واحد داخل diet_systems
 * مطلوب: id, name_ar, name_en, description_ar, description_en
 */
function validateDietItem(diet) {
  if (!diet || typeof diet !== "object") return "diet_item_must_be_object";
  if (!isNonEmptyString(diet.id)) return "diet_item.id_required";
  if (!isNonEmptyString(diet.name_ar)) return "diet_item.name_ar_required";
  if (!isNonEmptyString(diet.name_en)) return "diet_item.name_en_required";
  if (!isNonEmptyString(diet.description_ar)) return "diet_item.description_ar_required";
  if (!isNonEmptyString(diet.description_en)) return "diet_item.description_en_required";
  return null;
}

/**
 * التحقق الكامل لملف الإعدادات
 * بنية متوقعة:
 * {
 *   branding: { site_name_ar, site_name_en, logo_url? },
 *   contact:  { phone_display, whatsapp_link, email, social? },
 *   diet_systems: [ {id, name_ar, name_en, description_ar, description_en}, ... ],
 *   images?: {...},
 *   images_meta?: {...}
 * }
 *
 * الشروط الإلزامية:
 *   - وجود عنصر بنظام "dr_mohamed_saeed".
 *   - diet_systems مصفوفة غير فارغة وكل عنصر صحيح البنية.
 *   - أقسام branding و contact صحيحة.
 */
function validateSettingsStructure(settings) {
  if (!settings || typeof settings !== "object") {
    return { ok: false, error: "settings_object_required" };
  }

  const brandingError = validateBranding(settings.branding);
  if (brandingError) {
    return { ok: false, error: brandingError };
  }

  const contactError = validateContact(settings.contact);
  if (contactError) {
    return { ok: false, error: contactError };
  }

  const list = settings.diet_systems;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: "diet_systems_required_nonempty" };
  }

  for (let i = 0; i < list.length; i++) {
    const err = validateDietItem(list[i]);
    if (err) {
      return { ok: false, error: `${err}@index_${i}` };
    }
  }

  const hasDrMohamed = list.some(item => String(item.id) === "dr_mohamed_saeed");
  if (!hasDrMohamed) {
    return { ok: false, error: "dr_mohamed_saeed_missing" };
  }

  // لا قيود إضافية على الحقول الاختيارية (images, images_meta...إلخ)
  return { ok: true };
}

/**
 * تطبيع بسيط قبل الحفظ:
 * - ترتيب الأنظمة لضمان ظهور "د. محمد سعيد" أولاً ثم البقية بترتيب أبجدي عربي بحسب name_ar.
 * - عدم حذف أي حقول إضافية، فقط نعيد ترتيب diet_systems.
 */
function canonicalizeSettings(next) {
  try {
    if (Array.isArray(next.diet_systems)) {
      const sorted = [...next.diet_systems].sort((a, b) => {
        if (a.id === "dr_mohamed_saeed") return -1;
        if (b.id === "dr_mohamed_saeed") return 1;
        return String(a.name_ar || "").localeCompare(String(b.name_ar || ""), "ar");
      });
      next.diet_systems = sorted;
    }
  } catch {
    // في حال حدث خطأ لا نوقف التنفيذ؛ لن نغير المصفوفة
  }
  return next;
}

/**
 * معالِج الدالة السحابية (Netlify Function Handler)
 * يطبق جميع القواعد المذكورة أعلاه دون أي اختصار.
 */
exports.handler = async (event) => {
  try {
    // أولاً: التحقق من المتغيرات البيئية
    verifyRequiredEnv();

    const method = event.httpMethod || "GET";

    // دعم OPTIONS للـ CORS
    if (method === "OPTIONS") {
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    // مصادقة الإدارة عبر الهيدر x-admin-password
    const headerPassword =
      event.headers?.["x-admin-password"] ||
      event.headers?.["X-Admin-Password"] ||
      event.headers?.["x-Admin-Password"];
    if (!headerPassword || headerPassword !== ADMIN_PASSWORD) {
      return json(401, { ok: false, error: "unauthorized" });
    }

    // معالجة طلب القراءة GET
    if (method === "GET") {
      // نحاول قراءة الملفين: الخاص والعام. إن كان أحدهما غير موجود نعيد الموجود.
      const { data: settingsPrivate, sha: shaPrivate } = await githubGetJson(SETTINGS_PATH);
      const { data: settingsPublic,  sha: shaPublic  } = await githubGetJson(PUBLIC_SETTINGS_PATH);

      if (!settingsPrivate && !settingsPublic) {
        return json(404, { ok: false, error: "settings_not_found" });
      }

      // نعيد الإعدادات (الأولوية للخاص إن وُجد)
      const settings = settingsPrivate || settingsPublic || null;

      return json(200, {
        ok: true,
        settings,
        shaPrivate: shaPrivate || null,
        shaPublic: shaPublic || null
      });
    }

    // معالجة طلب التحديث POST
    if (method === "POST") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { ok: false, error: "invalid_json_body" });
      }

      const nextSettings = body?.settings;
      if (!nextSettings) {
        return json(400, { ok: false, error: "settings_field_required" });
      }

      // تحقق كامل من البنية
      const validation = validateSettingsStructure(nextSettings);
      if (!validation.ok) {
        return json(400, { ok: false, error: validation.error });
      }

      // تطبيع قبل الحفظ (ترتيب الأنظمة)
      const canonical = canonicalizeSettings({ ...nextSettings });

      // جلب قيم SHA الحالية للملفين
      const { sha: shaPrivate } = await githubGetJson(SETTINGS_PATH);
      const { sha: shaPublic }  = await githubGetJson(PUBLIC_SETTINGS_PATH);

      // كتابة الملف الخاص
      await githubPutJson(
        SETTINGS_PATH,
        canonical,
        body.commitMessage || "admin: update data/settings.json",
        shaPrivate
      );

      // كتابة الملف العام
      await githubPutJson(
        PUBLIC_SETTINGS_PATH,
        canonical,
        body.commitMessage || "admin: update public/data/settings.json",
        shaPublic
      );

      // استجابة نجاح نهائية حتمية
      return json(200, {
        ok: true,
        settings: canonical
      });
    }

    // إن لم تكن الطريقة مدعومة
    return json(405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    // التصرّف الموحد في حال الاستثناء
    const message = error && error.message ? error.message : String(error);
    return json(500, { ok: false, error: "exception", message });
  }
};
