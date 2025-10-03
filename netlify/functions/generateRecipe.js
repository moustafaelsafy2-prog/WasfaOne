// netlify/functions/generateRecipe.js
// UAE-ready — Arabic JSON schema, strict energy reconciliation (4/4/9),
// Dr. Mohamed Saeed path, cuisine diversity, desserts sanity,
// full diet profiles + custom macros + user-available ingredients.
// Energy correctness hardening + Embedded methodology (how to compute kcal/macros) and
// authoritative databases (USDA / CIQUAL / McCance) as compulsory internal guidance.
// Enhancements: Arabic normalization, grams-only enforcement, dessert positivity checks,
// mass–macros plausibility guard, available-ingredients sanitization, target-calorie tightening.
// NOTE: No change to public API or deployment flow.
// + NEW: Subscription enforcement by headers (x-auth-token & x-session-nonce), auto-suspend on expiry.
// + NEW: AI-only serving suggestions -> recipe.serving_suggestions:string[] (2–5 نقاط قصيرة)
// + NEW: Serving suggestions compliance filter for selected diet & allergies

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

/* ---------------- GitHub helpers for user auth / policy ---------------- */
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";

async function ghGetJson(path){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content), sha: data.sha };
}

async function ghPutJson(path, json, sha, message){
  const content = Buffer.from(JSON.stringify(json, null, 2), "utf-8").toString("base64");
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method:"PUT",
    headers:{ Authorization:`token ${GH_TOKEN}`, "User-Agent":"WasfaOne", "Content-Type":"application/json" },
    body: JSON.stringify({ message, content, sha, branch: REF })
  });
  if(!r.ok) throw new Error(`GitHub PUT ${path} ${r.status}`);
  return r.json();
}

function todayDubai(){
  const now = new Date();
  return now.toLocaleDateString("en-CA", { timeZone:"Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit" });
}
function withinWindow(start, end){
  const d = todayDubai();
  if(start && d < start) return false;
  if(end && d > end) return false;
  return true;
}

/* ---------------- HTTP helpers ---------------- */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Session-Nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

/* ---------------- Arabic normalization & utils ---------------- */
function toNum(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function round1(x){ return Math.round(x*10)/10; }
function clamp(x,min,max){ return Math.min(max, Math.max(min, x)); }

function normalizeArabic(s){
  if (typeof s !== "string") return "";
  return s
    .replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g,"") // tashkeel
    .replace(/\u0640/g,"") // tatweel
    .replace(/[إأآا]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه")
    .replace(/\s+/g," ").trim().toLowerCase();
}
function normalizeArrArabic(arr){
  return (Array.isArray(arr)?arr:[]).map(x => normalizeArabic(String(x||"")));
}

/* ---------------- Nutrition strict helpers ---------------- */
function normalizeMacros(macros){
  let p = clamp(round1(Math.max(0, toNum(macros?.protein_g))), 0, 200);
  let c = clamp(round1(Math.max(0, toNum(macros?.carbs_g))), 0, 200);
  let f = clamp(round1(Math.max(0, toNum(macros?.fat_g))), 0, 200);
  return { protein_g: p, carbs_g: c, fat_g: f };
}

function reconcileCalories(macros) {
  const orig = {
    protein_g: toNum(macros?.protein_g),
    carbs_g: toNum(macros?.carbs_g),
    fat_g: toNum(macros?.fat_g),
    calories: toNum(macros?.calories)
  };
  const m = normalizeMacros(orig);
  const calc = Math.round(m.protein_g*4 + m.carbs_g*4 + m.fat_g*9);
  const stated = orig.calories;
  const diff = stated>0 ? Math.abs(stated - calc) : calc;
  const pct = stated>0 ? diff / Math.max(1, calc) : 1;

  return {
    protein_g: m.protein_g,
    carbs_g: m.carbs_g,
    fat_g: m.fat_g,
    calories: calc,
    _energy_model: "4/4/9 strict",
    _energy_check: pct <= 0.02 ? "ok" : "adjusted_to_match_macros",
    _energy_delta_kcal: diff,
    _energy_delta_pct: Number.isFinite(pct) ? Math.round(pct*1000)/10 : 100
  };
}

/* grams-only enforcement */
const GRAM_RE = /\b\d+(\.\d+)?\s*(?:جم|غ|g|gram|grams|جرام|غرام)\b/i;
const NON_GRAM_UNITS_RE = /\b(?:مل|ml|مليلتر|l|ليتر|كوب|ملعقه(?:\s*(?:صغيره|كبيره))?|ملعقة(?:\s*(?:صغيرة|كبيرة))?|حبه|حبة|رشه|رش|قطره|ملم)\b/i;

function hasGramWeightLine(s){ return typeof s==="string" && GRAM_RE.test(s); }
function containsNonGramUnit(s){ return typeof s==="string" && NON_GRAM_UNITS_RE.test(normalizeArabic(s)); }
function enforceGramHints(ingredients){
  const arr = Array.isArray(ingredients) ? ingredients.slice() : [];
  return arr.map(x => (typeof x === "string" ? x.trim() : x));
}

/* total mass estimation from ingredient lines */
function parseIngredientMassG(line){
  if (typeof line !== "string") return 0;
  const m = line.match(/(\d+(?:\.\d+)?)\s*(?:جم|غ|g|gram|grams|جرام|غرام)\b/i);
  return m ? toNum(m[1]) : 0;
}
function totalMassG(ingredients){
  return (Array.isArray(ingredients)?ingredients:[]).reduce((acc, s)=> acc + parseIngredientMassG(String(s||"")), 0);
}

/* ---------------- Schema ---------------- */
function validateRecipeSchema(rec) {
  const must = ["title","servings","total_time_min","macros","ingredients","steps","lang","serving_suggestions"];
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

  // serving suggestions: 2–5 concise bullet points
  if (!Array.isArray(rec.serving_suggestions) || rec.serving_suggestions.length < 2 || rec.serving_suggestions.length > 5) {
    return { ok:false, error:"serving_suggestions_count_invalid" };
  }
  if (rec.serving_suggestions.some(x => typeof x !== "string" || !x.trim())) {
    return { ok:false, error:"serving_suggestions_type" };
  }

  // grams coverage (diagnostic) + forbid non-gram units
  const gramCount = rec.ingredients.filter(hasGramWeightLine).length;
  rec._ingredients_gram_coverage = `${gramCount}/${rec.ingredients.length}`;
  if (rec.ingredients.some(containsNonGramUnit)) {
    return { ok:false, error:"non_gram_unit_detected" };
  }
  return { ok:true };
}

/* ---------------- Cuisine Variety Guides ---------------- */
const CUISINE_GUIDES = {
  "شرق أوسطي": `
- بدّل بين لبناني/سوري/فلسطيني/أردني/عراقي/خليجي/يمني/تركي-حجازي.
- تقنيات: شَيّ/تحمير، طاجن، كبسة/مندي (لغير الحلويات)، تتبيل حمضي-عشبي.
- حلويات: لوز مطحون/جوز هند/كريمة/كاكاو خام/توت منخفض السكر؛ ستيفيا طبيعية نقية بحدود ضيقة حيث يسمح النظام.
`.trim(),
  "متوسطي (Mediterranean)": `
- نوّع بين يوناني/إسباني/إيطالي ريفي/فرنسي-بروفنسالي/تركي-إيجه.
- حلويات: زبادي كثيف/ماسكرپوني خفيف/مكسرات/توت، ستيفيا نقية بقدر محدود إن سُمح.
`.trim(),
  "مطبخ مصري": `
- ريفي/إسكندراني/صعيدي/منزلي؛ بدائل منخفضة كارب عند الحاجة.
- حلويات: قوام كريمي ومكسرات محمصة خفيفة؛ ستيفيا نقية فقط وبدون إضافات صناعية.
`.trim(),
  "هندي": `
- شمالي/جنوبي/كجراتي/بنغالي مع ضبط البهارات والكارب.
- حلويات: هيل/قرفة/فانيلا خفيفة؛ بدون توابل حادة.
`.trim(),
  "أمريكي": `
- مشاوي/داينر منزلي/كاليفورني صحي.
- حلويات: تشيزكيك خفيف/موس كاكاو خام؛ ستيفيا نقية بحدود ضيقة.
`.trim()
};

/* ---------------- Diet Profiles ---------------- */
const DIET_PROFILES = {
  dr_mohamed_saeed: `
- صافي الكربوهيدرات ≤ 5 جم/حصة كحد أقصى، أطعمة طبيعية غير مصنّعة.
- ممنوع كل السكريات والمحليات بما فيها ستيفيا.
- ممنوع المصنعات والإضافات (MSG/نترات/ألوان/نكهات/مستحلبات) والزيوت المكررة/المهدرجة.
- المسموح: زيت زيتون بكر، زبدة/سمن طبيعي، كريمة طبخ كاملة الدسم من أصل حيواني، أفوكادو، مكسرات نيئة، أعشاب وتوابل طبيعية.
  `.trim(),
  keto: `
- صافي كارب ≤ 10–12 جم/حصة، بروتين متوسط ودهون صحية.
- يُسمح للحلويات بستيفيا طبيعية نقية فقط وبحدود ضيقة وخالية من الإضافات الصناعية.
  `.trim(),
  high_protein: `
- بروتين مرتفع (≥ 25–35% طاقة)، ضبط كارب/دهون.
- حلويات ضمن السعرات: ستيفيا نقية قليلة وبلا إضافات صناعية.
  `.trim(),
  high_protein_keto: `
- كارب منخفض جدًا مع رفع البروتين وتقليل الدهون.
- الحلويات: ستيفيا نقية بقدر ضيق فقط.
  `.trim(),
  low_carb: `
- صافي كارب 15–35 جم/حصة؛ ألياف مرتفعة.
- الحلويات: ستيفيا نقية قليلة؛ بدون سكريات مضافة أو إضافات صناعية.
  `.trim(),
  atkins: `
- منخفض الكارب بمراحل؛ منع السكر والدقيق الأبيض.
- الحلويات: ستيفيا نقية بقدر محدود وخالية من الإضافات الصناعية.
  `.trim(),
  lchf: `
- كارب منخفض ودهون عالية الجودة.
- الحلويات: ستيفيا نقية قليلة؛ لا محليات صناعية.
  `.trim(),
  psmf: `
- بروتين عالٍ جدًا مع دهون وكارب ضئيلين.
- الحلويات: إن لزم فبستيفيا نقية بقدر ضئيل جدًا دون إضافات صناعية.
  `.trim(),
  low_fat: `
- دهون ≤ 20–30% من الطاقة؛ طهي قليل الدهون.
- الحلويات: ستيفيا نقية بحدود ضيقة بدل السكر؛ لا إضافات صناعية.
  `.trim(),
  balanced: `
- تقريب 40/30/30 بأطعمة كاملة.
- الحلويات: ستيفيا نقية بقدر محدود؛ لا سكريات مضافة ولا إضافات صناعية.
  `.trim(),
  mediterranean: `
- EVOO وخضار وبقوليات وحبوب كاملة وأسماك.
- الحلويات: فواكه منخفضة السكر ومكسرات؛ ستيفيا نقية بحدود ضيقة.
  `.trim(),
  vegan: `
- نباتي 100%.
- الحلويات: ستيفيا نباتية نقية (بدون مزج صناعي) وبقدر صغير.
  `.trim(),
  flexitarian: `
- نباتي غالبًا مع بروتين حيواني عالي الجودة عند الحاجة.
- الحلويات: ستيفيا نقية بحدود ضيقة.
  `.trim(),
  intermittent_fasting: `
- وجبة متوازنة ضمن نافذة الأكل.
- الحلويات: ستيفيا نقية قليلة إن لزم.
  `.trim(),
  carb_cycling: `
- أيام منخفضة/مرتفعة الكارب حسب اليوم.
- الحلويات: ستيفيا نقية قليلة (أيام منخفضة الكارب).
  `.trim(),
  dash: `
- خفض الصوديوم، رفع الخضار والفواكه.
- الحلويات: ستيفيا نقية بقدر ضيق، بلا إضافات صناعية.
  `.trim(),
  anti_inflammatory: `
- أوميغا-3 وتوابل مضادة للالتهاب، خفض السكريات والزيوت المكررة.
- الحلويات: ستيفيا نقية قليلة فقط.
  `.trim(),
  low_fodmap: `
- بدائل منخفضة FODMAP؛
- الحلويات: ستيفيا نقية غالبًا مناسبة؛ تجنّب خلطات بسكريات كحولية/إضافات صناعية.
  `.trim(),
  elimination: `
- استبعاد مسببات التحسس المحددة؛ مكونات أحادية المصدر.
- الحلويات: ستيفيا نقية قليلة فقط.
  `.trim(),
  renal: `
- راقب Na/K/P؛ بروتين معتدل.
- الحلويات: ستيفيا نقية قليلة؛ تجنّب بدائل عالية البوتاسيوم/الإضافات الصناعية.
  `.trim(),
  liver: `
- خفض السكريات والدهون المتحولة/المشبعة؛ رفع الألياف وأوميغا-3.
- الحلويات: ستيفيا نقية بقدر صغير فقط.
  `.trim(),
  pcos: `
- كارب منخفض/متوسط ذو جودة؛ بروتين كافٍ؛ دهون صحية.
- الحلويات: ستيفيا نقية قليلة؛ لا محليات صناعية.
  `.trim(),
  diabetes: `
- تحكّم دقيق بالكارب وجودته؛ ألياف عالية.
- الحلويات: ستيفيا نقية قليلة فقط؛ احسب صافي الكارب بدقة.
  `.trim(),
  metabolic_syndrome: `
- خفض السكريات والكارب المكرر؛ رفع الألياف والدهون غير المشبعة.
- الحلويات: ستيفيا نقية بقدر صغير فقط.
  `.trim()
};

/* ---------------- Dessert sanity ---------------- */
const DESSERT_SAVORY_BANNED = normalizeArrArabic([
  "لحم","دجاج","ديك رومي","لحم مفروم","سمك","تونة","سجق","نقانق","سلامي","بسطرمة","مرق",
  "ثوم","بصل","كركم","كمون","كزبرة ناشفة","بهارات كبسة","بهارات برياني","بهارات مشكلة","شطة","صلصة صويا","معجون طماطم"
]);
const DESSERT_SWEET_POSITIVE = normalizeArrArabic([
  "ستيفيا","فانيلا","كاكاو","زبدة الفول السوداني","قرفه","هيل","توت","فراوله","لبنه","زبادي","ماسكربوني","كريمه"
]);

function isDessert(mealType){ return /حلويات|تحليه|dessert/i.test(String(mealType||"")); }
function dessertLooksIllogical(recipe){
  const ingN = normalizeArabic((recipe?.ingredients||[]).join(" "));
  return DESSERT_SAVORY_BANNED.some(k => ingN.includes(k));
}
function dessertLacksSweetness(recipe){
  const ingN = normalizeArabic((recipe?.ingredients||[]).join(" "));
  return !DESSERT_SWEET_POSITIVE.some(k => ingN.includes(k));
}

/* ---------------- Serving suggestions compliance ---------------- */
const DIET_FAMILY_KETO = new Set(["keto","lchf","high_protein_keto","psmf","atkins","low_carb","dr_mohamed_saeed"]);
const HIGH_CARB_SIDES = normalizeArrArabic(["خبز","عيش","توست","رز","ارز","أرز","مكرونه","باستا","بطاطس","بطاطا","ذره","فشار","تمر","كعك","حلويات","سكر","عسل","كورن فليكس"]);
const SWEETENERS = normalizeArrArabic(["ستيفيا","سكر","محلي","شراب","سيرب","دبس","عسل"]);
const PROCESSED_OILS = normalizeArrArabic(["كانولا","صويا","ذره","بذر العنب","زيوت نباتيه","مهدرج","مارجرين"]);
const GLUTEN = normalizeArrArabic(["خبز","قمح","جلوتين","طحين","مكرونه","برغل","كسكس","شعير"]);
const DAIRY = normalizeArrArabic(["حليب","جبن","زبادي","لبن","قشده","كريمه","ماسكرپوني"]);
const NUTS = normalizeArrArabic(["مكسرات","لوز","فستق","كاجو","بندق","جوز"]);
const EGG = normalizeArrArabic(["بيض","بياض البيض","صفار"]);
const SEAFOOD = normalizeArrArabic(["سمك","تونه","روبيان","جمبري","سلمون","محار"]);
const SOY = normalizeArrArabic(["صويا","توفو","تمبيه","صلصه صويا"]);
function n(s){ return normalizeArabic(String(s||"")); }

function allergyBansFromUser(allergiesRaw){
  const s = n((Array.isArray(allergiesRaw)?allergiesRaw.join(" "):""));
  const bans = [];
  if (s.includes("جلوتين") || s.includes("قمح")) bans.push(...GLUTEN);
  if (s.includes("ألبان") || s.includes("البان") || s.includes("لاكتوز")) bans.push(...DAIRY);
  if (s.includes("مكسرات")) bans.push(...NUTS);
  if (s.includes("بيض")) bans.push(...EGG);
  if (s.includes("مأكولات بحريه") || s.includes("بحري")) bans.push(...SEAFOOD);
  if (s.includes("صويا")) bans.push(...SOY);
  return Array.from(new Set(bans));
}

function dietSpecificBans(dietType){
  const d = n(dietType);
  const bans = [];
  if (DIET_FAMILY_KETO.has(d)) bans.push(...HIGH_CARB_SIDES);
  if (d.includes("dr_mohamed_saeed") || d.includes("محمد سعيد")){
    bans.push(...SWEETENERS, ...PROCESSED_OILS, ...HIGH_CARB_SIDES);
  }
  if (d === "low_fat") {
    // نسمح "رشة زيت زيتون" لكن نتجنب عبارات تزيد الدهون أو زبدة/سمن
    bans.push(n("زبدة"), n("سمن"), n("قلي عميق"));
  }
  if (d === "vegan") bans.push(...DAIRY, ...EGG);
  if (d === "renal") bans.push(n("مخللات"), n("مرق مكعبات"));
  return Array.from(new Set(bans));
}

function isSuggestionAllowed(text, dietType, allergies){
  const t = n(text);
  // حظر خاص بالنظام
  const bans = new Set([...dietSpecificBans(dietType), ...allergyBansFromUser(allergies)]);
  for (const b of bans){ if (b && t.includes(b)) return false; }
  // منع اقتراح مكونات مصنعة/محليات في "د. محمد سعيد"
  if ((n(dietType).includes("محمد سعيد") || n(dietType).includes("dr_mohamed_saeed")) && SWEETENERS.some(sw => t.includes(sw))) return false;
  return true;
}

function filterServingSuggestions(servingArr, dietType, allergies){
  const arr = Array.isArray(servingArr) ? servingArr : [];
  const cleaned = arr.map(s => String(s||"").trim()).filter(Boolean);
  const allowed = cleaned.filter(s => isSuggestionAllowed(s, dietType, allergies));
  // إزالة التكرارات بعد التطبيع
  const uniq = [];
  const seen = new Set();
  for (const s of allowed){
    const key = n(s);
    if (!seen.has(key)){ seen.add(key); uniq.push(s); }
  }
  return uniq.slice(0,5);
}

/* ---------------- Prompting ---------------- */
function systemInstruction(maxSteps = 10) {
  return `
أنت شيف محترف وخبير تغذية. أعد **JSON فقط** وفق المخطط أدناه — دون أي نص خارج القوسين المعقوفين:
{
  "title": string,
  "servings": number,
  "total_time_min": number,
  "macros": { "protein_g": number, "carbs_g": number, "fat_g": number, "calories": number },
  "ingredients": string[],
  "steps": string[],  // الحد الأقصى ${maxSteps} خطوات قصيرة وواضحة
  "serving_suggestions": string[], // 2–5 نقاط تقديم قصيرة، عملية، مناسبة للمطبخ والنظام الغذائي
  "lang": "ar"
}

[قواعد إلزامية لا تقبل التجاوز]
1) اللغة: العربية الفصحى فقط، لا تكتب أي شرح خارج JSON.
2) القياسات: **كل المكونات بالجرام 100%** (وزن نيّئ) بما فيها الزيوت/التوابل. ممنوع "كوب/ملعقة/مل/حبة".
3) الماكروز:
   - protein_g = جرام البروتين الفعلي.
   - carbs_g = **صافي الكربوهيدرات فقط**.
   - fat_g = جرام الدهون.
4) السعرات (Calories) = (protein_g×4 + carbs_g×4 + fat_g×9) بدقة ±2% كحد أقصى. عند التعارض اضبط calories ليتطابق الحساب.
5) الالتزام بالأنظمة/الحساسيات/المكوّنات المتاحة حرفيًا.
6) المكوّنات: عناصر قصيرة بالشكل "200 جم صدر دجاج".
7) الخطوات: أوامر عملية واضحة، ≤ ${maxSteps} خطوات.
8) التنويع: لا تكرار.
9) الحلويات: طعم حلو منطقي ضمن القيود. ستيفيا **نقية فقط** وممنوعة في "نظام د. محمد سعيد".
10) قواعد بيانات التغذية: USDA/CIQUAL/McCance (داخليًا).
11) الأرقام: أعداد فقط.
12) **طريقة التقديم**:
    - اكتب 2–5 نقاط قصيرة عملية مناسبة للمطبخ **ومتوافقة بدقة مع النظام الغذائي والحساسيات** (لا خبز/أرز/مكرونة أو محليات عند عدم السماح، إلخ).

أعد الإخراج وفق المخطط حرفيًا وبالعربية فقط.
`.trim();
}

function sanitizeAvailableList(list){
  const arr = Array.isArray(list) ? list : [];
  return Array.from(new Set(
    arr.map(s => String(s||"")
      .replace(/[{}\[\]<>:;"/\\|`~]/g," ")
      .replace(/\s+/g," ")
      .trim()
    ).filter(Boolean)
  ));
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
    __repair_diversity = false,
    __repair_energy = false,
    __repair_units = false,
    __repair_target = false,
    __repair_serving = false
  } = input || {};

  const avoid = (Array.isArray(allergies) && allergies.length) ? allergies.join(", ") : "لا شيء";
  const focusLine = focus ? `تركيز خاص: ${focus}.` : "";

  const isDrMoh = /dr_mohamed_saeed|محمد\s*سعيد/i.test(String(dietType));
  const isCustom = String(dietType) === "custom";

  const profile = DIET_PROFILES[dietType] || "";
  const drRules = isDrMoh ? DIET_PROFILES["dr_mohamed_saeed"] : "";

  const available = sanitizeAvailableList(availableIngredients);

  const availableLine = available.length
    ? `«مكونات المستخدم (أسماء فقط)»: ${available.join(", ")}.
- استخدم هذه المكوّنات كأساس الوصفة قدر الإمكان وأدرجها جميعًا بأوزان جرام دقيقة.
- لا تضف إلا الضروري تقنيًا أو لضبط الماكروز (ماء/ملح/فلفل/توابل/زيت زيتون بكر).`
    : "";

  const guide = CUISINE_GUIDES[cuisine] || `
- نوّع الأساليب داخل هذا المطبخ (تقنيات/أقاليم/نكهات) وتجنّب تكرار نفس الطبق.
- اجعل العنوان فريدًا ويصف التقنية/النكهة الأساسية.`;

  const diversitySeed = Math.floor(Date.now()/60000)%9973;
  const diversityLines = `
[تنويع صارم] diversity_seed=${diversitySeed}
- لا تكرر نفس الطبق/العنوان/التركيبة مع نفس المطبخ بين المحاولات.
[دليل المطبخ]
${guide}
`.trim();

  const dessertLine = isDessert(mealType)
    ? `تعليمات الحلويات: اجعل الوصفة بطعم حلو وقوام ممتع ضمن السعرات والقيود. ستيفيا **طبيعية نقية فقط** وبحدود ضيقة وخالية من أي إضافات صناعية، وممنوعة مع "نظام د. محمد سعيد".`
    : "";

  const repairLines = [
    __repair && isDrMoh ? "إصلاح: ≤ 5 جم صافي كارب/حصة، لا أي محليات بما فيها ستيفيا." : "",
    __repair_available && available.length ? "إصلاح: ضمّن كل المكونات المتاحة بأوزان جرام وبشكل منطقي." : "",
    __repair_dessert && isDessert(mealType) ? "إصلاح: الحلويات السابقة غير منطقية/ليست حلوة. أعِد التوليد بوصفة حلوى منطقية." : "",
    __repair_diversity ? "إصلاح تنويع: غيّر الأسلوب/العنوان/النكهة وتجنّب أي تكرار." : "",
    __repair_energy ? "إصلاح طاقة: اضبط الماكروز بحيث يطابق calories حساب 4/4/9 (±2%)." : "",
    __repair_units ? "إصلاح وحدات: استخدم الجرام فقط لكل المكونات." : "",
    __repair_target ? `إصلاح سعرات: قرب السعرات من الهدف ${Number(caloriesTarget)} kcal ضمن ±12%.` : "",
    __repair_serving ? "إصلاح طريقة التقديم: أعد 2–5 نقاط تقديم قصيرة متوافقة بدقة مع النظام والحساسيات والمطبخ (لا عناصر محظورة)." : ""
  ].filter(Boolean).join("\n");

  const customLine = isCustom && customMacros
    ? `استخدم هذه الماكروز **لكل حصة** حرفيًا: بروتين ${Number(customMacros.protein_g)} جم، كارب ${Number(customMacros.carbs_g)} جم (صافي)، دهون ${Number(customMacros.fat_g)} جم. يجب أن يساوي حقل السعرات (بروتين×4 + كارب×4 + دهون×9).`
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
${repairLines}
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
    generationConfig: { temperature: 0.4, topP: 0.9, maxOutputTokens: 1200 },
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

    // Defaults & cleanup
    if (!json.lang) json.lang = "ar";
    if (Array.isArray(json.steps) && json.steps.length > 10) {
      const chunk = Math.ceil(json.steps.length / 10);
      const merged = [];
      for (let i=0;i<json.steps.length;i+=chunk) merged.push(json.steps.slice(i,i+chunk).join(" ثم "));
      json.steps = merged.slice(0,6);
    }
    if (Array.isArray(json.ingredients)) json.ingredients = enforceGramHints(json.ingredients);
    if (!Array.isArray(json.serving_suggestions)) json.serving_suggestions = [];
    else json.serving_suggestions = json.serving_suggestions.map(s=>String(s||"").trim()).filter(Boolean).slice(0,5);

    // Energy strict
    if (json.macros) json.macros = reconcileCalories(json.macros);

    const v = validateRecipeSchema(json);
    if (!v.ok) return { ok:false, error:`schema_validation_failed:${v.error}` };

    return { ok:true, recipe: json };
  } catch (e) {
    return { ok:false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- Policy & plausibility checks ---------------- */
const DR_MOH = /محمد\s*سعيد|dr_mohamed_saeed/i;

function violatesDrMoh(recipe) {
  const carbs = toNum(recipe?.macros?.carbs_g || 0);
  const ing = normalizeArabic((recipe?.ingredients || []).join(" "));
  const banned = normalizeArrArabic([
    "سكر","sugar","عسل","honey","دبس","شراب","سيرب","glucose","fructose","corn syrup","hfcs",
    "لانشون","نقانق","سلامي","بسطرمه","مرتديلا","مصنع","معلبات","مرق","مكعبات",
    "msg","جلوتامات","glutamate","نتريت","نترات","ملون","نكهات صناعيه","مواد حافظه","مستحلب",
    "مهدرج","مارجرين","زيت كانولا","زيت ذره","زيت صويا","بذر العنب","vegetable oil",
    "دقيق ابيض","طحين ابيض","نشا الذره","cornstarch","خبز","مكرونه","رز ابيض","سكر بني",
    "ستيفيا" // ممنوعة
  ]);
  const hasBanned = banned.some(k => ing.includes(k));
  const carbsOk = carbs <= 5;
  return (!carbsOk || hasBanned);
}

function includesAllAvailable(recipe, availableRaw) {
  const available = sanitizeAvailableList(availableRaw);
  if (!available.length) return true;
  const ing = " " + normalizeArabic((recipe?.ingredients || []).join(" ")) + " ";
  return available.every(a => {
    const term = normalizeArabic(a);
    return term && ing.includes(" " + term + " ");
  });
}

function energyLooksOff(recipe){
  const m = recipe?.macros||{};
  const p = toNum(m.protein_g), c = toNum(m.carbs_g), f = toNum(m.fat_g), cal = toNum(m.calories);
  const calc = Math.round(p*4 + c*4 + f*9);
  return Math.abs(calc - cal) > Math.max(8, Math.round(calc*0.02));
}
function unitsLookOff(recipe){ return (recipe?.ingredients||[]).some(containsNonGramUnit); }
function titleTooGeneric(recipe){
  const title = String(recipe?.title||"").trim();
  return /^(حلوى|حلويات|سلطه|سلطة|شوربه|شوربة|طبق|وجبه|وجبة)\s*$/i.test(title) || (title.split(/\s+/).filter(Boolean).length <= 1);
}
function targetCaloriesFar(recipe, target){
  const cal = toNum(recipe?.macros?.calories||0);
  if (!target || target<=0) return false;
  const diffPct = Math.abs(cal - target) / target;
  return diffPct > 0.12;
}
function macrosVsMassImplausible(recipe){
  const mass = totalMassG(recipe?.ingredients||[]);
  if (mass <= 0) return false;
  const p = toNum(recipe?.macros?.protein_g), c = toNum(recipe?.macros?.carbs_g), f = toNum(recipe?.macros?.fat_g);
  if (p > mass*0.4) return true;
  if (f > mass*0.6) return true;
  if (c > mass*0.9) return true;
  const cal = toNum(recipe?.macros?.calories);
  if (cal > mass*9*1.05) return true;
  return false;
}

/* ---------------- Subscription gate (unchanged) ---------------- */
async function ensureActiveSubscription(event) {
  const token = event.headers["x-auth-token"] || event.headers["X-Auth-Token"];
  const nonce = event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"];
  if (!token || !nonce) return { ok:false, code:401, msg:"unauthorized" };

  const { json: users, sha } = await ghGetJson(USERS_PATH);
  const idx = (users||[]).findIndex(u => (u.auth_token||"") === token);
  if (idx === -1) return { ok:false, code:401, msg:"unauthorized" };

  const user = users[idx];
  if ((user.session_nonce||"") !== nonce) return { ok:false, code:401, msg:"bad_session" };

  const today = todayDubai();
  if (user.end_date && today > user.end_date) {
    user.status = "suspended";
    user.lock_reason = "expired";
    users[idx] = user;
    await ghPutJson(USERS_PATH, users, sha, `generate: auto-suspend expired ${user.email}`);
    return { ok:false, code:403, msg:"subscription_expired" };
  }

  if ((String(user.status||"").toLowerCase() !== "active") || !withinWindow(user.start_date, user.end_date)) {
    return { ok:false, code:403, msg:"inactive_or_out_of_window" };
  }

  return { ok:true };
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  // Subscription enforcement
  try {
    const gate = await ensureActiveSubscription(event);
    if (!gate.ok) return bad(gate.code, gate.msg);
  } catch (e) {
    return bad(500, "subscription_gate_error");
  }

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

  // Available ingredients (optional) — sanitized
  const availableIngredients = Array.isArray(input?.availableIngredients)
    ? sanitizeAvailableList(input.availableIngredients)
    : [];

  const wantDrMoh = DR_MOH.test(String(input?.dietType || ""));
  const wantDessert = isDessert(input?.mealType);
  const caloriesTarget = Number(input?.caloriesTarget)||0;

  const allergies = Array.isArray(input?.allergies) ? input.allergies : [];

  const errors = {};
  for (const model of MODEL_POOL) {
    // 1st pass
    const r1 = await callOnce(model, { ...input, customMacros, availableIngredients });
    if (!r1.ok) { errors[model] = r1.error; continue; }

    let rec = r1.recipe;

    // Ensure serving_suggestions present
    if (!Array.isArray(rec.serving_suggestions) || rec.serving_suggestions.length < 2) {
      const rServing = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_serving: true, __repair_energy: true, __repair_units: true });
      if (rServing.ok) rec = rServing.recipe;
    }

    // grams-only enforcement
    if (unitsLookOff(rec)) {
      const rUnits = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_units: true });
      if (rUnits.ok) rec = rUnits.recipe;
    }

    // Dr. Mohamed enforcement
    if (wantDrMoh && violatesDrMoh(rec)) {
      const r2 = await callOnce(model, { ...input, customMacros, availableIngredients, __repair: true, __repair_energy: true, __repair_units: true, __repair_serving: true });
      if (r2.ok && !violatesDrMoh(r2.recipe)) rec = r2.recipe;
      else return ok({ recipe: r2.ok ? r2.recipe : rec, model, warning: "dr_moh_rules_not_strictly_met" });
    }

    // Available-ingredients enforcement
    if (availableIngredients.length && !includesAllAvailable(rec, availableIngredients)) {
      const rAvail = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_available: true, __repair_energy: true, __repair_units: true, __repair_serving: true });
      if (rAvail.ok && includesAllAvailable(rAvail.recipe, availableIngredients)) rec = rAvail.recipe;
      else return ok({ recipe: rAvail.ok ? rAvail.recipe : rec, model, warning: "available_ingredients_not_fully_used" });
    }

    // Dessert sanity
    if (wantDessert && (dessertLooksIllogical(rec) || (!wantDrMoh && dessertLacksSweetness(rec)))) {
      const rDess = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_dessert: true, __repair_energy: true, __repair_units: true, __repair_serving: true });
      if (rDess.ok && !dessertLooksIllogical(rDess.recipe) && (!wantDrMoh ? !dessertLacksSweetness(rDess.recipe) : true)) {
        rec = rDess.recipe;
      }
    }

    // Energy strictness
    if (energyLooksOff(rec)) {
      const rEnergy = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_energy: true, __repair_serving: true });
      if (rEnergy.ok && !energyLooksOff(rEnergy.recipe)) rec = rEnergy.recipe;
    }

    // Calories target tightening
    if (caloriesTarget && targetCaloriesFar(rec, caloriesTarget)) {
      const rTarget = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_target: true, __repair_energy: true, __repair_serving: true });
      if (rTarget.ok && !targetCaloriesFar(rTarget.recipe, caloriesTarget)) rec = rTarget.recipe;
    }

    // Mass–macros plausibility
    if (macrosVsMassImplausible(rec)) {
      const rMass = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_energy: true, __repair_units: true, __repair_serving: true });
      if (rMass.ok && !macrosVsMassImplausible(rMass.recipe)) rec = rMass.recipe;
    }

    // Diversify generic titles
    if (titleTooGeneric(rec)) {
      const rDiv = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_diversity: true, __repair_energy: true, __repair_serving: true });
      if (rDiv.ok) rec = rDiv.recipe;
    }

    // Final normalize
    rec.macros = reconcileCalories(rec.macros);
    if (Array.isArray(rec.ingredients)) rec.ingredients = enforceGramHints(rec.ingredients);

    // ---- NEW: Final serving_suggestions compliance filter ----
    rec.serving_suggestions = filterServingSuggestions(rec.serving_suggestions, String(input?.dietType||"").trim(), allergies);

    // If became <2, repair once to regenerate compliant suggestions, then filter again
    if (!Array.isArray(rec.serving_suggestions) || rec.serving_suggestions.length < 2) {
      const rServe2 = await callOnce(model, { ...input, customMacros, availableIngredients, __repair_serving: true });
      if (rServe2.ok) {
        const fixed = filterServingSuggestions(rServe2.recipe.serving_suggestions, String(input?.dietType||"").trim(), allergies);
        if (fixed.length >= 2) rec.serving_suggestions = fixed.slice(0,5);
        else rec.serving_suggestions = fixed.length ? fixed : ["قدّم دافئًا.","زيّن بأعشاب طازجة."]; // لن يصل لهذا غالبًا
      }
    }

    return ok({ recipe: rec, model });
  }

  return bad(502, "All models failed for your key/region on v1beta", { errors, tried: MODEL_POOL });
};

/*
Citations (context compatibility):
:contentReference[oaicite:0]{index=0}
:contentReference[oaicite:1]{index=1}
:contentReference[oaicite:2]{index=2}
*/
