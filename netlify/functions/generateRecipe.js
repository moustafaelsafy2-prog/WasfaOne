// netlify/functions/generateRecipe.js
// UAE-ready — Arabic JSON schema, strict energy reconciliation (4/4/9),
// Dr. Mohamed Saeed soft-repair path, and now: full diet profiles + custom macros support.

/*  [oai_citation:0‡خطة المشروع.docx](file-service://file-CnXNbiywSJmJR4R6E84xaU) */
/*  [oai_citation:1‡خريطة الملفات.docx](file-service://file-MtCHta4VW8FqJyRLDTugHv) */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MODEL_POOL = [
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro",
  "gemini-1.5-pro-001",
  "gemini-pro",
  "gemini-1.0-pro",
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

/* ---------------- Nutrition strict helpers ---------------- */
function reconcileCalories(macros) {
  const p = Number(macros?.protein_g || 0);
  const c = Number(macros?.carbs_g || 0);
  const f = Number(macros?.fat_g || 0);
  const stated = Number(macros?.calories || 0);
  const calculated = p * 4 + c * 4 + f * 9;
  const within2pct = calculated > 0 && stated > 0
    ? Math.abs(stated - calculated) / calculated <= 0.02
    : false;
  return {
    ...macros,
    calories: within2pct ? stated : calculated,
    _energy_model: "4/4/9 strict",
    _energy_check: within2pct ? "ok" : "adjusted_to_match_macros"
  };
}

function hasGramWeightLine(s) {
  if (typeof s !== "string") return false;
  const line = s.toLowerCase();
  return /\b\d+(\.\d+)?\s*(جم|غ|g|gram|grams)\b/.test(line);
}
function enforceGramHints(ingredients) {
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

  const gramCount = rec.ingredients.filter(hasGramWeightLine).length;
  rec._ingredients_gram_coverage = `${gramCount}/${rec.ingredients.length}`;

  return { ok:true };
}

/* ---------------- Diet Profiles (constraints injected into the prompt) ---------------- */
const DIET_PROFILES = {
  dr_mohamed_saeed: `
- كربوهيدرات صافية ≤ 5 جم/حصة.
- ممنوع السكريات والمُحلّيات (سكر أبيض/بني، عسل، شراب الذرة/الجلوكوز/الفركتوز، المحليات الصناعية).
- ممنوع المصنّعات: لانشون/نقانق/سلامي/بسطرمة، المرق البودرة/المكعبات، الصلصات التجارية إن لم تكن منزلية.
- ممنوع الإضافات: MSG/جلوتامات، نيتريت/نترات، ألوان/نكهات صناعية، مستحلبات.
- ممنوع الزيوت النباتية المكررة/المهدرجة (كانولا/صويا/ذرة/بذر العنب). يسمح بزيت زيتون بكر،كريمة الطبخ كاملة الدسم من أصل حيواني ،زبدة/سمن طبيعي، أفوكادو، مكسرات نيئة.
  `.trim(),
  keto: `
- كارب منخفض جدًا (استهدف ≤ 10–12 جم صافي/حصة).
- دهون صحية أساسية (زيت زيتون بكر/أفوكادو/زبدة)، بروتين متوسط.
- لا حبوب/سكريات/نشويات عالية.
  `.trim(),
  high_protein: `
- البروتين ≥ 25–35% من طاقة الحصة.
- كارب ودهون متوازنان مع أولوية للأطعمة الكاملة.
  `.trim(),
  high_protein_keto: `
- مثل الكيتو لكن مع رفع البروتين وتقليل الدهون لتعويض.
- صافي كارب منخفض جدًا.
  `.trim(),
  low_carb: `
- خفّض الكارب (استهدف 15–35 جم/حصة) مع بروتين أعلى وألياف.
  `.trim(),
  atkins: `
- التزم بالخضار غير النشوية والبروتين والدهون الصحية.
- لا سكريات/طحين أبيض؛ كارب منخفض.
  `.trim(),
  lchf: `
- كارب منخفض ودهون مرتفعة الجودة (EVOO/أفوكادو/مكسرات)، بروتين كافٍ.
  `.trim(),
  psmf: `
- بروتين عالٍ جدًا مع دهون وكارب ضئيلين.
- التزم بمقادير دقيقة وخضار ورقية قليلة الطاقة.
  `.trim(),
  low_fat: `
- الدهون ≤ 20–30% من الطاقة، طبّق طهي قليل الدهون، وفضّل البروتين الخالي من الدهون.
  `.trim(),
  balanced: `
- تقريب 40/30/30 (كارب/بروتين/دهون) مع أطعمة كاملة وغنية بالألياف.
  `.trim(),
  mediterranean: `
- اعتمد EVOO، خضار، بقوليات، سمك؛ قلّل اللحوم الحمراء والسكريات.
  `.trim(),
  vegan: `
- نباتي 100%: لا لحوم/بيض/ألبان/عسل.
- وفّر بروتين نباتي كافٍ (بقوليات/توفو/تمبيه).
  `.trim(),
  flexitarian: `
- نباتي في الغالب مع حصص صغيرة اختيارية من البروتين الحيواني عالي الجودة.
  `.trim(),
  intermittent_fasting: `
- لا قيود نوعية صارمة لكن اجعل الوجبة متوازنة وعالية الجودة ضمن نافذة الأكل.
  `.trim(),
  carb_cycling: `
- صيّغ هذه الوجبة كوجبة عالية أو منخفضة الكارب حسب المدخل، افترض منخفضة إن لم يحدد المستخدم.
  `.trim(),
  dash: `
- قلّل الصوديوم، ارفع الخضار والفواكه والألبان قليلة الدسم والحبوب الكاملة.
  `.trim(),
  anti_inflammatory: `
- زوّد أوميغا-3 (سمك دهني/بذور الكتان/الجوز)، توابل (كركم/زنجبيل)، وخفّض السكريات والزيوت المكررة.
  `.trim(),
  low_fodmap: `
- تجنب: ثوم/بصل/قمح/فاصوليا عالية FODMAP، اختر بدائل منخفضة FODMAP.
  `.trim(),
  elimination: `
- تجنب المشتبه به (يُحدد من الحساسية المدخلة) واحرص على مكونات بسيطة وأحادية المصدر.
  `.trim(),
  renal: `
- راقب الصوديوم والبوتاسيوم والفوسفور؛ بروتين معتدل وفق التوجيهات العامة.
  `.trim(),
  liver: `
- خفّض السكريات والدهون المتحولة/المشبعة، زد الألياف وأوميغا-3، لا كحول.
  `.trim(),
  pcos: `
- حساسية إنسولين أفضل: كارب منخفض/متوسط بجودة عالية، بروتين كافٍ، دهون صحية.
  `.trim(),
  diabetes: `
- تحكم كارب دقيق وألياف عالية؛ توازن الماكروز لمنحنى جلوكوز ثابت.
  `.trim(),
  metabolic_syndrome: `
- قلّل السكريات والكارب المكرر، ارفع الألياف والبروتين الخالي من الدهون والدهون غير المشبعة.
  `.trim()
};

/* ---------------- Prompting ---------------- */
function systemInstruction(maxSteps = 8) {
  return `
أنت شيف محترف وخبير تغذية. أعد **JSON فقط** وفق المخطط أدناه — دون أي نص خارج القوسين المعقوفين:
{
  "title": string,
  "servings": number,
  "total_time_min": number,
  "macros": { "protein_g": number, "carbs_g": number, "fat_g": number, "calories": number },
  "ingredients": string[],
  "steps": string[],  // الحد الأقصى ${maxSteps} خطوات قصيرة وواضحة
  "lang": "ar"
}

قواعد إلزامية غير قابلة للتجاوز:
1) اللغة: العربية الفصحى فقط، أسلوب احترافي موجز، بلا حشو أو شرح خارج JSON.
2) القياسات: **كل المكونات بالجرام 100%** (وزن نيّئ). ممنوع "كوب/ملعقة/رشة/حبة/½" إلخ. حوِّل دائمًا إلى جرام بدقة (أقرب 1 جم). اذكر الزيوت والتوابل أيضًا بجرام.
3) الطاقة من الماكروز فقط (4/4/9): احسب السعرات = (protein_g×4 + carbs_g×4 + fat_g×9). يجب أن يطابق الحقل calories هذا المجموع بدقة ±2%. عند التعارض اضبط calories ليطابق الحساب.
4) الالتزام بالقيود: طبّق **حرفيًا** أي تعليمات/أنظمة غذائية/حساسيات تأتي في رسالة المستخدم (بما فيها قيود د. محمد سعيد إن طُلبت). لا تستخدم أي مكوّن محظور ولا تتجاوز حدود الكارب المطلوبة.
5) المكونات: عناصر قصيرة بالشكل "200 جم صدر دجاج". سمِّ النوع بدقة (مثل: "زيت زيتون بكر ممتاز"، "رز بسمتي نيّئ"). لا أسماء علامات تجارية، ولا مكوّنات عامة مبهمة.
6) الخطوات: صيغة أمر عملية، بلا تكرار، ≤ ${maxSteps} خطوات. لا تُدخل أي مكونات غير مذكورة في قائمة ingredients. لا خطوات فارغة أو عامة مثل "حضّر المكوّنات".
7) الجودة والتنوّع: قدّم وصفات **غير مكررة** ومميّزة ضمن المطبخ/النظام المطلوب، وتجنّب الأطباق المبتذلة الشائعة ما أمكن. عدّل التقنيات/التتبيل لتحقيق تميّز حقيقي مع الالتزام الصارم بالكارب والماكروز.
8) الاتساق: أرقام الماكروز أعداد فقط (بدون وحدات). لا تعليقات، لا نص خارج JSON، لا أسطر تفسيرية.
9) المصادر الغذائية: اعتمد قيمًا من قواعد معترف بها (USDA/CIQUAL/McCance) لتقدير الماكروز؛ لا تقديرات عشوائية.

شكل العناصر:
- ingredients: مصفوفة سلاسل بنمط "الكمية بالجرام + اسم المكوّن".
- steps: جُمل تنفيذية قصيرة مرتّبة منطقيًا من التحضير إلى التقديم.

أعد الإخراج وفق المخطط أعلاه حرفيًا وبالعربية فقط.
`.trim();
}

function userPrompt(input) {
  const {
    mealType = "وجبة",
    cuisine = "متنوع",
    dietType = "balanced",
    caloriesTarget = 500,
    customMacros = null,
    allergies = [],
    focus = "",
    __repair = false
  } = input || {};

  const avoid = (Array.isArray(allergies) && allergies.length) ? allergies.join(", ") : "لا شيء";
  const focusLine = focus ? `تركيز خاص: ${focus}.` : "";

  const isDrMoh = /dr_mohamed_saeed|محمد\s*سعيد/.test(String(dietType));
  const isCustom = String(dietType) === "custom";

  const profile = DIET_PROFILES[dietType] || "";

  const drRules = isDrMoh ? DIET_PROFILES["dr_mohamed_saeed"] : "";

  const repairLine = __repair && isDrMoh
    ? "الإخراج السابق خالف القيود. أعد توليد وصفة تلتزم حرفيًا بالبنود أعلاه، مع ضبط المقادير لضمان ≤ 5 جم كربوهيدرات/حصة."
    : "";

  const customLine = isCustom && customMacros
    ? `استخدم هذه الماكروز **لكل حصة** حرفيًا: بروتين ${Number(customMacros.protein_g)} جم، كارب ${Number(customMacros.carbs_g)} جم، دهون ${Number(customMacros.fat_g)} جم. يجب أن يساوي حقل السعرات مجموع (بروتين×4 + كارب×4 + دهون×9) بدقة ±2%.`
    : "";

  return `
أنشئ وصفة ${mealType} من مطبخ ${cuisine} لنظام ${isDrMoh ? "نظام د. محمد سعيد" : dietType}.
السعرات المستهدفة للحصة: ${Number(caloriesTarget)}.
حساسيات يجب تجنبها: ${avoid}.
${focusLine}
${profile}
${drRules}
${customLine}
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
    systemInstruction: { role: "system", parts: [{ text: systemInstruction(8) }] },
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

    let json = data && typeof data === "object" && data.title ? data : extractJsonFromCandidates(data);
    if (!json) return { ok:false, error:"gemini_returned_non_json" };

    // Normalize
    if (!json.lang) json.lang = "ar";
    if (Array.isArray(json.steps) && json.steps.length > 8) {
      const chunk = Math.ceil(json.steps.length / 8);
      const merged = [];
      for (let i=0;i<json.steps.length;i+=chunk) merged.push(json.steps.slice(i,i+chunk).join(" ثم "));
      json.steps = merged.slice(0,6);
    }

    // Strict energy reconciliation
    if (json.macros) {
      json.macros = reconcileCalories(json.macros);
    }
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
const DR_MOH = /محمد\s*سعيد|dr_mohamed_saeed/;
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

  // Validate custom macros if dietType === custom
  const isCustom = String(input?.dietType || "") === "custom";
  let customMacros = null;
  if (isCustom) {
    const cm = input?.customMacros || {};
    const p = Number(cm.protein_g), c = Number(cm.carbs_g), f = Number(cm.fat_g);
    if (![p,c,f].every(Number.isFinite)) return bad(400, "custom_macros_invalid");
    if (p < 0 || c < 0 || f < 0) return bad(400, "custom_macros_negative");
    customMacros = { protein_g: p, carbs_g: c, fat_g: f };
  }

  const wantDrMoh = DR_MOH.test(String(input?.dietType || ""));

  const errors = {};
  for (const model of MODEL_POOL) {
    const r1 = await callOnce(model, { ...input, customMacros });
    if (!r1.ok) { errors[model] = r1.error; continue; }

    if (wantDrMoh && violatesDrMoh(r1.recipe)) {
      const r2 = await callOnce(model, { ...input, customMacros, __repair: true });
      if (r2.ok && !violatesDrMoh(r2.recipe)) {
        return ok({ recipe: r2.recipe, model, note: "repaired_to_meet_dr_moh_rules" });
      }
      const fallbackRecipe = (r2.ok ? r2.recipe : r1.recipe);
      return ok({ recipe: fallbackRecipe, model, warning: "dr_moh_rules_not_strictly_met" });
    }

    return ok({ recipe: r1.recipe, model });
  }

  return bad(502, "All models failed for your key/region on v1beta", { errors, tried: MODEL_POOL });
};
