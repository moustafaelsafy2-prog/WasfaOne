// netlify/functions/generateRecipe.js
// UAE-ready for app.html — broad v1beta model pool, Arabic JSON schema,
// soft-enforced Dr. Mohamed Saeed rules: try repair once; if still violated, return with warning (no hard fail).

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Same pool/order that worked for you
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

/* ---------------- HTTP helpers ---------------- */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

/* ---------------- Schema ---------------- */
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

/* ---------------- Prompting ---------------- */
function systemInstruction(maxSteps = 6) {
  return `
أنت شيف محترف. أعد **JSON فقط** حسب هذا المخطط، بدون أي نص خارجه:
{
  "title": string,
  "servings": number,
  "total_time_min": number,
  "macros": { "protein_g": number, "carbs_g": number, "fat_g": number, "calories": number },
  "ingredients": string[],
  "steps": string[],  // ${maxSteps} خطوات كحد أقصى، قصيرة ومباشرة
  "lang": "ar"
}
- أرقام الماكروز بدون وحدات.
- ingredients عناصر قصيرة (كمية + مكوّن) مثل "200 جم صدر دجاج".
- steps خطوات تنفيذية قصيرة وواضحة.
- اللغة عربية فقط، ولا تضف أي شيء خارج JSON.
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
    __repair = false
  } = input || {};

  const avoid = (Array.isArray(allergies) && allergies.length) ? allergies.join(", ") : "لا شيء";
  const focusLine = focus ? `تركيز خاص: ${focus}.` : "";
  const isDrMoh = /محمد\s*سعيد/.test(String(dietType));

  const drRules = isDrMoh ? `
قواعد صارمة لنظام د. محمد سعيد:
- الكربوهيدرات الصافية لكل حصة ≤ 5 جم.
- ممنوع السكريات والمُحلّيات (سكر أبيض/بني، عسل، شراب الذرة/الجلوكوز/الفركتوز، المحليات الصناعية).
- ممنوع المصنّعات: لانشون/نقانق/سلامي/بسطرمة، المرق البودرة/المكعبات، الصلصات التجارية إن لم تكن منزلية.
- ممنوع الإضافات المسببة للالتهاب: MSG/جلوتامات، نيتريت/نترات، ألوان/نكهات صناعية، مستحلبات.
- ممنوع الزيوت النباتية المكررة/المهدرجة (كانولا/صويا/ذرة/بذر العنب). اسمح بزيت زيتون بكر وزبدة/سمن طبيعي وأفوكادو ومكسرات نيئة.
`.trim() : "";

  const repairLine = __repair && isDrMoh
    ? "الإخراج السابق خالف القيود. أعد توليد وصفة تلتزم حرفيًا بالبنود أعلاه، مع ضبط المقادير لضمان ≤ 5 جم كربوهيدرات/حصة."
    : "";

  return `
أنشئ وصفة ${mealType} من مطبخ ${cuisine} لنظام ${dietType}.
السعرات المستهدفة للحصة: ${Number(caloriesTarget)}.
حساسيات يجب تجنبها: ${avoid}.
${focusLine}
${drRules}
${repairLine}
أعد النتيجة كـ JSON فقط حسب المخطط المطلوب وبالعربية.
`.trim();
}

/* ---------------- JSON extract ---------------- */
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

/* ---------------- Call model ---------------- */
async function callOnce(model, input, timeoutMs = 28000) {
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    // v1beta قد يتجاهل responseSchema/MIME إن لم يدعمها — لا تضر
    systemInstruction: { role: "system", parts: [{ text: systemInstruction(6) }] },
    contents: [{ role: "user", parts: [{ text: userPrompt(input) }] }],
    generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: 1000 },
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

    // حاول كـ JSON مباشر، وإلا استخرج من النص
    let json = data && typeof data === "object" && data.title ? data : extractJsonFromCandidates(data);
    if (!json) return { ok:false, error:"gemini_returned_non_json" };

    // تطبيع: تأمين اللغة + تقصير الخطوات لحد أقصى 6
    if (!json.lang) json.lang = "ar";
    if (Array.isArray(json.steps) && json.steps.length > 6) {
      const chunk = Math.ceil(json.steps.length / 6);
      const merged = [];
      for (let i=0;i<json.steps.length;i+=chunk) merged.push(json.steps.slice(i,i+chunk).join(" ثم "));
      json.steps = merged.slice(0,6);
    }

    const v = validateRecipeSchema(json);
    if (!v.ok) return { ok:false, error:`schema_validation_failed:${v.error}` };

    return { ok:true, recipe: json };
  } catch (e) {
    return { ok:false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- Dr. Mohamed checks ---------------- */
const DR_MOH = /محمد\s*سعيد/;
function violatesDrMoh(recipe) {
  const carbs = Number(recipe?.macros?.carbs_g || 0);
  const ing = (recipe?.ingredients || []).join(" ").toLowerCase();

  const banned = [
    "سكر","sugar","عسل","honey","دبس","شراب","سيرب","glucose","fructose","corn syrup","hfcs",
    "لانشون","نقانق","سلامي","بسطرمة","مرتديلا","مصنع","معلبات","مرق","مكعبات",
    "msg","جلوتامات","glutamate","نتريت","نترات","ملون","نكهات صناعية","مواد حافظة","مستحلب",
    "مهدرج","مارجرين","زيت كانولا","زيت ذرة","زيت صويا","بذر العنب","vegetable oil",
    "دقيق أبيض","طحين أبيض","نشا الذرة","cornstarch","خبز","مكرونة","رز أبيض","سكر بني"
  ];

  const hasBanned = banned.some(k => ing.includes(k));
  const carbsOk = carbs <= 5;
  return (!carbsOk || hasBanned);
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  let input = {};
  try { input = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "invalid_json_body"); }

  const wantDrMoh = DR_MOH.test(String(input?.dietType || ""));

  const errors = {};
  for (const model of MODEL_POOL) {
    // المحاولة الأولى
    const r1 = await callOnce(model, input);
    if (!r1.ok) { errors[model] = r1.error; continue; }

    // إصلاح مرة واحدة عند مخالفة قواعد د. محمد سعيد
    if (wantDrMoh && violatesDrMoh(r1.recipe)) {
      const r2 = await callOnce(model, { ...input, __repair: true });
      if (r2.ok && !violatesDrMoh(r2.recipe)) {
        return ok({ recipe: r2.recipe, model, note: "repaired_to_meet_dr_moh_rules" });
      }
      // قبول المخرجات مع تحذير بدلاً من إسقاط الطلب
      const fallbackRecipe = (r2.ok ? r2.recipe : r1.recipe);
      return ok({ recipe: fallbackRecipe, model, warning: "dr_moh_rules_not_strictly_met" });
    }

    return ok({ recipe: r1.recipe, model });
  }

  // فشل حقيقي (HTTP/مفتاح/إتاحة)
  return bad(502, "All models failed for your key/region on v1beta", { errors, tried: MODEL_POOL });
};
