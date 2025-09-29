// netlify/functions/generateRecipe.js
// UAE-ready — Tries a broad pool of Gemini models on v1beta, no fallbacks, strict JSON schema.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// الأسماء مرتبة من الأدق للأوسع دعماً (بناءً على تجربتك في الإمارات)
const MODEL_POOL = [
  // Pro-first
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro",
  "gemini-1.5-pro-001",
  "gemini-pro",
  "gemini-1.0-pro",
  // Flash
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-1.5-flash",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash-latest"
];

// ------------ Utilities ------------
const jsonRes = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj)
});
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

function validateRecipeSchema(rec) {
  const must = ["title","servings","total_time_min","macros","ingredients","steps","lang"];
  if (!rec || typeof rec !== "object") return { ok:false, error:"recipe_not_object" };
  for (const k of must) if (!(k in rec)) return { ok:false, error:`missing_${k}` };

  if (typeof rec.title !== "string" || !rec.title.trim()) return { ok:false, error:"title_type" };
  if (!Number.isFinite(rec.servings)) return { ok:false, error:"servings_type" };
  if (!Number.isFinite(rec.total_time_min)) return { ok:false, error:"total_time_min_type" };

  const m = rec.macros;
  if (!m || typeof m !== "object") return { ok:false, error:"macros_type" };
  for (const key of ["protein_g","carbs_g","fat_g","calories"]) {
    if (!Number.isFinite(m[key])) return { ok:false, error:`macro_${key}_type` };
  }
  if (!Array.isArray(rec.ingredients) || rec.ingredients.some(x => typeof x !== "string")) {
    return { ok:false, error:"ingredients_type" };
  }
  if (!Array.isArray(rec.steps) || rec.steps.some(x => typeof x !== "string")) {
    return { ok:false, error:"steps_type" };
  }
  if (rec.lang !== "ar") return { ok:false, error:"lang_must_be_ar" };

  return { ok:true };
}

function systemInstruction() {
  return `
أنت شيف محترف. أعد **JSON فقط** حسب هذا المخطط، بدون أي نص خارجه:
{
  "title": string,
  "servings": number,
  "total_time_min": number,
  "macros": { "protein_g": number, "carbs_g": number, "fat_g": number, "calories": number },
  "ingredients": string[],
  "steps": string[],
  "lang": "ar"
}
- أرقام الماكروز بدون وحدات.
- ingredients عناصر قصيرة (كمية + مكوّن).
- steps خطوات تنفيذية قصيرة وواضحة.
- اللغة عربية فقط.
`.trim();
}

function userPrompt(input) {
  const {
    mealType = "وجبة",
    cuisine = "متنوع",
    dietType = "متوازن",
    caloriesTarget = 500,
    allergies = [],
    focus = ""
  } = input || {};
  const avoid = (Array.isArray(allergies) && allergies.length) ? allergies.join(", ") : "لا شيء";
  const focusLine = focus ? `تركيز خاص: ${focus}.` : "";
  return `
أنشئ وصفة ${mealType} من مطبخ ${cuisine} لنظام ${dietType}.
السعرات المستهدفة للحصة: ${caloriesTarget}.
حساسيات يجب تجنبها: ${avoid}.
${focusLine}
أعد النتيجة كـ JSON فقط حسب المخطط المطلوب وبالعربية.
`.trim();
}

function extractJsonFromCandidates(jr) {
  const text =
    jr?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("") ||
    jr?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) return null;

  let s = String(text).trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const first = s.indexOf("{");
  const last  = s.lastIndexOf("}");
  if (first === -1 || last === -1) return null;

  try { return JSON.parse(s.slice(first, last + 1)); }
  catch { return null; }
}

async function callOnce(model, input, timeoutMs = 28000) {
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    // v1beta يتجاهل responseSchema/MIME لو غير مدعومة – لا تضر
    systemInstruction: { role: "system", parts: [{ text: systemInstruction() }] },
    contents: [{ role: "user", parts: [{ text: userPrompt(input) }] }],
    generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: 800 },
    safetySettings: []
  };

  const abort = new AbortController();
  const t = setTimeout(() => abort.abort(), Math.max(1000, Math.min(29000, timeoutMs)));

  let resp, data;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal
    });
    const text = await resp.text();
    try { data = JSON.parse(text); } catch { data = null; }

    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP_${resp.status}`;
      return { ok:false, error: msg };
    }

    const json = extractJsonFromCandidates(data);
    if (!json) return { ok:false, error:"gemini_returned_non_json" };

    const v = validateRecipeSchema(json);
    if (!v.ok) return { ok:false, error:`schema_validation_failed:${v.error}` };

    return { ok:true, recipe: json };
  } catch (e) {
    return { ok:false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ------------ Handler ------------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  let input = {};
  try { input = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "invalid_json_body"); }

  const errors = {};
  for (const model of MODEL_POOL) {
    const res = await callOnce(model, input);
    if (res.ok) return ok({ recipe: res.recipe, model });
    errors[model] = res.error;
  }

  // لا وصفات افتراضية — تقرير أخطاء واضح بكل موديل تمت تجربته
  return bad(502, "All models failed for your key/region on v1beta", { errors, tried: MODEL_POOL });
};
