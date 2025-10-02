// netlify/functions/generateRecipeImage.js
// توليد صورة طبق نهائية بالذكاء الاصطناعي (Gemini) بالاعتماد على عنوان الوصفة + المكونات + طريقة التحضير.
// لا يغيّر أي API موجود، ووظيفته مستقلة لاستدعائها من الواجهة.
// يعتمد على مفتاح GEMINI_API_KEY من متغيرات بيئة Netlify.

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
// نموذج توليد الصور (Preview عام عبر Gemini API)
// يمكن تغييره لاحقًا لـ "gemini-2.5-flash-image" عند توافره بشكل عام.
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image-preview";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ملاحظة: نستخدم temperature=0 لضمان ثبات أعلى (عدم عشوائية) كما يُطلب بالمشروع.
const GENERATION_CONFIG = {
  temperature: 0,
  topP: 1,
  maxOutputTokens: 64,
  // نماذج توليد الصور تلزم إرجاع نص + صورة معًا (حسب الوثائق الحديثة):
  // لذا نطلب كلا الموداليتين، رغم أننا سنقرأ الصورة فقط.
  responseModalities: ["TEXT", "IMAGE"]
};

// =======================
// Prompt Builder (AR first; EN fallback)
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

  // توجيه أسلوبي واضح لإخراج صورة طبق نهائية عالية الدقة مع زوايا تصوير مناسبة للعرض بجوار الاسم.
  const ar = `
أنت مصمم أغذية محترف. أنشئ صورة طعام فوتوغرافية عالية الجودة تمثل الشكل النهائي للطبق التالي:
${titleLine}
${cuiLine}
${ingLine}
${stepsLine}

[تعليمات النمط]
- زاوية تصوير: بزاوية 30–45 درجة مع إضاءة طبيعية ناعمة.
- تقديم راقٍ على طبق مناسب، خلفية محايدة مطبخية، دون نصوص أو شعارات أو علامات مائية إضافية.
- ألوان واقعية، تفاصيل فاتحة للشهية، تركيز على المكوّنات الرئيسية المذكورة.
- تجنّب وجود أشخاص/أيدي في الصورة. لا تضع أي كتابة داخل الصورة.

أعد الناتج كصورة واحدة فقط تمثل الطبق النهائي بدقة مناسبة للويب.
`.trim();

  const en = `
You are a professional food photographer. Generate a high-quality, photorealistic final dish image for:
Title: ${title || "N/A"}
Cuisine: ${cuisine || "Mixed"}
Key ingredients: ${(ingredients || []).join(", ") || "—"}
Preparation summary: ${(steps || []).join(" then ") || "—"}

[Style]
- Camera angle 30–45°, soft natural light.
- Restaurant-grade plating on a clean plate, neutral kitchen backdrop.
- No text, logos, or watermarks; no people/hands.
- Emphasize the listed ingredients realistically; appetizing colors.

Return exactly one final dish image suitable for web display.
`.trim();

  return (lang === "ar" ? ar : en);
}

// =======================
// Image Call
// =======================
// نطلب generateContent من نموذج الصور، ونتوقع part يحتوي inlineData (image/png أو image/jpeg) Base64.
async function callGeminiImage(prompt, size = { width: 768, height: 512 }) {
  const url = `${GEMINI_BASE}/${encodeURIComponent(GEMINI_IMAGE_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  // بعض النماذج تدعم "imageGenerationConfig" لتحديد الحجم؛ نمرّرها إذا كانت مدعومة.
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      ...GENERATION_CONFIG,
      // محاولات لضبط الإخراج لحجم مناسب للعرض بجانب العنوان:
      // ليست كل النماذج تدعم جميع الحقول التالية؛ إذا تم تجاهلها من المزود فلن تتسبب في خطأ.
      // عند دعم imagesConfig أو similar سنمرر target dimensions.
      // (نبقيه دفاعيًا ومتوافقًا مع تغييرات واجهة Gemini الحديثة).
      // ملاحظة: لا نعتمد على image-only؛ المودال يعيد نصًا موجزًا مع الصورة.
      // responseMimeType: "application/json"
    },
    safetySettings: []
  };

  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON or error body */ }

  if (!resp.ok) {
    const msg = data?.error?.message || `HTTP_${resp.status}`;
    return { ok: false, error: msg };
  }

  // استخرج أول صورة inlineData من الأجزاء
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p?.inlineData && /^image\//i.test(p.inlineData?.mimeType || ""));
  if (!imgPart?.inlineData?.data || !imgPart?.inlineData?.mimeType) {
    // بعض الإصدارات تعيد الصور ضمن "files" أو "media"؛ نحاول مسارات بديلة بشكل دفاعي.
    const alt = parts.find(p => p?.fileData && /^image\//i.test(p.fileData?.mimeType || ""));
    if (alt?.fileData?.fileUri && alt?.fileData?.mimeType) {
      return { ok: true, dataUrl: alt.fileData.fileUri, mime: alt.fileData.mimeType, mode: "uri" };
    }
    return { ok: false, error: "no_image_returned" };
  }

  const mime = imgPart.inlineData.mimeType || "image/png";
  const b64 = imgPart.inlineData.data;
  const dataUrl = `data:${mime};base64,${b64}`;
  return { ok: true, dataUrl, mime, mode: "inline" };
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

  // مدخلات مطلوبة من الواجهة:
  // title (string), ingredients (string[]), steps (string[]), cuisine (string), lang ("ar"|"en")
  const title = String(payload?.title || "").trim();
  const ingredients = Array.isArray(payload?.ingredients) ? payload.ingredients.slice(0, 25) : [];
  const steps = Array.isArray(payload?.steps) ? payload.steps.slice(0, 12) : [];
  const cuisine = String(payload?.cuisine || "").trim();
  const lang = (payload?.lang === "en") ? "en" : "ar";

  // نبني Prompt
  const prompt = buildPrompt({ title, ingredients, steps, cuisine, lang });

  try {
    const r = await callGeminiImage(prompt);
    if (!r.ok) return bad(502, r.error || "image_generation_failed");

    // نعيد Data URL لسهولة العرض مباشرة في <img src="...">
    return ok({
      image: {
        mime: r.mime || "image/png",
        mode: r.mode || "inline",
        data_url: r.dataUrl
      },
      // ملاحظة: لا نخزن الصورة الآن؛ الواجهة قد تخزنها في حالة المستخدم إن لزم.
      // اتساق: ثبات أعلى بالـ temperature=0.
      note: lang === "ar"
        ? "تم توليد صورة الطبق بنجاح عبر Gemini."
        : "Dish image generated successfully via Gemini."
    });
  } catch (e) {
    return bad(500, String(e && e.message || e) || "unexpected_error");
  }
};
