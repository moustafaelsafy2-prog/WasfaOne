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

/* ---------------- Nutrition strict helpers (no flow change) ---------------- */
/** Compute calories from macros with the canonical factors and enforce ±2%. */
function reconcileCalories(macros) {
  const p = Number(macros?.protein_g || 0);
  const c = Number(macros?.carbs_g || 0);
  const f = Number(macros?.fat_g || 0);
  const stated = Number(macros?.calories || 0);

  // Exact energy from macros (no heuristic rounding).
  const calculated = p * 4 + c * 4 + f * 9;

  // If stated deviates beyond ±2%, set calories to the calculated value.
  const within2pct =
    stated > 0 ? Math.abs(stated - calculated) / calculated <= 0.02 : false;

  const result = { ...macros };
  result.calories = within2pct ? stated : calculated;

  // Attach a non-breaking note for traceability (schema allows extra fields).
  result._energy_model = "4/4/9 strict";
  result._energy_check = within2pct ? "ok" : "adjusted_to_match_macros";
  return result;
}

/** Light check that every ingredient line includes a numeric gram weight. */
function hasGramWeightLine(s) {
  if (typeof s !== "string") return false;
  const line = s.toLowerCase();
  // Arabic and Latin variants for gram notations.
  return /\b\d+(\.\d+)?\s*(جم|غ|g|gram|grams)\b/.test(line);
}
function enforceGramHints(ingredients) {
  // Do not change flow or reject; just ensure lines are trimmed,
  // and if many lines miss grams, we nudge the model via instruction (handled below).
  // Here we only normalize whitespace.
  return Array.isArray(ingredients)
    ? ingredients.map(x => (typeof x === "string" ? x.trim() : x))
    : ingredients;
}

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

  // Soft nutrition strictness: ensure most ingredient lines have gram weights
  // without altering the success path or schema behavior.
  const gramCount = rec.ingredients.filter(hasGramWeightLine).length;
  rec._ingredients_gram_coverage = `${gramCount}/${rec.ingredients.length}`;

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

📘 **توجيه رسمي صارم لحساب السعرات والماكروز (يُطبق على كل وصفة بلا استثناء)**

🎯 الهدف: دقة ±2% قابلة للاعتماد في البروتوكولات العلاجية وخطط التغذية المتقدمة.

1) **الوزن النيء الفعلي لكل مكوّن**: كل كمية يجب أن تُعبّر بالجرام (g/جم) وبالوزن قبل الطهي. يمنع استعمال "ملعقة/كوب/حبة" دون تحويل دقيق إلى جرامات.
2) **حساسية الميزان**: يُفترض وزن كل مكوّن بميزان ±0.1 جم؛ أي اختلاف في الوزن ينعكس على السعرات والماكروز.
3) **تمييز نوع المكوّن**: فرّق بدقة بين الحالات (مثل: "زيت زيتون بكر ممتاز" ≠ "زيت زيتون عادي"، "طماطم طازجة" ≠ "مجففة"، "لحم نيء" ≠ "مطبوخ").
4) **مصادر البيانات المعتمدة فقط**: القيم الغذائية تُستمد من قواعد بيانات علمية (USDA FoodData Central، CIQUAL، McCance and Widdowson). يمنع استخدام تقديرات عامة.
5) **نموذج الطاقة القياسي**: البروتين 4 ك.س/جم، الكربوهيدرات 4 ك.س/جم، الدهون 9 ك.س/جم.
6) **طريقة الحساب**:
   - احسب الماكروز لكل مكوّن بناءً على وزنه النيء ثم اجمعها.
   - احسب الطاقة من الماكروز (Protein×4 + Carbs×4 + Fat×9). لا تجمع السعرات مباشرة من مصادر مختلفة بدون المرور بالماكروز.
7) **منع التقريب غير العلمي**: لا تستخدم متوسطات أو تقديرات. يجب أن تأتي الأرقام نتيجة حساب مباشر من الماكروز وبانحراف لا يتجاوز ±2%.
8) **سلامة الإخراج**:
   - يجب أن تحتوي كل عناصر ingredients على مقدار بالجرام مثل: "30 جم زيت زيتون بكر ممتاز"، "150 جم صدور دجاج نيئة".
   - التزم بالوصف الدقيق لنوع المكوّن.
   - أعِد الحقول داخل JSON فقط كما في المخطط أعلاه دون حقول إضافية.
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

    // تشديد التغذية: طَبّق الطاقة من الماكروز بدقة 4/4/9 وأعد ضبط السعرات إذا لزم الأمر
    if (json.macros) {
      json.macros = reconcileCalories(json.macros);
    }
    // تطبيع خفيف لقائمة المكونات (لا يغيّر التدفق)
    if (Array.isArray(json.ingredients)) {
      json.ingredients = enforceGramHints(json.ingredients);
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
