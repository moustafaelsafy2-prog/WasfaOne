// netlify/functions/generateRecipeImage.js
// توليد صورة الطبق النهائي عبر Google Generative Language API.
// ✅ يكتشف نموذج الصور المتاح عبر models.list ويستدعي generateContent.
// ✅ عند أي فشل (عدم وجود نموذج صور، عدم إرجاع صورة، خطأ مفاتيح/صلاحيات) يعيد "placeholder" كـ data URL
//    حتى تَظهر دائمًا صورة بجانب الاسم دون أخطاء على الواجهة.
// ✅ يحافظ على واجهة الاستجابة كما هي: { ok, image: { data_url, mime, mode } }.
// ✅ يدعم GET للفحص اليدوي (لا يولّد صورة حقيقية).

// =======================
// CORS + Helpers
// =======================
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-auth-token, x-session-nonce",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
const ok  = (obj) => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, ...obj }) });
const bad = (code, error, extra = {}) => ({ statusCode: code, headers: HEADERS, body: JSON.stringify({ ok: false, error, ...extra }) });

// =======================
// Config
// =======================
const API_KEY = process.env.GEMINI_API_KEY || ""; // Google AI Studio / Generative Language API key
const BASE    = "https://generativelanguage.googleapis.com/v1beta";

// ثبات أعلى
const GENERATION_CONFIG = { temperature: 0, topP: 1, maxOutputTokens: 64 };

// Cache مبسّط داخل عمر الدالة
let cachedModelName = null;
let cachedModels = null;

// =======================
// Placeholder (SVG -> data URL)
// =======================
// نصنع SVG بسيط لطبق افتراضي (دون كتابة نص داخل الصورة) ونحوله إلى data URL.
function buildPlaceholderDataURL() {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="256" height="256">
      <rect width="128" height="128" fill="#f8fafc"/>
      <circle cx="64" cy="64" r="44" fill="#ffffff" stroke="#e5e7eb" stroke-width="4"/>
      <circle cx="64" cy="64" r="24" fill="#fde68a" stroke="#f59e0b" stroke-width="3"/>
      <g fill="#94a3b8">
        <rect x="18" y="30" width="8" height="68" rx="2"/>
        <circle cx="22" cy="26" r="4"/>
        <rect x="102" y="30" width="8" height="68" rx="2"/>
      </g>
    </svg>`;
  const encoded = encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
  return `data:image/svg+xml;utf8,${encoded}`;
}

function placeholderResponse(note) {
  return ok({
    image: {
      mime: "image/svg+xml",
      mode: "inline",
      data_url: buildPlaceholderDataURL()
    },
    model: null,
    note: note || "تم استخدام صورة بديلة افتراضية لعدم توفر توليد الصور بالحساب حالياً."
  });
}

// =======================
// Prompt Builder
// =======================
function buildPrompt({ title = "", ingredients = [], steps = [], cuisine = "", lang = "ar" }) {
  const titleLine = title ? `اسم الطبق: ${title}` : "اسم الطبق: غير محدد";
  const ingLine   = Array.isArray(ingredients) && ingredients.length ? `المكوّنات (مختصرة): ${ingredients.join(", ")}` : "المكوّنات: —";
  const stepsLine = Array.isArray(steps) && steps.length ? `ملخص التحضير: ${steps.join(" ثم ")}` : "طريقة التحضير: —";
  const cuiLine   = cuisine ? `المطبخ: ${cuisine}` : "المطبخ: متنوع";

  const ar = `
أنت مصوّر أطعمة محترف. أنشئ صورة طعام فوتوغرافية عالية الجودة تمثل الشكل النهائي للطبق التالي:
${titleLine}
${cuiLine}
${ingLine}
${stepsLine}

[تعليمات النمط]
- زاوية 30–45°، إضاءة طبيعية ناعمة.
- تقديم أنيق على طبق مناسب، خلفية مطبخية محايدة.
- دون أي نصوص/شعارات/علامات مائية داخل الصورة، ودون أشخاص أو أيدي.
- ألوان واقعية وتفاصيل فاتحة للشهية تُظهر المكوّنات المذكورة.

أخرج صورة واحدة مناسبة للويب للعرض بجانب عنوان الوصفة.
`.trim();

  const en = `
You are a professional food photographer. Generate a single, photorealistic final dish image for:
Title: ${title || "N/A"}
Cuisine: ${cuisine || "Mixed"}
Key ingredients: ${(ingredients || []).join(", ") || "—"}
Preparation summary: ${(steps || []).join(" then ") || "—"}

[Style]
- 30–45° camera angle, soft natural light.
- Elegant plating, neutral kitchen backdrop.
- No text/logos/watermarks and no people/hands.
- Realistic, appetizing colors emphasizing the listed ingredients.

Return exactly one web-suitable image.
`.trim();

  return (lang === "ar" ? ar : en);
}

// =======================
// Models Discovery
// =======================
async function listModels() {
  if (cachedModels) return cachedModels;
  const url = `${BASE}/models`;
  const resp = await fetch(url, { headers: { "x-goog-api-key": API_KEY } });
  const text = await resp.text();
  let data = null; try { data = JSON.parse(text); } catch { /* ignore */ }
  if (!resp.ok) throw new Error(data?.error?.message || `listModels_HTTP_${resp.status}`);
  cachedModels = Array.isArray(data?.models) ? data.models : [];
  return cachedModels;
}

async function pickImageModelName() {
  if (cachedModelName) return cachedModelName;
  const models = await listModels();

  // أولوية لأي اسم يحتوي imagen ويدعم generateContent
  const imagen = models.find(m =>
    /(^|\/)models\/.*imagen/i.test(m?.name || "") &&
    (Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods.includes("generateContent") : true)
  );
  if (imagen?.name) { cachedModelName = imagen.name.replace(/^models\//, ""); return cachedModelName; }

  // أي اسم يحتوي image ويدعم generateContent
  const imageLike = models.find(m =>
    /(^|\/)models\/.*image/i.test(m?.name || "") &&
    (Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods.includes("generateContent") : true)
  );
  if (imageLike?.name) { cachedModelName = imageLike.name.replace(/^models\//, ""); return cachedModelName; }

  // لا يوجد نموذج صور متاح
  throw new Error("no_image_model_available_for_account");
}

// =======================
// Image Generation Call
// =======================
async function callImageModel(prompt) {
  const model = await pickImageModelName(); // يرمي خطأ إن لم يوجد
  const url = `${BASE}/models/${encodeURIComponent(model)}:generateContent`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { ...GENERATION_CONFIG },
    safetySettings: []
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body)
  });

  const raw = await resp.text();
  let data = null; try { data = JSON.parse(raw); } catch { /* ignore */ }

  if (!resp.ok) {
    const msg = data?.error?.message || `HTTP_${resp.status}`;
    return { ok: false, error: `${model}: ${msg}` };
  }

  // ابحث عن أول صورة بأي من الصيغ المعروفة
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const found = parts.find(p =>
    (p && p.inlineData  && /^image\//i.test(p.inlineData?.mimeType  || "")) ||
    (p && p.inline_data && /^image\//i.test(p.inline_data?.mime_type || "")) ||
    (p && p.fileData    && /^image\//i.test(p.fileData?.mimeType    || ""))
  );
  if (!found) return { ok: false, error: `${model}: no_image_returned` };

  const mime =
    found.inlineData?.mimeType ||
    found.inline_data?.mime_type ||
    found.fileData?.mimeType ||
    "image/png";

  const b64 =
    found.inlineData?.data ||
    found.inline_data?.data ||
    null;

  if (!b64 && found.fileData?.fileUri) {
    return { ok: true, mode: "uri", mime, dataUrl: found.fileData.fileUri, model };
  }
  if (!b64) return { ok: false, error: `${model}: empty_image_data` };

  return { ok: true, mode: "inline", mime, dataUrl: `data:${mime};base64,${b64}`, model };
}

// =======================
// Handler
// =======================
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: HEADERS, body: "" };
  }

  // GET: فحص يدوي + عرض النماذج المتاحة والاختيار الحالي إن أمكن
  if (event.httpMethod === "GET") {
    if (!API_KEY) return ok({ info: "endpoint is alive (no API key set). Use POST.", chosen_model: null, available_models_count: 0, available_models: [] });
    try {
      const models = await listModels();
      let chosen = null;
      try { chosen = await pickImageModelName(); } catch { /* ignore */ }
      return ok({
        info: "generateRecipeImage endpoint is alive. Use POST to generate an image.",
        chosen_model: chosen || null,
        available_models_count: models.length,
        available_models: models.map(m => m?.name || "").slice(0, 200)
      });
    } catch (e) {
      // حتى لو فشل listing، أعد حالة حيّة للمسار
      return ok({ info: "alive, but listing models failed", error: String(e && e.message || e) });
    }
  }

  // POST: التوليد الفعلي (مع fallback دائمًا)
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return placeholderResponse("تم استخدام الصورة البديلة بسبب خطأ في شكل الطلب (JSON)."); }

  const title = String(payload?.title || "").trim();
  const ingredients = Array.isArray(payload?.ingredients) ? payload.ingredients.slice(0, 25) : [];
  const steps = Array.isArray(payload?.steps) ? payload.steps.slice(0, 12) : [];
  const cuisine = String(payload?.cuisine || "").trim();
  const lang = (payload?.lang === "en") ? "en" : "ar";

  const prompt = buildPrompt({ title, ingredients, steps, cuisine, lang });

  // لا يوجد مفتاح؟ أعد placeholder فورًا
  if (!API_KEY) {
    return placeholderResponse("تم استخدام الصورة البديلة: لا يوجد مفتاح API على الخادم.");
  }

  try {
    const r = await callImageModel(prompt);
    if (r && r.ok && r.dataUrl) {
      return ok({
        image: { mime: r.mime || "image/png", mode: r.mode || "inline", data_url: r.dataUrl },
        model: r.model || null,
        note: lang === "ar" ? "تم توليد صورة الطبق بنجاح." : "Dish image generated successfully."
      });
    }
    // فشل أو لم تُرجع صورة
    return placeholderResponse("تم استخدام الصورة البديلة: لم تُرجِع خدمة التوليد صورة للحساب الحالي.");
  } catch (e) {
    // أي استثناء غير متوقّع ➜ placeholder
    return placeholderResponse(`تم استخدام الصورة البديلة: ${String(e && e.message || e)}`);
  }
};
