// netlify/functions/generateRecipe.js
// UAE-ready — works with app.html. Broad model pool on v1beta, strict JSON schema,
// Arabic-only output, and hard rules for "نظام د. محمد سعيد" (≤5g net carbs, no processed/sugars/additives).

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ترتيب يفضّل النماذج الأكثر استقرارًا في الإمارات أولاً
const MODEL_POOL = [
  // Flash (سريع ومتاح عادةً)
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-1.5-flash",
  "gemini-1.5-flash-001",
  // Pro (أدق لكن أبطأ)
  "gemini-1.5-pro",
  "gemini-1.5-pro-001",
  "gemini-pro",
  "gemini-1.0-pro",
  // أسماء لاحقة قد لا تكون متاحة — تُجرّب أخيراً
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-latest"
];

/* ---------------- Utilities ---------------- */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
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

function buildSystemInstruction(maxSteps = 6) {
  return `
أنت شيف تغذية يكتب بالعربية فقط.
أعد **JSON فقط** بلا شرح خارجي وفق المخطط التالي:
{
  "title": string,
  "servings": number,
  "total_time_min": number,
  "macros": { "protein_g": number, "carbs_g": number, "fat_g": number, "calories": number },
  "ingredients": string[],
  "steps": string[],       // ${maxSteps} خطوات كحد أقصى، قصيرة ومباشرة
  "lang": "ar"
}
- أرقام الماكروز أرقام خالصة بلا وحدات.
- ingredients: صياغة مختصرة (كمية + مكوّن) مثل "200 جم صدر دجاج".
- steps: جمل تنفيذية قصيرة وواضحة.
- اللغة العربية حصراً، ولا تضف أي نص خارج JSON.
`.trim();
}

function buildUserPrompt(input) {
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
  const isDrMoh = /محمد\s*سعيد/.test(String(dietType));

  const drRules = isDrMoh ? `
قواعد **صارمة** لنظام د. محمد سعيد:
- الكربوهيدرات الصافية لكل حصة ≤ 5 جم (خمسة جرامات كحد أقصى).
- ممنوع السكريات والمُحلّيات (سكر أبيض/بني، عسل، شراب الذرة/الجلوكوز/الفركتوز، المحليات الصناعية).
- ممنوع المصنّعات: لانشون/نقانق/سلامي/بسطرمة، المرق البودرة والمكعبات، الصلصات التجارية (كاتشب/مايونيز/باربكيو) إن لم تكن منزلية صِرفة.
- ممنوع الإضافات المسببة للالتهاب: MSG والجلوتامات، نيتريت/نترات، ألوان/نكهات صناعية، مستحلبات.
- ممنوع الزيوت النباتية المكررة/المهدرجة (كانولا، صويا، ذرة، بذر العنب). اسمح فقط بزيت زيتون بكر، زبدة/سمن حيواني طبيعي، أفوكادو ومكسرات نيئة غير مملّحة.
- استخدم مكونات كاملة وحقيقية قدر الإمكان.
`.trim() : "";

  return `
أنشئ وصفة ${mealType} من مطبخ ${cuisine} لنظام ${dietType}.
السعرات المستهدفة للحصة: ${Number(caloriesTarget)}.
حساسيات يجب تجنبها: ${avoid}.
${focusLine}
${drRules}
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

  const schema = {
    type: "OBJECT",
    properties: {
      title: { type:"STRING" },
      servings: { type:"NUMBER" },
      total_time_min: { type:"NUMBER" },
      macros: {
        type: "OBJECT",
        properties: {
          protein_g: { type:"NUMBER" },
          carbs_g:   { type:"NUMBER" },
          fat_g:     { type:"NUMBER" },
          calories:  { type:"NUMBER" }
        },
        required: ["protein_g","carbs_g","fat_g","calories"]
      },
      ingredients: { type:"ARRAY", items:{ type:"STRING" } },
      steps: { type:"ARRAY", items:{ type:"STRING" } },
      lang: { type:"STRING", enum:["ar"] }
    },
    required: ["title","servings","total_time_min","macros","ingredients","steps","lang"]
  };

  const body = {
    systemInstruction: { role: "system", parts: [{ text: buildSystemInstruction(6) }] },
    contents: [{ role: "user", parts: [{ text: buildUserPrompt(input) }] }],
    generationConfig: {
      temperature: 0.35,
      topP: 0.9,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
      responseSchema: schema
    },
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

    // حاول أولاً كـ JSON مباشر وفق responseSchema
    let json = data;
    if (!json?.title || !json?.macros) {
      json = extractJsonFromCandidates(data);
    }
    if (!json) return { ok:false, error:"gemini_returned_non_json" };

    // تقنين الخطوات إلى 6 عند المصدر إن زادت
    if (Array.isArray(json.steps) && json.steps.length > 6) {
      const chunk = Math.ceil(json.steps.length / 6);
      const merged = [];
      for (let i=0;i<json.steps.length;i+=chunk) {
        merged.push(json.steps.slice(i,i+chunk).join(" ثم "));
      }
      json.steps = merged.slice(0,6);
    }

    // ملء حقل اللغة لضمان التوافق مع الواجهة
    if (!json.lang) json.lang = "ar";

    const v = validateRecipeSchema(json);
    if (!v.ok) return { ok:false, error:`schema_validation_failed:${v.error}` };

    return { ok:true, recipe: json };
  } catch (e) {
    return { ok:false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* ----- قواعد د. محمد سعيد (تحقق بعد التوليد) ----- */
function violatesDrMoh(recipe) {
  const carbs = Number(recipe?.macros?.carbs_g || 0);
  const ing = (recipe?.ingredients || []).join(" ").toLowerCase();

  const banned = [
    // sugars & syrups
    "سكر","sugar","عسل","honey","دبس","شراب","سيرب","glucose","fructose","corn syrup","hfcs",
    // processed meats and canned stuff
    "لانشون","نقانق","سلامي","بسطرمة","مرتديلا","مصنع","معلبات","مرق","مكعبات",
    // additives & msg
    "msg","جلوتامات","glutamate","نتريت","نترات","ملون","نكهات صناعية","مواد حافظة","مستحلب",
    // refined oils / margarines
    "مهدرج","مارجرين","زيت كانولا","زيت ذرة","زيت صويا","بذر العنب","vegetable oil",
    // refined starch/flour
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

  const isDrMoh = /محمد\s*سعيد/.test(String(input?.dietType || ""));

  const errors = {};
  for (const model of MODEL_POOL) {
    const res = await callOnce(model, input);
    if (res.ok) {
      // تحقق صريح لقواعد د. محمد سعيد
      if (isDrMoh && violatesDrMoh(res.recipe)) {
        errors[model] = "violated_dr_moh_rules";
        continue; // جرّب نموذجاً آخر دون إفادة المستخدم بوصفة مخالفة
      }
      return ok({ recipe: res.recipe, model });
    }
    errors[model] = res.error;
  }

  // لا وصفات افتراضية — تقرير واضح بكل موديل تمّت تجربته
  const extra = isDrMoh
    ? { note: "تم رفض المخرجات التي خالفت قواعد د. محمد سعيد (≤5 جم كربوهيدرات/حصة + منع السكريات/المصنعات/الإضافات)." }
    : {};
  return bad(502, "All models failed for your key/region on v1beta", { errors, tried: MODEL_POOL, ...extra });
};
