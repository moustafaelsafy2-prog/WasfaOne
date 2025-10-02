// netlify/functions/generateRecipeImage.js
// توليد صورة الطبق عبر Gemini استنادًا للاسم + المكونات + الخطوات.
// إضافة: دعم GET للفحص اليدوي (يرجع معلومات فقط) — POST هو المطلوب للتوليد الفعلي.

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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const CANDIDATE_MODELS = [
  "gemini-2.5-flash-image-preview",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-exp"
];

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
- بلا نصوص/شعارات/علامات مائية، وبلا أشخاص/أيدي.
- ألوان واقعية تُبرز المكوّنات المذكورة.

أخرج صورة واحدة مناسبة للويب للعرض بجانب العنوان.
`.trim();

  const en = `
You are a professional food photographer. Generate a single, photorealistic final dish image for:
Title: ${title || "N/A"}
Cuisine: ${cuisine || "Mixed"}
Key ingredients: ${(ingredients || []).join(", ") || "—"}
Preparation summary: ${(steps || []).join(" then ") || "—"}

[Style]
- 30–45° angle, soft natural light.
- Elegant plating, neutral kitchen backdrop.
- No text/logos/watermarks; no people/hands.
- Realistic, appetizing colors emphasizing the listed ingredients.

Return exactly one web-suitable image.
`.trim();

  return (lang === "ar" ? ar : en);
}

// =======================
// Gemini Call (with fallback)
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
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify(body)
      });

      const raw = await resp.text();
      let data = null;
      try { data = JSON.parse(raw); } catch { /* ignore parse error */ }

      if (!resp.ok) {
        const msg = data?.error?.message || `HTTP_${resp.status}`;
        lastErr = msg;
        continue;
      }

      const parts = data?.candidates?.[0]?.content?.parts || [];
      const found = parts.find(p =>
        (p && p.inlineData && /^image\//i.test(p.inlineData?.mimeType || "")) ||
        (p && p.inline_data && /^image\//i.test(p.inline_data?.mime_type || ""))
      );
      if (!found) { lastErr = "no_image_returned"; continue; }

      const mime = found.inlineData?.mimeType || found.inline_data?.mime_type || "image/png";
      const b64  = found.inlineData?.data      || found.inline_data?.data;
      if (!b64) { lastErr = "empty_image_data"; continue; }

      const dataUrl = `data:${mime};base64,${b64}`;
      return { ok: true, dataUrl, mime, model, mode: "inline" };
    } catch (e) {
      lastErr = (e && e.message) || String(e);
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

  // NEW: allow GET for quick manual check
  if (event.httpMethod === "GET") {
    return ok({
      info: "generateRecipeImage endpoint is alive. Use POST to generate an image.",
      sample_payload: {
        title: "سلطة تبولة",
        ingredients: ["برغل","بقدونس","طماطم","زيت زيتون"],
        steps: ["تقطيع","خلط","تتبيل"],
        cuisine: "شرق أوسطي",
        lang: "ar"
      }
    });
  }

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

  const r = await callGeminiImage(prompt);
  if (!r.ok) {
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
