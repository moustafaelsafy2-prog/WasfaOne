// netlify/functions/generateRecipeImage.js
// توليد صورة الطبق النهائي عبر Google Generative Language API.
// ✅ يعتمد أولاً على models.list لاكتشاف النماذج المتاحة في حسابك ثم يختار نموذج صور يدعم generateContent.
// ✅ إن لم يوجد أي نموذج صور متاح، نعيد خطأ واضح للواجهة (والواجهة ستظهر تنبيهًا كما أضفتَ سابقًا).
// ✅ يحافظ على GET للفحص اليدوي، وPOST للتوليد الفعلي، وواجهة استجابة ثابتة: { ok, image: { data_url, ... } }

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
const API_KEY = process.env.GEMINI_API_KEY || ""; // مفتاح Google AI Studio / Generative Language API
const BASE    = "https://generativelanguage.googleapis.com/v1beta";

// ثبات أعلى
const GENERATION_CONFIG = { temperature: 0, topP: 1, maxOutputTokens: 64 };

// ذاكرة مؤقتة ضمن عمر الدالة (قد تُفرّغ عند الـ cold start)
let cachedModelName = null;
let cachedModels = null;

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

// يجلب قائمة النماذج المتاحة لحسابك ويخزنها مؤقتًا
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

// يختار أول نموذج صور يدعم generateContent وفق المتاح في حسابك
async function pickImageModelName() {
  if (cachedModelName) return cachedModelName;

  const models = await listModels();

  // 1) أفضلية لأي نموذج يحتوي "imagen" في الاسم ويدعم generateContent
  const imagen = models.find(m =>
    /(^|\/)models\/.*imagen/i.test(m?.name || "") &&
    (Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods.includes("generateContent") : true)
  );
  if (imagen?.name) { cachedModelName = imagen.name.replace(/^models\//, ""); return cachedModelName; }

  // 2) نماذج تحتوي "image" في الاسم (إن وُجدت) وتدعم generateContent
  const imageLike = models.find(m =>
    /(^|\/)models\/.*image/i.test(m?.name || "") &&
    (Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods.includes("generateContent") : true)
  );
  if (imageLike?.name) { cachedModelName = imageLike.name.replace(/^models\//, ""); return cachedModelName; }

  // 3) لا يوجد نموذج صور متاح
  throw new Error("no_image_model_available_for_account");
}

// =======================
// Image Generation via generateContent
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

  // inline base64
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

  // GET: فحص يدوي + إظهار النماذج المتاحة والاختيار الحالي إن أمكن
  if (event.httpMethod === "GET") {
    if (!API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");
    try {
      const models = await listModels();
      let chosen = null;
      try { chosen = await pickImageModelName(); } catch { /* ignore */ }
      return ok({
        info: "generateRecipeImage endpoint is alive. Use POST to generate an image.",
        chosen_model: chosen || null,
        available_models_count: models.length,
        // نعرض فقط الأسماء لتسهيل التشخيص
        available_models: models.map(m => m?.name || "").slice(0, 150)
      });
    } catch (e) {
      return bad(502, String(e && e.message || e) || "list_models_failed");
    }
  }

  // POST: التوليد الفعلي
  if (event.httpMethod !== "POST") {
    return bad(405, "Method Not Allowed");
  }
  if (!API_KEY) {
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

  try {
    const r = await callImageModel(prompt);
    if (!r.ok) return bad(502, r.error || "image_generation_failed", { note: "image_model_call_failed" });

    return ok({
      image: { mime: r.mime || "image/png", mode: r.mode || "inline", data_url: r.dataUrl },
      model: r.model || null,
      note: lang === "ar" ? "تم توليد صورة الطبق بنجاح." : "Dish image generated successfully."
    });
  } catch (e) {
    // في حال لا يوجد نموذج صور متاح للحساب
    const msg = String(e && e.message || e);
    if (msg === "no_image_model_available_for_account") {
      return bad(501, "no_image_model_available_for_account", {
        hint: "فعّل نموذج صور في حساب Google (Imagen/Gemini image) أو اربط مفتاحًا لديه صلاحية الصور.",
        models_hint_endpoint: `${BASE}/models`
      });
    }
    return bad(500, msg || "unexpected_error");
  }
};
