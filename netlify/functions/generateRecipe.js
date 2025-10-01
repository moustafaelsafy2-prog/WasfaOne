// netlify/functions/generateRecipe.js
// UAE-ready — Arabic JSON schema, strict energy reconciliation (4/4/9),
// Dr. Mohamed Saeed soft-repair path, and now: full diet profiles + custom macros support + user-available ingredients.
// تنويع ذكي حسب المطبخ + إصلاح منطق "الحلويات": سكر ستيفيا طبيعي نقي مسموح بحدود ضيقة (إن كان النظام يسمح) وخالٍ من الإضافات الصناعية.

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

/* ---------------- Cuisine Variety Guides (prompt-time diversification) ---------------- */
const CUISINE_GUIDES = {
  "شرق أوسطي": `
- اختر في كل مرة أسلوبًا مختلفًا من: لبناني/سوري، فلسطيني/أردني، عراقي، خليجي، حجازي، حضرمي، يمني، حجازي-تركي تزاوجي.
- أمثلة تقنيات: شَيّ/تحمير بالسمن، طاجن، كبسة/مندي (لغير الحلويات)، تتبيل ليموني-ثومي (للوصفات المالحة فقط)، تحميص بالطحينة أو دبس الرمان (بحرص على الكارب).
- للحلويات: قوام كريمي/مقرمش (سميد غير مسموح بالأنظمة منخفضة الكارب)، بدائل: لوز مطحون/جوز هند ناعم/كريمة/كاكاو خام/توت منخفض السكر، ستيفيا طبيعية نقية فقط بحدود ضيقة حيث يسمح النظام.
`.trim(),
  "متوسطي (Mediterranean)": `
- نوّع بين يوناني/إسباني/إيطالي-ريفي/فرنسي-بروفنسالي/تركي-إيجه.
- تقنيات: خبز بالفرن، سوتيه بزيت الزيتون البكر، تتبيل بالأعشاب والحمضيات.
- حلويات: زبادي كثيف/ماسكرپوني خفيف/لوز مطحون/توت؛ ستيفيا طبيعية نقية بقدر محدود إن سمح النظام.
`.trim(),
  "مطبخ مصري": `
- نوّع بين أكلات ريفية/إسكندرانية/صعيدية/قاهرية منزلية.
- تجنّب الأرز/الخبز/المكرونة في الأنظمة منخفضة الكارب، واستخدم بدائل (قرنبيط مبشور/كوسا).
- حلويات: قوام كريمي ومكسرات محمّصة خفيفة؛ ستيفيا طبيعية نقية فقط وبلا إضافات صناعية.
`.trim(),
  "هندي": `
- بدّل بين شمالي/جنوبي/كجراتي/بنغالي مع ضبط البهارات والكارب.
- تجنّب السكريات والدقيق الأبيض؛ استخدم بهارات دافئة للحلويات فقط (هيل/قرفة/فانيلا) دون بهارات حادة (كمون/كركم) في الحلويات.
`.trim(),
  "أمريكي": `
- ستايلات: مشاوي، داينر منزلي، كاليفورني صحي.
- حلويات: تشيزكيك خفيف/موس شوكولاتة كاكاو خام/كوب كيك لوز؛ ستيفيا نقية فقط وبحدود ضيقة.
`.trim()
  // يمكن توسيع اللائحة، وأي مطبخ غير موجود يُعامل بتوجيه عام متنوع.
};

/* ---------------- Diet Profiles (constraints injected into the prompt) ---------------- */
const DIET_PROFILES = {
  dr_mohamed_saeed: `
- صافي الكربوهيدرات ≤ 5 جم/حصة كحد أقصى. المكونات مسموحة فقط إذا كانت طبيعية بالكامل وغير مصنّعة.
- ممنوع السكريات والمُحلّيات جميعها (سكر أبيض/بني، عسل، شراب الذرة/الجلوكوز/الفركتوز، المحليات الصناعية). **ستيفيا غير مسموحة في هذا النظام.**
- ممنوع المصنّعات: لانشون/نقانق/سلامي/بسطرمة/مرتديلا، المعلبات، مرق بودرة/مكعبات، صلصات تجارية غير منزلية.
- ممنوع الإضافات: MSG/جلوتامات، نيتريت/نترات، ألوان/نكهات صناعية، مستحلبات، زيوت مهدرجة/مكررة (كانولا/صويا/ذرة/بذر العنب/vegetable oil).
- المسموح: زيت زيتون بكر ممتاز، زبدة/سمن طبيعي، كريمة طبخ كاملة الدسم من مصدر حيواني، أفوكادو، مكسرات نيئة، أعشاب وتوابل طبيعية. اضبط الملح بحذر.
  `.trim(),
  keto: `
- هدف صافي كربوهيدرات منخفض جدًا (≤ 10–12 جم/حصة) مع بروتين متوسط ودهون صحية كمصدر طاقة أساسي.
- يُفضَّل: لحوم/أسماك/بيض، خضار غير نشوية، زيوت عالية الجودة (EVOO/أفوكادو/زبدة)، مكسرات وبذور باعتدال.
- يُمنَع: الحبوب والسكريات والنشويات العالية والدرنيات والدقيق الأبيض.
- الحلويات: **مسموح ستيفيا طبيعية نقية فقط وبحدود ضيقة** وخالية من الإضافات الصناعية.
  `.trim(),
  high_protein: `
- البروتين مرتفع (≥ 25–35% من الطاقة) مع ضبط الكارب والدهون لتوازن السعرات.
- الحلويات: إن طُلبت ضمن السعرات، استخدم ستيفيا طبيعية نقية فقط وبقدر محدود وبدون إضافات صناعية.
  `.trim(),
  high_protein_keto: `
- صافي كارب منخفض جدًا كالكيتو مع رفع البروتين وتقليل الدهون لتعويض السعرات.
- الحلويات: ستيفيا طبيعية نقية بحدود ضيقة فقط، وخالية من أي إضافات صناعية.
  `.trim(),
  low_carb: `
- نطاق الكارب 15–35 جم/حصة؛ بروتين أعلى وألياف مرتفعة.
- الحلويات: مسموحة بستيفيا طبيعية نقية بكمية ضئيلة فقط، دون سكريات مضافة أو إضافات صناعية.
  `.trim(),
  atkins: `
- منخفض الكارب بمراحل؛ يُمنع السكر والدقيق الأبيض.
- الحلويات: ستيفيا طبيعية نقية فقط وبقدر محدود وخالية من الإضافات الصناعية.
  `.trim(),
  lchf: `
- كارب منخفض ودهون مرتفعة الجودة؛
- الحلويات: ستيفيا طبيعية نقية بكمية صغيرة فقط؛ لا محليات صناعية أو خلطات مضافة.
  `.trim(),
  psmf: `
- بروتين عالٍ جدًا مع دهون وكارب ضئيلين للغاية.
- الحلويات: عمومًا غير مفضلة، وإن طُلبت فتكون ستيفيا طبيعية نقية بكمية ضئيلة جدًا ودون أي إضافات صناعية.
  `.trim(),
  low_fat: `
- الدهون ≤ 20–30% من الطاقة؛
- الحلويات: ستيفيا طبيعية نقية بحدود ضيقة بدل السكر، وتجنّب المضافات الصناعية.
  `.trim(),
  balanced: `
- 40/30/30 تقريبي بأطعمة كاملة؛
- الحلويات: يُسمح بستيفيا طبيعية نقية بقدر محدود؛ لا سكريات مضافة ولا إضافات صناعية.
  `.trim(),
  mediterranean: `
- زيت الزيتون البكر، خضار، بقوليات، حبوب كاملة، أسماك؛
- الحلويات: ركّز على فواكه منخفضة السكر ومكسرات؛ يمكن ستيفيا طبيعية نقية بحدود ضيقة وخالية من الإضافات الصناعية.
  `.trim(),
  vegan: `
- نباتي 100%؛
- الحلويات: ستيفيا نباتية (مستخلص طبيعي نقي) بكمية صغيرة فقط، وتجنّب الخلطات ذات الإضافات الصناعية.
  `.trim(),
  flexitarian: `
- نباتي غالبًا مع حصص حيوانية عالية الجودة عند الحاجة؛
- الحلويات: ستيفيا طبيعية نقية بحدود ضيقة وخالية من الإضافات الصناعية.
  `.trim(),
  intermittent_fasting: `
- لا قيود نوعية صارمة؛
- الحلويات: إن لزم، ستيفيا طبيعية نقية بكمية ضئيلة فقط وبلا إضافات صناعية.
  `.trim(),
  carb_cycling: `
- أيام منخفضة/مرتفعة الكارب؛
- الحلويات: ستيفيا طبيعية نقية بكمية صغيرة (أيام منخفضة الكارب)، وتجنّب المضافات الصناعية.
  `.trim(),
  dash: `
- خفض الصوديوم، رفع الخضار والفواكه؛
- الحلويات: ستيفيا طبيعية نقية بحدود ضيقة بدل السكر، خالية من الإضافات الصناعية.
  `.trim(),
  anti_inflammatory: `
- أوميغا-3 وتوابل مضادة للالتهاب؛
- الحلويات: ستيفيا طبيعية نقية فقط وبكمية قليلة؛ لا محليات صناعية أو إضافات.
  `.trim(),
  low_fodmap: `
- بدائل منخفضة FODMAP؛
- الحلويات: ستيفيا طبيعية نقية غالبًا مناسبة؛ تجنّب خلطات تحتوي سكر كحولي/إضافات صناعية.
  `.trim(),
  elimination: `
- استبعاد مسبّبات التحسس؛
- الحلويات: ستيفيا طبيعية نقية فقط وبكمية محدودة، بدون إضافات صناعية.
  `.trim(),
  renal: `
- راقب الصوديوم والبوتاسيوم والفوسفور؛
- الحلويات: ستيفيا طبيعية نقية بكمية ضئيلة؛ تجنّب بدائل عالية البوتاسيوم أو إضافات صناعية.
  `.trim(),
  liver: `
- خفض السكريات والدهون المتحولة/المشبعة؛
- الحلويات: ستيفيا طبيعية نقية بكمية صغيرة فقط، وخالية من أي إضافات صناعية.
  `.trim(),
  pcos: `
- تحسين حساسية الإنسولين؛
- الحلويات: ستيفيا طبيعية نقية بكمية محدودة، وتجنّب المحليات الصناعية.
  `.trim(),
  diabetes: `
- تحكّم صارم بالكارب وجودته؛
- الحلويات: مسموح **ستيفيا طبيعية نقية فقط وبحدود ضيقة**، واحسب الكارب القابل للهضم بدقة. ممنوع الإضافات الصناعية.
  `.trim(),
  metabolic_syndrome: `
- خفض السكريات والكارب المكرر؛
- الحلويات: ستيفيا طبيعية نقية بكمية صغيرة فقط وخالية من الإضافات الصناعية.
  `.trim()
};

/* ---------------- Dessert sanity & diversity checks ---------------- */
const DESSERT_SAVORY_BANNED = [
  "لحم","دجاج","ديك رومي","لحم مفروم","سمك","تونة","سجق","نقانق","سلامي","بسطرمة","مرق",
  "ثوم","بصل","كركم","كمون","كزبرة ناشفة","بهارات كبسة","بهارات برياني","بهارات مشكلة","شطة","صلصة صويا","معجون طماطم"
];

function isDessert(mealType) {
  return /حلويات|تحلية|dessert/i.test(String(mealType||""));
}
function dessertLooksIllogical(recipe) {
  const ing = (recipe?.ingredients||[]).join(" ").toLowerCase();
  return DESSERT_SAVORY_BANNED.some(k => ing.includes(k.toLowerCase()));
}

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

قواعد إلزامية:
1) العربية الفصحى فقط وبلا أي نص خارج JSON.
2) كل المقادير بالجرام (وزن نيّئ) بما فيها الزيوت/التوابل. لا "كوب/ملعقة/حبة" أبداً.
3) السعرات = 4/4/9 من الماكروز وبدقة ±2% كحد أقصى؛ عند التعارض اضبط calories لتطابق الحساب.
4) التزم حرفيًا بالقيود (النظام الغذائي/الحساسيات/المكوّنات المتاحة). لا مكوّن محظور ولا تجاوز للحدود.
5) ingredients بصيغة "الجرام + المكوّن" مع وصف نوعي دقيق (EVOO/بسمتي نيّئ…).
6) steps أوامر عملية واضحة، ≤ ${maxSteps}، ولا تضف مكوّنات غير مذكورة.
7) اللذّة والتنويع: نكهات متوازنة (حامض/مالح/عطري) وتقنيات طهو تعمّق النكهة دون كسر القيود. لا تكرار للوصفات الشائعة؛ اختر أسلوبًا مختلفًا كل مرة ضمن المطبخ.
8) الحلويات ("حلويات"): طعم حلو وقوام ممتع. يُسمح بستيفيا **طبيعية نقية فقط** وبحدود ضيقة وخالية من الإضافات الصناعية، وممنوعة في نظام د. محمد سعيد. لا توابل مالحة/حادة ولا بروتينات لحم/دجاج/سمك.
9) الماكروز أرقام فقط، ولا تعليقات خارج JSON.
10) اعتمد جداول غذائية معتمدة (USDA/CIQUAL/McCance) للتقدير، لا تقديرات عشوائية.
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
    availableIngredients = [],
    __repair = false,
    __repair_available = false,
    __repair_dessert = false,
    __repair_diversity = false
  } = input || {};

  const avoid = (Array.isArray(allergies) && allergies.length) ? allergies.join(", ") : "لا شيء";
  const focusLine = focus ? `تركيز خاص: ${focus}.` : "";

  const isDrMoh = /dr_mohamed_saeed|محمد\s*سعيد/.test(String(dietType));
  const isCustom = String(dietType) === "custom";

  const profile = DIET_PROFILES[dietType] || "";
  const drRules = isDrMoh ? DIET_PROFILES["dr_mohamed_saeed"] : "";

  const available = (Array.isArray(availableIngredients) ? availableIngredients : [])
    .map(s => String(s||"").trim()).filter(Boolean);

  const availableLine = available.length
    ? `المكوّنات المتاحة لدى المستخدم (اختياري): ${available.join(", ")}.
- استخدم هذه المكوّنات كأساس الوصفة قدر الإمكان. يجب تضمينها جميعًا في ingredients بأوزان جرام دقيقة.
- لا تضف مكوّنات إضافية إلا للضرورة التقنية أو لضبط الماكروز (ماء/ملح/فلفل/توابل/زيت زيتون بكر).
- إن تعذر الالتزام بالقائمة، عدّل الأوزان واقترح أقل قدر من الإضافات الضرورية فقط.`
    : "";

  // تنويع المطبخ: مرّر دليلاً موجزًا وتوجيهًا بعدم التكرار + بذرة تنويع
  const guide = CUISINE_GUIDES[cuisine] || `
- نوّع الأساليب داخل هذا المطبخ (تقنيات/أقاليم/نكهات) وتجنّب تكرار نفس الطبق أو العنوان.
- سمِّ العنوان بصيغة فريدة تتضمن التقنية أو النكهة الأساسية (مثال: "دجاج مشوي بالأعشاب الليمونية").`;

  const diversitySeed = Math.floor(Date.now() / 60000) % 9973; // بذرة تتغير كل دقيقة
  const diversityLines = `
[تنويع صارم]
- لا تكرر نفس الطبق/العنوان/التركيبة مع نفس المطبخ بين المحاولات.
- اختر كل مرة تقنية/منطقة/نكهة مختلفة من دليل المطبخ أدناه.
- اجعل العنوان فريدًا ويصف التقنية/النكهة الأساسية.
- diversity_seed=${diversitySeed}
[دليل المطبخ]
${guide}
`.trim();

  const dessertLine = isDessert(mealType)
    ? `تعليمات الحلويات: اجعل الوصفة بطعم حلو وقوام ممتع ضمن السعرات والقيود. يُسمح باستخدام **ستيفيا طبيعية نقية فقط وبحدود ضيقة** وخالية من أي إضافات صناعية. **ملاحظة:** ستيفيا ممنوعة مع "نظام د. محمد سعيد". ممنوع اللحوم/الدواجن/الأسماك والثوم/البصل والتوابل الحادة في الحلويات.`
    : "";

  const repairLine = __repair && isDrMoh
    ? "إصلاح: الإخراج السابق خالف قيود د. محمد سعيد. أعِد التوليد مع ≤ 5 جم كارب/حصة ودون أي محليات بما فيها ستيفيا."
    : "";

  const repairAvailLine = __repair_available && available.length
    ? "إصلاح: الإخراج السابق لم يضمّن كل المكونات المتاحة. أعِد التوليد وأدرجها جميعًا بأوزان جرام وبشكل منطقي."
    : "";

  const repairDessertLine = __repair_dessert && isDessert(mealType)
    ? "إصلاح: الحلويات السابقة غير منطقية (تحوي بروتينات لحم/توابل حادة أو افتقرت للطعم الحلو). أعِد التوليد بوصفة حلويات منطقية بطعم حلو، قوام ممتع، وبدون أي عناصر مالحة/حادة."
    : "";

  const repairDiversityLine = __repair_diversity
    ? "إصلاح تنويع: لا تعِد نفس الطبق أو العنوان. اختر أسلوبًا مختلفًا ومواد وتتبيلة مختلفة ضمن نفس المطبخ."
    : "";

  const customLine = isCustom && customMacros
    ? `استخدم هذه الماكروز **لكل حصة** حرفيًا: بروتين ${Number(customMacros.protein_g)} جم، كارب ${Number(customMacros.carbs_g)} جم، دهون ${Number(customMacros.fat_g)} جم. يجب أن يساوي حقل السعرات مجموع (بروتين×4 + كارب×4 + دهون×9) بدقة ±2%.`
    : "";

  return `
أنشئ وصفة ${isDessert(mealType) ? "حلويات" : mealType} من مطبخ ${cuisine} لنظام ${isDrMoh ? "نظام د. محمد سعيد" : dietType}.
السعرات المستهدفة للحصة: ${Number(caloriesTarget)}.
حساسيات يجب تجنبها: ${avoid}.
${focusLine}
${diversityLines}
${profile}
${drRules}
${availableLine}
${dessertLine}
${customLine}
${repairLine}
${repairAvailLine}
${repairDessertLine}
${repairDiversityLine}
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

/* ---------------- Dr. Mohamed + Available + Dessert/Diversity checks ---------------- */
const DR_MOH = /محمد\s*سعيد|dr_mohamed_saeed/;

function violatesDrMoh(recipe) {
  const carbs = Number(recipe?.macros?.carbs_g || 0);
  const ing = (recipe?.ingredients || []).join(" ").toLowerCase();

  const banned = [
    "سكر","sugar","عسل","honey","دبس","شراب","سيرب","glucose","fructose","corn syrup","hfcs",
    "لانشون","نقانق","سلامي","بسطرمة","مرتديلا","مصنع","معلبات","مرق","مكعبات",
    "msg","جلوتامات","glutamate","نتريت","نترات","ملون","نكهات صناعية","مواد حافظة","مستحلب",
    "مهدرج","مارجرين","زيت كانولا","زيت ذرة","زيت صويا","بذر العنب","vegetable oil",
    "دقيق أبيض","طحين أبيض","نشا الذرة","cornstarch","خبز","مكرونة","رز أبيض","سكر بني",
    "ستيفيا" // ممنوعة في نظام د. محمد سعيد
  ];

  const hasBanned = banned.some(k => ing.includes(k));
  const carbsOk = carbs <= 5;
  return (!carbsOk || hasBanned);
}

function includesAllAvailable(recipe, available) {
  if (!Array.isArray(available) || !available.length) return true;
  const ingJoined = (recipe?.ingredients || []).join(" ").toLowerCase();
  return available.every(a => {
    const term = String(a||"").toLowerCase().trim();
    return term && ingJoined.includes(term);
  });
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

  // Available ingredients (optional)
  const availableIngredients = Array.isArray(input?.availableIngredients)
    ? input.availableIngredients.map(s => String(s||"").trim()).filter(Boolean)
    : [];

  const wantDrMoh = DR_MOH.test(String(input?.dietType || ""));
  const wantDessert = isDessert(input?.mealType);

  const errors = {};
  for (const model of MODEL_POOL) {
    // محاولة أولى
    const r1 = await callOnce(model, { ...input, customMacros, availableIngredients });
    if (!r1.ok) { errors[model] = r1.error; continue; }

    // إصلاح د. محمد سعيد
    if (wantDrMoh && violatesDrMoh(r1.recipe)) {
      const r2 = await callOnce(model, { ...input, customMacros, availableIngredients, __repair: true });
      if (r2.ok && !violatesDrMoh(r2.recipe)) {
        // تحقق من المكوّنات المتاحة + منطق الحلويات
        if (availableIngredients.length && !includesAllAvailable(r2.recipe, availableIngredients)) {
          const r3a = await callOnce(model, { ...input, customMacros, availableIngredients, __repair: true, __repair_available: true });
          if (r3a.ok && !violatesDrMoh(r3a.recipe) && includesAllAvailable(r3a.recipe, availableIngredients)) {
            return ok({ recipe: r3a.recipe, model, note: "repaired_to_meet_dr_moh_rules" });
          }
        }
        if (wantDessert && dessertLooksIllogical(r2.recipe)) {
          const r3b = await callOnce(model, { ...input, customMacros, availableIngredients, __repair: true, __repair_dessert: true });
          if (r3b.ok && !violatesDrMoh(r3b.recipe) && (!wantDessert || !dessertLooksIllogical(r3b.recipe))) {
            return ok({ recipe: r3b.recipe, model, note: "repaired_to_meet_dr_moh_rules" });
          }
        }
        return ok({ recipe: r2.recipe, model, note: "repaired_to_meet_dr_moh_rules" });
      }
      const fallbackRecipe = r2.ok ? r2.recipe : r1.recipe;
      return ok({ recipe: fallbackRecipe, model, warning: "dr_moh_rules_not_strictly_met" });
    }

    // تحقق من المكوّنات المتاحة
    if (availableIngredients.length && !includesAllAvailable(r1.recipe, availableIngredients)) {
      const r2 = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_available: true });
      if (r2.ok && includesAllAvailable(r2.recipe, availableIngredients)) {
        // تحقق من منطق الحلويات
        if (wantDessert && dessertLooksIllogical(r2.recipe)) {
          const r2b = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_available: true, __repair_dessert: true });
          if (r2b.ok && includesAllAvailable(r2b.recipe, availableIngredients) && !dessertLooksIllogical(r2b.recipe)) {
            return ok({ recipe: r2b.recipe, model, note: "aligned_with_available_ingredients" });
          }
        }
        return ok({ recipe: r2.recipe, model, note: "aligned_with_available_ingredients" });
      }
      // لو فشل، استمر مع r1 لكن أعطِ تحذير
      if (wantDessert && dessertLooksIllogical(r1.recipe)) {
        const r2c = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_dessert: true, __repair_diversity: true });
        if (r2c.ok && (!wantDessert || !dessertLooksIllogical(r2c.recipe))) {
          return ok({ recipe: r2c.recipe, model, note: "diversified_and_dessert_fixed" });
        }
      }
      return ok({ recipe: r1.recipe, model, warning: "available_ingredients_not_fully_used" });
    }

    // تحقق من منطق الحلويات + تنويع (عنوان/أسلوب مختلف)
    if (wantDessert && dessertLooksIllogical(r1.recipe)) {
      const r2 = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_dessert: true });
      if (r2.ok && !dessertLooksIllogical(r2.recipe)) {
        return ok({ recipe: r2.recipe, model, note: "dessert_logic_repaired" });
      }
    }

    // تنويع إضافي عند تكرار العناوين (استدلال بسيط: عنوان عام جدًا أو مكرر الكلمات)
    const title = String(r1.recipe?.title||"").trim();
    const genericTitle = /^(حلوى|حلويات|سلطة|شوربة|طبق|وجبة)\s*$/i.test(title) || (title.split(/\s+/).filter(Boolean).length <= 1);
    if (genericTitle) {
      const r2 = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_diversity: true });
      if (r2.ok) return ok({ recipe: r2.recipe, model, note: "diversified_title_style" });
    }

    return ok({ recipe: r1.recipe, model });
  }

  return bad(502, "All models failed for your key/region on v1beta", { errors, tried: MODEL_POOL });
};
