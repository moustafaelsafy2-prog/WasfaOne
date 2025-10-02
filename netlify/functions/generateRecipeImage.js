// netlify/functions/generateRecipeImage.js
// توليد صورة الطبق النهائي عبر Gemini استنادًا لاسم الوصفة + المكونات + خطوات التحضير.
// إصلاحات:
// 1) استخدام الترويسة x-goog-api-key بدل ?key=...
// 2) دعم كلتا الصيغتين inlineData و inline_data عند قراءة الصورة
// 3) مسار مرِن مع قائمة نماذج وتجربة بدائل تلقائيًا
// 4) رسائل أخطاء أوضح، مع الحفاظ على نفس واجهة الاستجابة للواجهة الأمامية

// =======================
// CORS + Helpers
// =======================
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-auth-token, x-session-nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const ok = (obj) => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, ...obj }) });
const bad = (code, error, extra = {}) => ({ statusCode: code, headers: HEADERS, body: JSON.stringify({ ok: false, error, ...extra }) });

// =======================
// Config
// =======================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// نماذج سنحاولها بالترتيب (الأول المفضل؛ الأخرى بدائل تحسّبًا لتغيير الأسماء/التوافر)
const CANDIDATE_MODELS = [
  "gemini-2.5-flash-image-preview",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-exp" // احتياطي لبعض البيئات
];

// ثبات أعلى كما تشترط المواصفات
const GENERATION_CONFIG = {
  temperature: 0,
  topP: 1,
  maxOutputTokens: 64
};

// =======================
// Prompt Builder
// =======================
function buildPrompt({ title = "", ingredients = [], steps = [], cuisine = "", lang = "ar" }) {
  const titleLine = title ? `اسم الطبق: ${title}` : "اسم الطبق: غير محدد";
  const ingLine = Array.isArray(ingredients) && ingredients.length
    ? `المكوّنات (مختصرة): ${ingredients.join(", ")}`
    : "المكوّنات: —";
  const stepsLine = Array.isArray(steps) && steps.length
    ? `ملخص التحضير: ${steps.join(" ثم ")}`
    : "طريقة التحضير: —";
  const cuiLine = cuisine ? `المطبخ: ${cuisine}` : "المطبخ: متنوع";

  const ar = `
أنت مصور أطعمة محترف. أنشئ صورة طعام فوتوغرافية عالية الجودة تمثل الشكل النهائي للطبق التالي:
${titleLine}
${cuiLine}
${ingLine}
${stepsLine}

[تعليمات النمط]
- زاوية 30–45°، إضاءة طبيعية ناعمة.
- تقديم راقٍ على طبق مناسب، خلفية مطبخية محايدة.
- دون أي نصوص/شعارات/علامات مائية داخل الصورة، ودون أشخاص أو أيدي.
- ألوان واقعية وتفاصيل فاتحة للشهية تُظهر المكونات المذكورة.

أخرج صورة واحدة مناسبة للويب بجودة متوازنة للعرض بجانب العنوان.
`.trim();

  const en = `
You are a professional food photographer. Generate a single, high-quality photorealistic final dish image for:
${title ? `Title: ${title}` : "Title: N/A"}
${cuisine ? `Cuisine: ${cuisine}` : "Cuisine: Mixed"}
Key ingredients: ${(ingredients || []).join(", ") || "—"}
Preparation summary: ${(steps || []).join(" then ") || "—"}

[Style]
- 30–45° camera angle, soft natural light.
- Restaurant-grade plating, neutral kitchen backdrop.
- No text/logos/watermarks and no people/hands.
- Realistic, appetizing colors emphasizing listed ingredients.

Return exactly one web-suitable image.
`.trim();

  return (lang === "ar" ? ar : en);
}

// =======================
// Gemini Call (with model fallback)
// =======================
async function callGeminiImage(prompt) {
  if (!GEMINI_API_KEY) return { ok: false, error: "missing_api_key" };

  let lastErr = null;
  for (const model of CANDIDATE_MODELS) {
    try {
      const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
      const body = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { ...GENERATION_CONFIG },
        safetySettings: []
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 🔧 التصحيح الأساسي: استخدام ترويسة المصادقة بدل querystring
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(body)
      });

      const raw = await resp.text();
      let data = null;
      try { data = JSON.parse(raw); } catch { /* ignore */ }

      if (!resp.ok) {
        const msg = data?.error?.message || `HTTP_${resp.status}`;
        lastErr = msg;
        continue; // جرّب الموديل التالي
      }

      // ابحث عن أول صورة بأي من الصيغتين inlineData / inline_data
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const found = parts.find(p =>
        (p && p.inlineData && /^image\//i.test(p.inlineData?.mimeType || "")) ||
        (p && p.inline_data && /^image\//i.test(p.inline_data?.mime_type || ""))
      );

      if (!found) {
        lastErr = "no_image_returned";
        continue;
      }

      // قراءة البيانات وفق الصيغة المتاحة
      const mime = found.inlineData?.mimeType || found.inline_data?.mime_type || "image/png";
      const b64  = found.inlineData?.data      || found.inline_data?.data;
      if (!b64) { lastErr = "empty_image_data"; continue; }

      const dataUrl = `data:${mime};base64,${b64}`;
      return { ok: true, dataUrl, mime, model, mode: "inline" };
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      // تابع للموديل التالي
    }
  }
  return { ok: false, error: lastErr || "image_generation_failed" };
}

// =======================
// Handler
// =======================
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "invalid_json_body"); }

  // مدخلات من الواجهة
  const title = String(payload?.title || "").trim();
  const ingredients = Array.isArray(payload?.ingredients) ? payload.ingredients.slice(0, 25) : [];
  const steps = Array.isArray(payload?.steps) ? payload.steps.slice(0, 12) : [];
  const cuisine = String(payload?.cuisine || "").trim();
  const lang = (payload?.lang === "en") ? "en" : "ar";

  const prompt = buildPrompt({ title, ingredients, steps, cuisine, lang });

  const r = await callGeminiImage(prompt);
  if (!r.ok) {
    // نعيد الخطأ بشكل واضح للواجهة (لكن الواجهة الحالية تتجاهل الفشل ولا تكسر العرض)
    return bad(502, r.error || "image_generation_failed", { note: "gemini_image_call_failed" });
  }

  return ok({
    image: {
      mime: r.mime || "image/png",
      mode: r.mode || "inline",
      data_url: r.dataUrl
    },
    model: r.model || CANDIDATE_MODELS[0],
    note: lang === "ar"
      ? "تم توليد صورة الطبق بنجاح عبر Gemini."
      : "Dish image generated successfully via Gemini."
  });
};
