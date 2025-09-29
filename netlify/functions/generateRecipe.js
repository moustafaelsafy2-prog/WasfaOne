// Netlify Function: generateRecipe (no fallbacks, version-smart, strict schema)

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// نحاول مسارين متوافقين: v1 أولاً ثم v1beta-latest
const MODEL_PRIMARY = "gemini-1.5-flash";
const MODEL_FALLBACK = "gemini-1.5-flash-latest";
const ENDPOINTS = [
  `https://generativelanguage.googleapis.com/v1/models/${MODEL_PRIMARY}:generateContent`,
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_FALLBACK}:generateContent`,
];

// ---------- Utilities ----------
const jsonRes = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok = (payload) => jsonRes(200, { ok: true, ...payload });

// ---------- Schema validation ----------
function validateRecipeSchema(rec) {
  const must = ["title", "servings", "total_time_min", "macros", "ingredients", "steps", "lang"];
  if (!rec || typeof rec !== "object") return { ok: false, error: "recipe_not_object" };
  for (const k of must) if (!(k in rec)) return { ok: false, error: `missing_${k}` };

  if (typeof rec.title !== "string" || !rec.title.trim()) return { ok: false, error: "title_type" };
  if (!Number.isFinite(rec.servings)) return { ok: false, error: "servings_type" };
  if (!Number.isFinite(rec.total_time_min)) return { ok: false, error: "total_time_min_type" };

  const m = rec.macros;
  if (!m || typeof m !== "object") return { ok: false, error: "macros_type" };
  for (const key of ["protein_g", "carbs_g", "fat_g", "calories"]) {
    if (!Number.isFinite(m[key])) return { ok: false, error: `macro_${key}_type` };
  }
  if (!Array.isArray(rec.ingredients) || rec.ingredients.some((x) => typeof x !== "string"))
    return { ok: false, error: "ingredients_type" };
  if (!Array.isArray(rec.steps) || rec.steps.some((x) => typeof x !== "string"))
    return { ok: false, error: "steps_type" };
  if (rec.lang !== "ar") return { ok: false, error: "lang_must_be_ar" };

  return { ok: true };
}

// ---------- Prompt builders ----------
function systemInstruction() {
  return `
أنت شيف محترف. أعد الناتج كـ JSON فقط وفق المخطط التالي، دون أي نص خارجه:
{
  "title": string,
  "servings": number,
  "total_time_min": number,
  "macros": { "protein_g": number, "carbs_g": number, "fat_g": number, "calories": number },
  "ingredients": string[],
  "steps": string[],
  "lang": "ar"
}
- أرقام صافية في الماكروز (بدون وحدات).
- ingredients عناصر قصيرة (كمية + مكوّن).
- steps جمل تنفيذية قصيرة.
- اللغة: العربية فقط.
`.trim();
}

function userPrompt(input) {
  const {
    mealType = "وجبة",
    cuisine = "متنوع",
    dietType = "متوازن",
    caloriesTarget = 500,
    allergies = [],
    focus = "",
  } = input;

  const avoid = allergies?.length ? allergies.join(", ") : "لا شيء";
  const focusLine = focus ? `تركيز خاص: ${focus}.` : "";

  return `
أنشئ وصفة ${mealType} من مطبخ ${cuisine} لنظام ${dietType}.
الهدف التقريبي للسعرات لكل حصة: ${caloriesTarget}.
حساسيات يجب تجنبها: ${avoid}.
${focusLine}
أعد النتيجة JSON فقط حسب المخطط المطلوب وبالعربية.
`.trim();
}

// ---------- Response parsing ----------
function extractJsonFromCandidates(jr) {
  // يدعم v1 و v1beta: parts[].text قد تحتوي JSON مباشرة أو داخل أسوار ```json
  const text =
    jr?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    jr?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "";

  if (!text) return null;

  let s = text.trim();
  // إزالة أسوار ```json إن وُجدت
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1) return null;

  const slice = s.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

// ---------- Core call ----------
async function callGeminiWith(url, input) {
  // نبني جسم طلب متوافق مع v1 و v1beta
  const body = {
    // v1 يدعم systemInstruction، v1beta سيتجاهله بأمان
    systemInstruction: { role: "system", parts: [{ text: systemInstruction() }] },
    contents: [{ role: "user", parts: [{ text: userPrompt(input) }] }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 800,
      // v1 سيدعم responseMimeType/Schema؛ v1beta سيتجاهله دون كسر
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          servings: { type: "NUMBER" },
          total_time_min: { type: "NUMBER" },
          macros: {
            type: "OBJECT",
            properties: {
              protein_g: { type: "NUMBER" },
              carbs_g: { type: "NUMBER" },
              fat_g: { type: "NUMBER" },
              calories: { type: "NUMBER" },
            },
            required: ["protein_g", "carbs_g", "fat_g", "calories"],
          },
          ingredients: { type: "ARRAY", items: { type: "STRING" } },
          steps: { type: "ARRAY", items: { type: "STRING" } },
          lang: { type: "STRING" },
        },
        required: ["title", "servings", "total_time_min", "macros", "ingredients", "steps", "lang"],
      },
    },
    safetySettings: [],
  };

  const r = await fetch(`${url}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let jr;
  try {
    jr = await r.json();
  } catch {
    return { ok: false, code: 502, error: "invalid_json_from_gemini" };
  }

  if (!r.ok) {
    const msg = jr?.error?.message || `gemini_http_${r.status}`;
    return { ok: false, code: 502, error: msg };
  }

  const json = extractJsonFromCandidates(jr);
  if (!json) return { ok: false, code: 422, error: "gemini_returned_non_json" };

  const v = validateRecipeSchema(json);
  if (!v.ok) return { ok: false, code: 422, error: `schema_validation_failed:${v.error}` };

  return { ok: true, recipe: json };
}

// ---------- Handler ----------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  let input = {};
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "invalid_json_body");
  }

  // نجرب v1 ثم v1beta-latest
  let lastErr = null;
  for (const url of ENDPOINTS) {
    try {
      const res = await callGeminiWith(url, input);
      if (res.ok) return ok({ recipe: res.recipe });
      lastErr = res;
    } catch (e) {
      lastErr = { ok: false, code: 500, error: e.message || "internal_error" };
    }
  }

  return bad(lastErr?.code || 500, lastErr?.error || "unknown_error", { tried: ENDPOINTS });
};
