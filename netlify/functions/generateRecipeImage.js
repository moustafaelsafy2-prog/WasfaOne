// netlify/functions/generateRecipeImage.js
// توليد صورة الطبق النهائي عبر Google Generative Language API باستخدام نماذج Imagen المدعومة.
// ✅ محوّل لاستخدام "imagen-3.0-generate-1" (أو النسخة السريعة إن توفرت) بدلاً من نماذج gemini-*-image غير المدعومة.
// ✅ لا تغيير في واجهة الاستجابة: نعيد image.data_url يمكن وضعها مباشرة في <img src="...">
// ✅ يحافظ على ثبات أعلى (temperature=0) ويشمل مسار GET للفحص اليدوي، وPOST للتوليد الفعلي.

// =======================
// CORS + Helpers
// =======================
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-auth-token, x-session-nonce",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
const ok = (obj) => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, ...obj }) });
const bad = (code, error, extra = {}) => ({ statusCode: code, headers: HEADERS, body: JSON.stringify({ ok: false, error, ...extra }) });

// =======================
// Config
// =======================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; // مفتاح Google AI Studio / Generative Language API
const GL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ⬇️ قائمة النماذج المدعومة لتوليد الصور عبر واجهة generateContent (حدّثها حسب المتاح في حسابك)
const CANDIDATE_MODELS = [
  "imagen-3.0-generate-1",       // الأساسي
  "imagen-3.0-fast-generate-1"   // نسخة أسرع (إن كانت متاحة)
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
// Imagen Call (with fallback)
// =======================
async function callImagen(prompt) {
  if (!GEMINI_API_KEY) return { ok: false, error: "missing_api_key" };

  let lastErr = null;
  for (const model of CANDIDATE_MODELS) {
    try {
      const url = `${GL_BASE}/${encodeURIComponent(model)}:generateContent`;
      const body = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { ...GENERATION_CONFIG },
        safetySettings: []
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // ✅ المصادقة الصحيحة
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(body)
      });

      const raw = await resp.text();
      let data = null;
      try { data = JSON.parse(raw); } catch { /* ignore parse error */ }

      if (!resp.ok) {
        const msg = data?.error?.message || `HTTP_${resp.status}`;
        lastErr = `${model}: ${msg}`;
        continue;
      }

      // ابحث عن أول صورة بأي من الصيغتين inlineData / inline_data
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const found = parts.find(p =>
        (p && p.inlineData && /^image\//i.test(p.inlineData?.mimeType || "")) ||
        (p && p.inline_data && /^image\//i.test(p.inline_data?.mime_type || "")) ||
        (p && p.fileData && /^image\//i.test(p.fileData?.mimeType || ""))
      );
      if (!found) { lastErr = `${model}: no_image_returned`; continue; }

      const mime =
        found.inlineData?.mimeType ||
        found.inline_data?.mime_type ||
        found.fileData?.mimeType ||
        "image/png";

      const b64 =
        found.inlineData?.data ||
        found.inline_data?.data ||
        null;

      // بعض الإصدارات قد تعيد fileUri بدلاً من inlineData
      if (!b64 && found.fileData?.fileUri) {
        return { ok: true, dataUrl: found.fileData.fileUri, mime, model, mode: "uri" };
      }

      if (!b64) { lastErr = `${model}: empty_image_data`; continue; }

      const dataUrl = `data:${mime};base64,${b64}`;
      return { ok: true, dataUrl, mime, model, mode: "inline" };
    } catch (e) {
      lastErr = `${model}: ${(e && e.message) || String(e)}`;
    }
  }
  return { ok: false, error: lastErr || "image_generation_failed" };
}

// =======================
// Handler
// =======================
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: HEADERS, body: "" };
  }

  // GET: فحص سريع يدوي (لا يولّد صورة)
  if (event.httpMethod === "GET") {
    return ok({
      info: "generateRecipeImage endpoint is alive. Use POST to generate an image.",
      sample_payload: {
        title: "سلطة تبولة",
        ingredients: ["برغل","بقدونس","طماطم","زيت زيتون"],
        steps: ["تقطيع","خلط","تتبيل"],
        cuisine: "شرق أوسطي",
        lang: "ar"
      },
      models: CANDIDATE_MODELS
    });
  }

  // POST: التوليد الفعلي
  if (event.httpMethod !== "POST") {
    return bad(405, "Method Not Allowed");
  }

  if (!GEMINI_API_KEY) {
    return bad(500, "GEMINI_API_KEY is missing on the server");
  }

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "invalid_json_body"); }

  const title = String(payload?.title || "").trim();
  const ingredients = Array.isArray(payload?.ingredients) ? payload.ingredients.slice(0, 25) : [];
  const steps = Array.isArray(payload?.steps) ? payload.steps.slice(0, 12) : [];
  const cuisine = String(payload?.cuisine || "").trim();
  const lang = (payload?.lang === "en") ? "en" : "ar";

  const prompt = buildPrompt({ title, ingredients, steps, cuisine, lang });

  const r = await callImagen(prompt);
  if (!r.ok) {
    // الواجهة ستعرض التوست/البانر بالفعل عند الفشل
    return bad(502, r.error || "image_generation_failed", { note: "imagen_call_failed" });
  }

  return ok({
    image: {
      mime: r.mime || "image/png",
      mode: r.mode || "inline",
      data_url: r.dataUrl
    },
    model: r.model || CANDIDATE_MODELS[0],
    note: lang === "ar"
      ? "تم توليد صورة الطبق بنجاح عبر Imagen."
      : "Dish image generated successfully via Imagen."
  });
};
