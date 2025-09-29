// Netlify Function: generateRecipe (No fallbacks, strict errors)
// Executes Gemini call and returns a STRICT recipe schema or explicit error.
// Author: Fix build/runtime issues and remove any dummy/fallback responses.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL_NAME = "gemini-1.5-flash"; // ثابت ومتاح للإنتاج
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

// ---------- Helpers ----------
function bad(status, message, extra = {}) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: false, error: message, ...extra }),
  };
}
function ok(payload) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, ...payload }),
  };
}

// Strict schema validator
function validateRecipeSchema(rec) {
  const must = ["title", "servings", "total_time_min", "macros", "ingredients", "steps", "lang"];
  if (!rec || typeof rec !== "object") return { ok: false, error: "recipe_not_object" };
  for (const k of must) if (!(k in rec)) return { ok: false, error: `missing_${k}` };

  if (typeof rec.title !== "string" || !rec.title.trim()) return { ok: false, error: "title_type" };
  if (typeof rec.servings !== "number" || !Number.isFinite(rec.servings)) return { ok: false, error: "servings_type" };
  if (typeof rec.total_time_min !== "number" || !Number.isFinite(rec.total_time_min)) return { ok: false, error: "total_time_min_type" };

  const m = rec.macros;
  if (!m || typeof m !== "object") return { ok: false, error: "macros_type" };
  for (const key of ["protein_g", "carbs_g", "fat_g", "calories"]) {
    if (typeof m[key] !== "number" || !Number.isFinite(m[key])) return { ok: false, error: `macro_${key}_type` };
  }

  if (!Array.isArray(rec.ingredients) || rec.ingredients.some(x => typeof x !== "string")) {
    return { ok: false, error: "ingredients_type" };
  }
  if (!Array.isArray(rec.steps) || rec.steps.some(x => typeof x !== "string")) {
    return { ok: false, error: "steps_type" };
  }
  if (rec.lang !== "ar") return { ok: false, error: "lang_must_be_ar" };

  return { ok: true };
}

// Extract JSON from Gemini text (handles ```json fences)
function extractJson(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- Prompt builders ----------
function systemInstruction() {
  return `
أنت شيف محترف. أعد وصفة عربية مختصرة ودقيقة فقط كـ JSON وفق المخطط أدناه دون أي نص إضافي.

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
- المكونات: عناصر نصية قصيرة (كمية + مكوّن).
- الخطوات: جمل تنفيذية قصيرة.
- لا تُرجِع أي شرح خارج JSON.
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

  const avoid = allergies && allergies.length ? allergies.join(", ") : "لا شيء";
  const focusLine = focus ? `تركيز خاص: ${focus}.` : "";

  return `
أنشئ وصفة ${mealType} من مطبخ ${cuisine} لنظام ${dietType}.
الهدف التقريبي للسعرات لكل حصة: ${caloriesTarget}.
حساسيات يجب تجنبها: ${avoid}.
${focusLine}
أعد النتيجة بالضبط كـ JSON حسب المخطط المطلوب وباللغة العربية فقط.
`.trim();
}

// ---------- Gemini call ----------
async function callGemini(input) {
  const requestBody = {
    // Use systemInstruction per Gemini API
    systemInstruction: { role: "system", parts: [{ text: systemInstruction() }] },
    contents: [{ role: "user", parts: [{ text: userPrompt(input) }] }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 800,
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

  const url = `${API_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  let jr;
  try { jr = await r.json(); } catch { return bad(502, "invalid_response_from_gemini"); }

  if (!r.ok) {
    const msg = jr?.error?.message || `gemini_http_${r.status}`;
    return bad(502, msg);
  }

  const text = jr?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  const json = extractJson(text);
  if (!json) return bad(422, "gemini_returned_non_json");

  const v = validateRecipeSchema(json);
  if (!v.ok) return bad(422, `schema_validation_failed:${v.error}`);

  return ok({ recipe: json });
}

// ---------- Netlify handler ----------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  let input = {};
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "invalid_json_body");
  }

  try {
    const res = await callGemini(input);
    return res;
  } catch (e) {
    return bad(500, "internal_error", { detail: e.message || String(e) });
  }
};
