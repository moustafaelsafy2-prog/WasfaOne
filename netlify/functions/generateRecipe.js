// netlify/functions/generateRecipe.js
// High-Standard Full Rewrite (Arabic-first, UAE-ready)
// - Stable Gemini call path (no protocol changes)
// - Strict 4/4/9 energy reconciliation & grams-only enforcement
// - Diversity engine (historical index + in-batch guards + rejection sampling)
// - Optional multi-plan generation (planSize) without breaking single recipe API
// - Serving suggestions compliance + dessert sanity
// - Subscription enforcement (GitHub users.json) + auto suspend on expiry
// - Security: CORS whitelist, safe headers, minimal GH scopes (repo:contents)
// - Reliability: model race with circuit breaker + selective retry
// - Observability: structured logs, request IDs, ETag, idempotency cache
// - Business guardrails: allergy cross-check, available-ingredients sanitization
//
// NOTE: Keep ENV vars configured: GEMINI_API_KEY, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_TOKEN, GITHUB_REF (optional), CORS_ORIGINS (comma-separated)

"use strict";

/* -------------------- Config -------------------- */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
let   MODEL_POOL = [
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

const OWNER   = process.env.GITHUB_REPO_OWNER;
const REPO    = process.env.GITHUB_REPO_NAME;
const REF     = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API   = "https://api.github.com";
const USERS_PATH         = "data/users.json";
const RECIPES_INDEX_PATH = "data/recipes_index.json";

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
const HEADERS_BASE = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": (ALLOWED_ORIGINS[0] || "https://your.app"),
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Session-Nonce, X-Idempotency-Key",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj, extraHeaders={}) => ({ statusCode: code, headers: { ...HEADERS_BASE, ...extraHeaders }, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok:false, error, ...extra });
const ok  = (payload, extraHeaders={}) => jsonRes(200, { ok:true, ...payload }, extraHeaders);

/* -------------------- Utilities -------------------- */
function safeHeader(h){ return String(h||"").replace(/[^a-zA-Z0-9:_-]/g,"").slice(0,128); }
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
function toNum(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function round1(x){ return Math.round(x*10)/10; }
function clamp(x,min,max){ return Math.min(max, Math.max(min, x)); }
function normalizeArabic(s){
  if (typeof s !== "string") return "";
  return s
    .replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g,"")
    .replace(/\u0640/g,"")
    .replace(/[إأآا]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه")
    .replace(/\s+/g," ").trim().toLowerCase();
}
function normalizeArrArabic(arr){
  return (Array.isArray(arr)?arr:[]).map(x => normalizeArabic(String(x||"")));
}

/* -------------------- GitHub helpers -------------------- */
async function ghGetJson(path){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
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
async function loadRecipesIndex(){
  try{ const { json, sha } = await ghGetJson(RECIPES_INDEX_PATH); return { index: json||{}, sha }; }
  catch{ return { index:{}, sha:null }; }
}
async function saveRecipesIndex(index, sha, message){
  return ghPutJson(RECIPES_INDEX_PATH, index, sha, message);
}

/* -------------------- Observability -------------------- */
function newReqId(){ return Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4); }
function logInfo(obj){ console.log(JSON.stringify({ level:"info", ...obj })); }
function logWarn(obj){ console.warn(JSON.stringify({ level:"warn", ...obj })); }
function logErr(obj){ console.error(JSON.stringify({ level:"error", ...obj })); }

/* -------------------- Nutrition helpers -------------------- */
function normalizeMacros(macros){
  let p = clamp(round1(Math.max(0, toNum(macros?.protein_g))), 0, 200);
  let c = clamp(round1(Math.max(0, toNum(macros?.carbs_g))), 0, 200);
  let f = clamp(round1(Math.max(0, toNum(macros?.fat_g))), 0, 200);
  return { protein_g: p, carbs_g: c, fat_g: f };
}
function reconcileCalories(macros) {
  const m = normalizeMacros(macros||{});
  const calc = Math.round(m.protein_g*4 + m.carbs_g*4 + m.fat_g*9);
  return {
    protein_g: m.protein_g,
    carbs_g: m.carbs_g,
    fat_g: m.fat_g,
    calories: Math.round(calc/5)*5, // stable rounding
    _energy_model: "4/4/9 strict",
    _energy_check: "ok",
    _energy_delta_kcal: 0,
    _energy_delta_pct: 0
  };
}
const GRAM_RE = /\b\d+(\.\d+)?\s*(?:جم|غ|g|gram|grams|جرام|غرام)\b/i;
const NON_GRAM_UNITS_RE = /\b(?:مل|ml|مليلتر|l|ليتر|كوب|ملعقه(?:\s*(?:صغيره|كبيره))?|ملعقة(?:\s*(?:صغيرة|كبيرة))?|حبه|حبة|رشه|رش|قطره|ملم)\b/i;
function hasGramWeightLine(s){ return typeof s==="string" && GRAM_RE.test(s); }
function containsNonGramUnit(s){ return typeof s==="string" && NON_GRAM_UNITS_RE.test(normalizeArabic(s)); }
function enforceGramHints(ingredients){
  const arr = Array.isArray(ingredients) ? ingredients.slice() : [];
  return arr.map(x => (typeof x === "string" ? x.trim() : x));
}
function parseIngredientMassG(line){
  if (typeof line !== "string") return 0;
  const m = line.match(/(\d+(?:\.\d+)?)\s*(?:جم|غ|g|gram|grams|جرام|غرام)\b/i);
  return m ? toNum(m[1]) : 0;
}
function totalMassG(ingredients){
  return (Array.isArray(ingredients)?ingredients:[]).reduce((acc, s)=> acc + parseIngredientMassG(String(s||"")), 0);
}

/* -------------------- Schema -------------------- */
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
  if (!Array.isArray(rec.ingredients) || rec.ingredients.some(x => typeof x !== "string")) return { ok:false, error:"ingredients_type" };
  if (!Array.isArray(rec.steps) || rec.steps.some(x => typeof x !== "string")) return { ok:false, error:"steps_type" };
  if (rec.lang !== "ar") return { ok:false, error:"lang_must_be_ar" };
  const gramCount = rec.ingredients.filter(hasGramWeightLine).length;
  rec._ingredients_gram_coverage = `${gramCount}/${rec.ingredients.length}`;
  if (rec.ingredients.some(containsNonGramUnit)) return { ok:false, error:"non_gram_unit_detected" };
  if (!Array.isArray(rec.serving_suggestions) || rec.serving_suggestions.length < 2 || rec.serving_suggestions.length > 5) {
    return { ok:false, error:"serving_suggestions_count_invalid" };
  }
  if (rec.serving_suggestions.some(x => typeof x !== "string" || !x.trim())) {
    return { ok:false, error:"serving_suggestions_type" };
  }
  return { ok:true };
}

/* -------------------- Cuisine guides -------------------- */
const CUISINE_GUIDES = {
  "شرق أوسطي": `- بدّل بين لبناني/سوري/فلسطيني/أردني/عراقي/خليجي/يمني/تركي-حجازي.\n- تقنيات: شَيّ/تحمير، طاجن، كبسة/مندي (لغير الحلويات)، تتبيل حمضي-عشبي.\n- حلويات: لوز/جوز هند/كريمة/كاكاو/توت منخفض السكر؛ ستيفيا نقية بحدود حيث يسمح النظام.`,
  "متوسطي (Mediterranean)": `- نوّع بين يوناني/إسباني/إيطالي ريفي/فرنسي-بروفنسالي/تركي-إيجه.\n- حلويات: زبادي كثيف/ماسكرپوني خفيف/مكسرات/توت (ستيفيا نقية إن سُمح).`,
  "مطبخ مصري": `- ريفي/إسكندراني/صعيدي/منزلي؛ بدائل منخفضة كارب عند الحاجة.\n- حلويات: قوام كريمي/مكسرات محمصة خفيفة؛ ستيفيا نقية فقط.`,
  "هندي": `- شمالي/جنوبي/كجراتي/بنغالي مع ضبط البهارات والكارب.\n- حلويات: هيل/قرفة/فانيلا؛ بدون توابل حادة.`,
  "أمريكي": `- مشاوي/داينر منزلي/كاليفورني صحي.\n- حلويات: تشيزكيك خفيف/موس كاكاو؛ ستيفيا نقية حيث يُسمح.`
};

/* -------------------- Diet profiles -------------------- */
const DIET_PROFILES = {
  dr_mohamed_saeed: `- صافي الكارب ≤ 5 جم/حصة، أطعمة طبيعية.\n- ممنوع كل السكريات والمحليات بما فيها ستيفيا.\n- ممنوع المصنعات والإضافات والزيوت المكررة.\n- المسموح: زيت زيتون بكر، زبدة/سمن طبيعي، كريمة دسم حيواني، أفوكادو، مكسرات نيئة.`,
  keto: `- صافي كارب ≤ 10–12 جم/حصة، بروتين متوسط ودهون صحية.\n- الحلويات بستيفيا نقية فقط وبحدود ضيقة.`,
  high_protein: `- بروتين ≥ 25–35% طاقة، ضبط كارب/دهون.\n- ستيفيا نقية قليلة فقط.`,
  high_protein_keto: `- كارب منخفض جدًا + بروتين أعلى، دهون أقل.\n- ستيفيا نقية قليلة.`,
  low_carb: `- صافي كارب 15–35 جم/حصة؛ ألياف مرتفعة.\n- لا سكريات مضافة.`,
  atkins: `- منخفض الكارب بمراحل؛ منع السكر والدقيق الأبيض.`,
  lchf: `- كارب منخفض ودهون عالية الجودة.`,
  psmf: `- بروتين عالٍ جدًا مع كارب/دهون ضئيلين.`,
  low_fat: `- دهون ≤ 20–30% طاقة؛ طهي قليل الدهون.`,
  balanced: `- تقريب 40/30/30 بأطعمة كاملة.`,
  mediterranean: `- EVOO وخضار وبقوليات وحبوب وأسماك.\n- حلويات فواكه منخفضة السكر/مكسرات؛ ستيفيا محدودة.`,
  vegan: `- نباتي 100%.`,
  flexitarian: `- نباتي غالبًا مع بروتين حيواني عالي الجودة عند الحاجة.`,
  intermittent_fasting: `- وجبة متوازنة ضمن نافذة الأكل.`,
  carb_cycling: `- أيام منخفضة/مرتفعة الكارب.`,
  dash: `- خفض الصوديوم، رفع الخضار والفواكه.`,
  anti_inflammatory: `- أوميغا-3 وتوابل مضادة للالتهاب.`,
  low_fodmap: `- بدائل منخفضة FODMAP.`,
  elimination: `- استبعاد مسببات التحسس المحددة.`,
  renal: `- راقب Na/K/P؛ بروتين معتدل.`,
  liver: `- خفض السكريات والدهون المتحولة؛ ألياف/أوميغا-3.`,
  pcos: `- كارب منخفض/متوسط ذو جودة؛ بروتين كافٍ؛ دهون صحية.`,
  diabetes: `- تحكّم دقيق بالكارب وجودته؛ ألياف عالية.`,
  metabolic_syndrome: `- خفض السكريات والكارب المكرر؛ دهون غير مشبعة.`
};

/* -------------------- Dessert sanity -------------------- */
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

/* -------------------- Serving suggestions compliance -------------------- */
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
  if (d === "low_fat") bans.push(n("زبدة"), n("سمن"), n("قلي عميق"));
  if (d === "vegan") bans.push(...DAIRY, ...EGG);
  if (d === "renal") bans.push(n("مخللات"), n("مرق مكعبات"));
  return Array.from(new Set(bans));
}
function isSuggestionAllowed(text, dietType, allergies){
  const t = n(text);
  const bans = new Set([...dietSpecificBans(dietType), ...allergyBansFromUser(allergies)]);
  for (const b of bans){ if (b && t.includes(b)) return false; }
  if ((n(dietType).includes("محمد سعيد") || n(dietType).includes("dr_mohamed_saeed")) && SWEETENERS.some(sw => t.includes(sw))) return false;
  return true;
}
function filterServingSuggestions(servingArr, dietType, allergies){
  const arr = Array.isArray(servingArr) ? servingArr : [];
  const cleaned = arr.map(s => String(s||"").trim()).filter(Boolean);
  const allowed = cleaned.filter(s => isSuggestionAllowed(s, dietType, allergies));
  const uniq = []; const seen = new Set();
  for (const s of allowed){ const key = n(s); if (!seen.has(key)){ seen.add(key); uniq.push(s); } }
  return uniq.slice(0,5);
}

/* -------------------- Diversity Engine -------------------- */
const DIVERSITY_DEFAULTS = { lookbackDays: 14, minTitleDistance: 0.35, maxIngredientJaccard: 0.55 };
function slugifyArabicTitle(s){
  const t = normalizeArabic(String(s||""));
  return t.replace(/[^a-z0-9\u0621-\u064A]+/g,"-").replace(/^-+|-+$/g,"");
}
function tokenizeIngredients(ings){
  const bag = new Set();
  for(const line of (Array.isArray(ings)?ings:[])){
    const nline = normalizeArabic(String(line||""));
    nline.split(/\s+/).forEach(tok=>{
      if(tok.length>=3 && !/^\d+$/.test(tok)) bag.add(tok);
    });
  }
  return bag;
}
function jaccard(aSet,bSet){
  const a = new Set(aSet), b = new Set(bSet);
  const inter = [...a].filter(x=>b.has(x)).length;
  const uni = new Set([...a,...b]).size || 1;
  return inter/uni;
}
function titleSimilarity(a,b){ // 1=very similar .. 0=different
  const A = slugifyArabicTitle(a), B = slugifyArabicTitle(b);
  const la=A.length, lb=B.length; if(!la||!lb) return 0;
  const dp = Array.from({length:la+1},()=>Array(lb+1).fill(0));
  for(let i=0;i<=la;i++) dp[i][0]=i; for(let j=0;j<=lb;j++) dp[0][j]=j;
  for(let i=1;i<=la;i++){ for(let j=1;j<=lb;j++){
    const cost = A[i-1]===B[j-1]?0:1;
    dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+cost);
  }}
  const lev=dp[la][lb]; return 1-(lev/Math.max(la,lb));
}
function proteinFamilyFromIngredients(ings){
  const n = normalizeArabic((ings||[]).join(" "));
  if(n.includes("دجاج")) return "chicken";
  if(n.includes("لحم")) return "beef";
  if(n.includes("ديك رومي")) return "turkey";
  if(n.includes("سمك")||n.includes("سلمون")||n.includes("تونه")) return "fish";
  if(n.includes("بيض")) return "egg";
  if(n.includes("جبن")||n.includes("زبادي")||n.includes("لبنه")) return "dairy";
  if(n.includes("حمص")||n.includes("فول")||n.includes("عدس")) return "legume";
  return "other";
}
function withinDays(dateStr, days){
  try{
    const d = new Date(dateStr+"T00:00:00Z");
    const now = new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Dubai"}));
    return ((now - d)/(1000*60*60*24)) <= days;
  }catch{ return false; }
}
function violatesDiversity(rec,{batch,recent},policy){
  const pol = { ...DIVERSITY_DEFAULTS, ...(policy||{}) };
  const bag = tokenizeIngredients(rec?.ingredients||[]);
  const pf = proteinFamilyFromIngredients(rec?.ingredients||[]);
  const title = String(rec?.title||"");
  for(const h of (batch||[])){
    if(titleSimilarity(h.title,title) >= pol.minTitleDistance) return "title_batch";
    if(jaccard(h.bag, bag) >= pol.maxIngredientJaccard) return "ing_batch";
    if(h.pf === pf) return "protein_batch";
  }
  for(const h of (recent||[])){
    if(!withinDays(h.date, pol.lookbackDays)) continue;
    if(titleSimilarity(h.title,title) >= pol.minTitleDistance) return "title_hist";
    if(jaccard(h.bag, bag) >= pol.maxIngredientJaccard) return "ing_hist";
    if(h.pf === pf) return "protein_hist";
  }
  return null;
}

/* -------------------- Prompting -------------------- */
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
  "serving_suggestions": string[], // 2–5 نقاط تقديم قصيرة
  "lang": "ar"
}

[قواعد إلزامية]
1) العربية الفصحى فقط.
2) كل القياسات بالجرام 100% (وزن نيّئ). ممنوع أي وحدات أخرى.
3) الماكروز: protein_g بروتين فعلي، carbs_g صافي فقط، fat_g دهون.
4) Calories = (protein×4 + carbs×4 + fat×9) بدقة ±2%.
5) الالتزام بالأنظمة/الحساسيات/المكوّنات المتاحة حرفيًا.
6) المكونات مختصرة بالشكل "200 جم صدر دجاج".
7) ≤ ${maxSteps} خطوات أوامر عملية.
8) التنويع: لا تكرار.
9) الحلويات: منطقية الطعم؛ ستيفيا نقية فقط وممنوعة في "نظام د. محمد سعيد".
10) مصادر التغذية: USDA/CIQUAL/McCance (داخليًا).
11) الأرقام كأعداد صريحة.
12) التقديم: 2–5 نقاط متوافقة مع النظام والحساسيات (لا عناصر محظورة).
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
    __repair_serving = false,
    __ban_titles = [],
    __ban_ingredients = [],
    __seed = undefined
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
- استخدمها كأساس وقدّم كل عنصر بوزن جرام دقيق.
- لا تضف إلا الضروري تقنيًا أو لضبط الماكروز (ماء/ملح/فلفل/توابل/زيت زيتون بكر).`
    : "";

  const guide = CUISINE_GUIDES[cuisine] || `- نوّع الأساليب داخل هذا المطبخ وتجنّب تكرار الطبق؛ اجعل العنوان فريدًا.`;

  const diversitySeed = Number.isFinite(Number(__seed))
    ? Number(__seed)
    : (Math.floor(Date.now()/60000)%9973);

  const diversityLines = `
[تنويع صارم] diversity_seed=${diversitySeed}
- لا تكرر نفس الطبق/العنوان/التركيبة.
[حظر صريح]
- تجنّب العناوين/القوالب: ${(__ban_titles||[]).map(slugifyArabicTitle).join(", ") || "لا شيء"}.
- تجنّب تراكيب مشابهة مع: ${(__ban_ingredients||[]).join(", ") || "لا شيء"}.
[دليل المطبخ]
${guide}
`.trim();

  const dessertLine = isDessert(mealType)
    ? `تعليمات الحلويات: وصفة بطعم حلو وقوام ممتع ضمن القيود. ستيفيا نقية فقط وممنوعة مع "نظام د. محمد سعيد".`
    : "";

  const repairLines = [
    __repair && isDrMoh ? "إصلاح: ≤ 5 جم صافي كارب/حصة، لا أي محليات." : "",
    __repair_available && available.length ? "إصلاح: ضمّن كل المكونات المتاحة بأوزان جرام." : "",
    __repair_dessert && isDessert(mealType) ? "إصلاح: الحلويات السابقة ليست منطقية؛ أعد بوصفة حلوى منطقية." : "",
    __repair_diversity ? "إصلاح تنويع: غيّر الأسلوب/العنوان/النكهة." : "",
    __repair_energy ? "إصلاح طاقة: طابق 4/4/9 (±2%)." : "",
    __repair_units ? "إصلاح وحدات: الجرام فقط لكل المكونات." : "",
    __repair_target ? `إصلاح سعرات: قرب من الهدف ${Number(caloriesTarget)} kcal ضمن ±12%.` : "",
    __repair_serving ? "إصلاح التقديم: 2–5 نقاط متوافقة مع النظام والحساسيات." : ""
  ].filter(Boolean).join("\n");

  const customLine = isCustom && customMacros
    ? `استخدم هذه الماكروز لكل حصة: بروتين ${Number(customMacros.protein_g)} جم، كارب ${Number(customMacros.carbs_g)} جم (صافي)، دهون ${Number(customMacros.fat_g)} جم. Calories = (P×4 + C×4 + F×9).`
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
أعد النتيجة كـ JSON فقط حسب المخطط وبالعربية.
`.trim();
}

/* -------------------- JSON extract -------------------- */
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

/* -------------------- Gemini Call + Reliability -------------------- */
const CB = Object.fromEntries(MODEL_POOL.map(m=>[m,{fails:0, until:0}]));
function modelOrder(){
  const now = Date.now();
  return MODEL_POOL
    .map(m=>({m, penalty:(CB[m].until>now)?1:0, fails:CB[m].fails}))
    .sort((a,b)=> (a.penalty-b.penalty) || (a.fails-b.fails))
    .map(x=>x.m);
}
async function callOnce(model, input, timeoutMs = 28000) {
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { role: "system", parts: [{ text: systemInstruction(8) }] },
    contents: [{ role: "user", parts: [{ text: userPrompt(input) }] }],
    generationConfig: { temperature: (input?.__multi ? 0.55 : 0.4), topP: (input?.__multi ? 0.95 : 0.9), maxOutputTokens: 1200 },
    safetySettings: []
  };
  const abort = new AbortController();
  const t = setTimeout(() => abort.abort(), Math.max(1000, Math.min(29000, timeoutMs)));
  let attempt = 0, lastErr = null;
  try {
    while (attempt < 2) {
      attempt++;
      let resp, data;
      try {
        resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
      } catch {
        lastErr = { type:"network" };
        if (attempt<2) { await new Promise(r=>setTimeout(r, 300*attempt)); continue; }
        break;
      }
      const text = await resp.text();
      try { data = JSON.parse(text); } catch { data = null; }
      if (!resp.ok) {
        const type = (resp.status>=500?"upstream_5xx":"upstream_4xx");
        lastErr = { type, status: resp.status, msg: data?.error?.message };
        if ((type==="upstream_5xx") && attempt<2) { await new Promise(r=>setTimeout(r, 300*attempt)); continue; }
        break;
      }
      let json = data && typeof data === "object" && data.title ? data : extractJsonFromCandidates(data);
      if (!json) return { ok:false, error:"gemini_returned_non_json" };
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
      if (json.macros) json.macros = reconcileCalories(json.macros);
      const v = validateRecipeSchema(json);
      if (!v.ok) return { ok:false, error:`schema_validation_failed:${v.error}` };
      return { ok:true, recipe: json };
    }
    return { ok:false, error: lastErr?.msg || lastErr?.type || "unknown_error" };
  } finally {
    clearTimeout(t);
  }
}
async function tryModelsInRace(payload){
  const models = modelOrder().slice(0,5);
  const tasks = models.map(async (m)=>{
    const r = await callOnce(m, payload, 28000);
    if(r.ok){ CB[m].fails = Math.max(0, CB[m].fails-1); return { ...r, model:m }; }
    CB[m].fails++; if(CB[m].fails>=3){ CB[m].until = Date.now()+60_000; }
    throw new Error(r.error || "model_failed");
  });
  try{
    const res = await Promise.any(tasks);
    return res;
  } catch {
    // gather last results if needed: here we simply fallback sequentially
    for (const m of models){
      const r = await callOnce(m, payload, 28000);
      if(r.ok){ CB[m].fails = Math.max(0, CB[m].fails-1); return { ...r, model:m }; }
      CB[m].fails++; if(CB[m].fails>=3){ CB[m].until = Date.now()+60_000; }
    }
    return { ok:false, error:"all_models_failed" };
  }
}

/* -------------------- Policy & plausibility checks -------------------- */
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
    "ستيفيا"
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

/* -------------------- Security & Idempotency -------------------- */
function readAuthHeaders(event){
  const token = safeHeader(event.headers["x-auth-token"] || event.headers["X-Auth-Token"]);
  const nonce = safeHeader(event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"]);
  const idem = safeHeader(event.headers["x-idempotency-key"] || event.headers["X-Idempotency-Key"]);
  return { token, nonce, idem };
}
const IDEMP_TTL_MS = 5*60*1000;
const memCache = new Map();
function readIdem(key){
  if(!key) return null;
  const v = memCache.get(key); if(!v) return null;
  if(Date.now()-v.t > IDEMP_TTL_MS){ memCache.delete(key); return null; }
  return v.payload;
}
function writeIdem(key, payload){ if(key) memCache.set(key, { t:Date.now(), payload }); }
function stableIdFromRecipe(rec){
  const base = normalizeArabic(rec.title)+"|"+normalizeArabic(rec.ingredients.join("|"));
  let h=0; for(let i=0;i<base.length;i++) h=(h*31 + base.charCodeAt(i))>>>0;
  return "rx-"+h.toString(16);
}

/* -------------------- Subscription Gate -------------------- */
async function ensureActiveSubscription(headers) {
  const { token, nonce } = readAuthHeaders({ headers });
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
  return { ok:true, token };
}

/* -------------------- Handler -------------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  const req_id = newReqId();
  logInfo({ req_id, event:"start" });

  // Subscription enforcement
  let gate;
  try { gate = await ensureActiveSubscription(event.headers||{}); if (!gate.ok) return bad(gate.code, gate.msg); }
  catch (e){ logErr({ req_id, event:"subscription_gate_error", error:String(e) }); return bad(500, "subscription_gate_error"); }

  let input = {};
  try { input = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "invalid_json_body"); }

  // Optional: planSize (no break for single recipe)
  const planSize = Math.max(1, Math.floor(Number(input?.planSize||1)));
  const diversityPolicy = input?.diversity || {};
  const isCustom = String(input?.dietType || "") === "custom";
  let customMacros = null;
  if (isCustom) {
    const cm = input?.customMacros || {};
    const p = Number(cm.protein_g), c = Number(cm.carbs_g), f = Number(cm.fat_g);
    if (![p,c,f].every(Number.isFinite)) return bad(400, "custom_macros_invalid");
    if (p < 0 || c < 0 || f < 0) return bad(400, "custom_macros_negative");
    customMacros = { protein_g: p, carbs_g: c, fat_g: f };
  }
  const availableIngredients = Array.isArray(input?.availableIngredients) ? sanitizeAvailableList(input.availableIngredients) : [];
  const wantDrMoh   = DR_MOH.test(String(input?.dietType || ""));
  const wantDessert = isDessert(input?.mealType);
  const caloriesTarget = Number(input?.caloriesTarget)||0;
  const allergies = Array.isArray(input?.allergies) ? input.allergies : [];

  // Allergy guard: available contains banned?
  const bansFromAllergy = new Set(allergyBansFromUser(allergies));
  if (availableIngredients.length && bansFromAllergy.size){
    const joined = normalizeArabic(availableIngredients.join(" "));
    for(const b of bansFromAllergy){ if(joined.includes(b)) return bad(400, `available_contains_allergen:${b}`); }
  }

  // Idempotency & Seed
  const { idem } = readAuthHeaders(event);
  const cached = readIdem(idem);
  if (cached) { return jsonRes(200, cached, { ETag: `"${cached.etag || 'cached'}"` }); }
  const seedFromIdem = idem ? Array.from(idem).reduce((a,c)=>(a*33 + c.charCodeAt(0))>>>0, 5381)%9973 : undefined;

  // Load recipe index (history)
  const { index: recIndex, sha: recSha } = await loadRecipesIndex();
  const token = safeHeader(event.headers["x-auth-token"] || event.headers["X-Auth-Token"]);
  const userKey = token ? `u:${String(token).slice(0,12)}` : "u:anon";
  const userHist = recIndex[userKey] || [];
  const recent = userHist.slice(-120).map(h=>({ title:h.title, bag:new Set(h.bag||[]), pf:h.pf, date:h.date }));

  // Builder helpers
  const produced = [];
  const batch = [];
  const tryOnce = async (attemptInput, banTitles, banIngs) => {
    const payload = { ...attemptInput, customMacros, availableIngredients, __multi: planSize>1, __seed: seedFromIdem };
    if (banTitles?.length) payload.__ban_titles = banTitles;
    if (banIngs?.length)   payload.__ban_ingredients = banIngs;
    const r1 = await tryModelsInRace(payload);
    if(!r1.ok) return r1;
    let rec = r1.recipe;

    // Quick repairs (strict but minimal)
    if (!Array.isArray(rec.serving_suggestions) || rec.serving_suggestions.length < 2) {
      const f = await tryModelsInRace({ ...payload, __repair_serving:true });
      if (f.ok) rec = f.recipe;
    }
    if (unitsLookOff(rec)) {
      const f = await tryModelsInRace({ ...payload, __repair_units:true });
      if (f.ok) rec = f.recipe;
    }
    if (wantDrMoh && violatesDrMoh(rec)) {
      const f = await tryModelsInRace({ ...payload, __repair:true, __repair_energy:true, __repair_units:true, __repair_serving:true });
      if (f.ok && !violatesDrMoh(f.recipe)) rec = f.recipe;
    }
    if (availableIngredients.length && !includesAllAvailable(rec, availableIngredients)) {
      const f = await tryModelsInRace({ ...payload, __repair_available:true, __repair_energy:true, __repair_units:true, __repair_serving:true });
      if (f.ok && includesAllAvailable(f.recipe, availableIngredients)) rec = f.recipe;
    }
    if (wantDessert && (dessertLooksIllogical(rec) || (!wantDrMoh && dessertLacksSweetness(rec)))) {
      const f = await tryModelsInRace({ ...payload, __repair_dessert:true, __repair_energy:true, __repair_units:true, __repair_serving:true });
      if (f.ok && !dessertLooksIllogical(f.recipe) && (!wantDrMoh ? !dessertLacksSweetness(f.recipe) : true)) rec = f.recipe;
    }
    if (energyLooksOff(rec)) {
      const f = await tryModelsInRace({ ...payload, __repair_energy:true, __repair_serving:true });
      if (f.ok && !energyLooksOff(f.recipe)) rec = f.recipe;
    }
    if (caloriesTarget && targetCaloriesFar(rec, caloriesTarget)) {
      const f = await tryModelsInRace({ ...payload, __repair_target:true, __repair_energy:true, __repair_serving:true });
      if (f.ok && !targetCaloriesFar(f.recipe, caloriesTarget)) rec = f.recipe;
    }
    if (macrosVsMassImplausible(rec)) {
      const f = await tryModelsInRace({ ...payload, __repair_energy:true, __repair_units:true, __repair_serving:true });
      if (f.ok && !macrosVsMassImplausible(f.recipe)) rec = f.recipe;
    }
    if (titleTooGeneric(rec)) {
      const f = await tryModelsInRace({ ...payload, __repair_diversity:true, __repair_energy:true, __repair_serving:true });
      if (f.ok) rec = f.recipe;
    }

    // Final normalize + serving filter + id
    rec.macros = reconcileCalories(rec.macros);
    if (Array.isArray(rec.ingredients)) rec.ingredients = enforceGramHints(rec.ingredients);
    rec.serving_suggestions = filterServingSuggestions(rec.serving_suggestions, String(input?.dietType||"").trim(), allergies);
    if (!Array.isArray(rec.serving_suggestions) || rec.serving_suggestions.length < 2) {
      rec.serving_suggestions = ["قدّم دافئًا.","زيّن بأعشاب طازجة."];
    }
    rec.id = stableIdFromRecipe(rec);

    return { ok:true, recipe: rec, model: r1.model };
  };

  for(let i=0;i<planSize;i++){
    const attemptInput = { ...input }; // cuisine rotation optional: respect client input as-is
    const banTitles = batch.map(b=>b.title);
    const banIngs   = [...new Set(batch.flatMap(b=>Array.from(b.bag)))];

    const r = await tryOnce(attemptInput, banTitles, banIngs);
    if(!r.ok) { logWarn({ req_id, event:"diversity_generation_failed", reason:r.error }); return bad(502, "diversity_generation_failed"); }

    const rec = r.recipe;
    const violation = violatesDiversity(rec, { batch, recent }, diversityPolicy);
    if(violation){
      const r2 = await tryOnce(attemptInput, [...banTitles, rec.title], [...banIngs, ...tokenizeIngredients(rec.ingredients)]);
      if(!r2.ok || violatesDiversity(r2.recipe, { batch, recent }, diversityPolicy)) {
        logWarn({ req_id, event:"diversity_rejection_sampling_failed", violation });
        return bad(502, "diversity_rejection_sampling_failed", { violation });
      }
      produced.push({ recipe: r2.recipe, model: r2.model });
      batch.push({ title:r2.recipe.title, bag:tokenizeIngredients(r2.recipe.ingredients), pf:proteinFamilyFromIngredients(r2.recipe.ingredients), date:todayDubai() });
    }else{
      produced.push({ recipe: rec, model: r.model });
      batch.push({ title:rec.title, bag:tokenizeIngredients(rec.ingredients), pf:proteinFamilyFromIngredients(rec.ingredients), date:todayDubai() });
    }
  }

  // Update history (cap 300)
  const updated = [...userHist, ...batch.map(b=>({ title:b.title, bag:[...b.bag], pf:b.pf, date:b.date }))].slice(-300);
  recIndex[userKey] = updated;
  await saveRecipesIndex(recIndex, recSha, `recipes-index: +${batch.length} for ${userKey} @ ${todayDubai()}`);

  // Response shape (stable for single recipe)
  const etag = (planSize===1) ? `${produced[0].recipe.id}-1` : `${produced[0].recipe.id}-${planSize}`;
  if (planSize===1){
    const payload = { ...produced[0] };
    const finalBody = { ok:true, ...payload, etag };
    if (idem) writeIdem(idem, finalBody);
    logInfo({ req_id, event:"result_single", model: produced[0].model, recipe_id: produced[0].recipe.id });
    return jsonRes(200, finalBody, { ETag: `"${etag}"` });
  } else {
    const finalBody = { ok:true, plans: produced, etag };
    if (idem) writeIdem(idem, finalBody);
    logInfo({ req_id, event:"result_multi", count: produced.length });
    return jsonRes(200, finalBody, { ETag: `"${etag}"` });
  }
};
