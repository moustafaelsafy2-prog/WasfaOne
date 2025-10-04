// netlify/functions/generateRecipe.js
// وصفات عربية باحتراف — منع تكرار نهائي + أسماء أطباق أصيلة + التزام صارم بقواعد الأنظمة
// (تحديث نظام د. محمد سعيد: يَسمح بالزيوت غير المهدرجة مثل زيت الزيتون والأفوكادو والسمسم وجوز الهند، مع بقاء منع الزيوت البذرية/المهدرجة، وحد الكارب ≤ 5 جم/حصة)

/* ========================================================================== */
/*                               مفاتيح ونماذج                                */
/* ========================================================================== */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// مجموعة نماذج Gemini (يُجرَّب بالتتابع حتى ينجح أحدها)
const MODEL_POOL = [
  // Gemini 2.x
  "gemini-2.0-flash",
  "gemini-2.0-pro",

  // Gemini 1.5 Pro
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro-002",
  "gemini-1.5-pro-001",
  "gemini-1.5-pro",

  // Gemini 1.5 Flash + 8B
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b-latest",
  "gemini-1.5-flash-8b",

  // إصدارات قديمة لضمان التوافق
  "gemini-1.0-pro",
  "gemini-pro",
  "gemini-pro-vision"
];

/* ========================================================================== */
/*                             مهلة ومحاولات                                  */
/* ========================================================================== */
const CALL_TIMEOUT_MS = 10000;       // 10s لكل نداء توليد
const NAMECHECK_TIMEOUT_MS = 5000;   // 5s لفحص الاسم
const NAMECHECK_MIN_CONF = 0.70;     // ثقة مقبولة
const MAX_MODELS = MODEL_POOL.length;
const MAX_ATTEMPTS_PER_MODEL = 1;

/* ========================================================================== */
/*                            GitHub: اشتراك/تاريخ                            */
/* ========================================================================== */
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";
const HISTORY_PATH = "data/recipes_history.json";

async function ghGetJson(path){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if (!r.ok){
    if (r.status === 404) return { json:null, sha:null, missing:true };
    throw new Error(`GitHub GET ${path} ${r.status}`);
  }
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content), sha: data.sha, missing:false };
}
async function ghPutJson(path, json, sha, message){
  const content = Buffer.from(JSON.stringify(json, null, 2), "utf-8").toString("base64");
  const body = { message, content, branch: REF };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method:"PUT",
    headers:{ Authorization:`token ${GH_TOKEN}`, "User-Agent":"WasfaOne", "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error(`GitHub PUT ${path} ${r.status}`);
  return r.json();
}

/* ========================================================================== */
/*                                   HTTP                                     */
/* ========================================================================== */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Session-Nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const resJson = (code, obj)=>({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra={}) => resJson(code, { ok:false, error, ...extra });
const ok  = (payload) => resJson(200, { ok:true, ...payload });

/* ========================================================================== */
/*                                 اشتراك                                     */
/* ========================================================================== */
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
async function ensureActiveSubscription(event){
  const token = event.headers["x-auth-token"] || event.headers["X-Auth-Token"];
  const nonce = event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"];
  if (!token || !nonce) return { ok:false, code:401, msg:"unauthorized" };
  const { json: users, sha } = await ghGetJson(USERS_PATH);
  if (!users || !Array.isArray(users)) return { ok:false, code:500, msg:"users_file_missing" };
  const idx = users.findIndex(u => (u.auth_token||"") === token);
  if (idx === -1) return { ok:false, code:401, msg:"unauthorized" };
  const user = users[idx];
  if ((user.session_nonce||"") !== nonce) return { ok:false, code:401, msg:"bad_session" };
  const today = todayDubai();
  if (user.end_date && today > user.end_date){
    user.status = "suspended"; user.lock_reason = "expired";
    users[idx] = user;
    await ghPutJson(USERS_PATH, users, sha, `auto-suspend expired ${user.email}`);
    return { ok:false, code:403, msg:"subscription_expired" };
  }
  if ((String(user.status||"").toLowerCase()!=="active") || !withinWindow(user.start_date, user.end_date)){
    return { ok:false, code:403, msg:"inactive_or_out_of_window" };
  }
  return { ok:true, user };
}

/* ========================================================================== */
/*                           أدوات أرقام/نصوص/هاش                             */
/* ========================================================================== */
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
function normalizeArrArabic(arr){ return (Array.isArray(arr)?arr:[]).map(x=>normalizeArabic(String(x||""))); }
const crypto = require("crypto");
function hash(str){ return crypto.createHash("sha256").update(String(str||"")).digest("hex"); }

/* ========================================================================== */
/*                               وحدات القياس                                 */
/* ========================================================================== */
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

/* ========================================================================== */
/*                            طاقة (4/4/9) ومصداقية                           */
/* ========================================================================== */
function normalizeMacros(macros){
  let p = clamp(round1(Math.max(0, toNum(macros?.protein_g))), 0, 200);
  let c = clamp(round1(Math.max(0, toNum(macros?.carbs_g))), 0, 200);
  let f = clamp(round1(Math.max(0, toNum(macros?.fat_g))), 0, 200);
  return { protein_g: p, carbs_g: c, fat_g: f };
}
function reconcileCalories(macros){
  const m = normalizeMacros(macros||{});
  const calc = Math.round(m.protein_g*4 + m.carbs_g*4 + m.fat_g*9);
  return { protein_g:m.protein_g, carbs_g:m.carbs_g, fat_g:m.fat_g, calories:calc, _energy_model:"4/4/9 strict" };
}
function energyLooksOff(recipe){
  const m = recipe?.macros||{};
  const p = toNum(m.protein_g), c = toNum(m.carbs_g), f = toNum(m.fat_g), cal = toNum(m.calories);
  const calc = Math.round(p*4 + c*4 + f*9);
  return Math.abs(calc - cal) > Math.max(8, Math.round(calc*0.02));
}

/* ========================================================================== */
/*                              مخطط الوصفة                                   */
/* ========================================================================== */
function validateRecipeSchema(rec){
  const must = ["title","servings","total_time_min","macros","ingredients","steps","lang","serving_suggestions"];
  if (!rec || typeof rec !== "object") return { ok:false, error:"recipe_not_object" };
  for (const k of must) if (!(k in rec)) return { ok:false, error:`missing_${k}` };
  if (typeof rec.title !== "string" || !rec.title.trim()) return { ok:false, error:"title_type" };
  if (!Number.isFinite(rec.servings)) return { ok:false, error:"servings_type" };
  if (!Number.isFinite(rec.total_time_min)) return { ok:false, error:"total_time_min_type" };
  const m = rec.macros;
  if (!m || typeof m !== "object") return { ok:false, error:"macros_type" };
  for (const key of ["protein_g","carbs_g","fat_g","calories"]) if (!Number.isFinite(m[key])) return { ok:false, error:`macro_${key}_type` };
  if (!Array.isArray(rec.ingredients) || rec.ingredients.some(x => typeof x !== "string")) return { ok:false, error:"ingredients_type" };
  if (!Array.isArray(rec.steps) || rec.steps.some(x => typeof x !== "string")) return { ok:false, error:"steps_type" };
  if (rec.lang !== "ar") return { ok:false, error:"lang_must_be_ar" };
  if (!Array.isArray(rec.serving_suggestions) || rec.serving_suggestions.length < 2 || rec.serving_suggestions.length > 5) return { ok:false, error:"serving_suggestions_count_invalid" };
  if (rec.serving_suggestions.some(x => typeof x !== "string" || !x.trim())) return { ok:false, error:"serving_suggestions_type" };
  const gramCount = rec.ingredients.filter(hasGramWeightLine).length;
  rec._ingredients_gram_coverage = `${gramCount}/${rec.ingredients.length}`;
  if (rec.ingredients.some(containsNonGramUnit)) return { ok:false, error:"non_gram_unit_detected" };
  return { ok:true };
}
function titleTooGeneric(recipe){
  const t = String(recipe?.title||"").trim();
  return /^(حلوى|حلويات|سلطه|سلطة|شوربه|شوربة|طبق|وجبه|وجبة)\s*$/i.test(t) || (t.split(/\s+/).filter(Boolean).length <= 1);
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

/* ========================================================================== */
/*                        أنظمة/حساسية + قوائم محظورات                        */
/* ========================================================================== */
const DR_MOH = /محمد\s*سعيد|dr_mohamed_saeed/i;  // التعرّف على النظام

// عائلات/قوائم عامة
const DIET_FAMILY_KETO = new Set([
  "keto","lchf","high_protein_keto","psmf","atkins","low_carb","dr_mohamed_saeed","دكتور محمد سعيد","نظام د محمد سعيد","نظام د. محمد سعيد"
]);

const HIGH_CARB_SIDES = normalizeArrArabic(["خبز","عيش","توست","رز","ارز","أرز","مكرونه","باستا","بطاطس","بطاطا","ذره","فشار","تمر","كعك","حلويات","سكر","عسل","شوفان","كسكس","برغل","شعير"]);
const SWEETENERS = normalizeArrArabic(["ستيفيا","سكر","محلي","شراب","سيرب","دبس","عسل","سكر بني","سكر جوز الهند","اريثريتول","سوربيتول","مالتيتول"]);
const PROCESSED_OILS = normalizeArrArabic(["كانولا","صويا","ذره","بذر العنب","زيوت نباتيه","مهدرج","مارجرين","دوار الشمس","عباد الشمس","قطن","نخيل","نواة النخيل","زيت نباتي","زيت نباتى","vegetable oil","seed oil","rapeseed","sunflower","corn oil","soy oil","grapeseed"]);
const GLUTEN = normalizeArrArabic(["خبز","قمح","جلوتين","طحين","مكرونه","برغل","كسكس","شعير"]);
const NUTS = normalizeArrArabic(["مكسرات","لوز","فستق","كاجو","بندق","جوز"]);
const EGG = normalizeArrArabic(["بيض","بياض البيض","صفار"]);
const SEAFOOD = normalizeArrArabic(["سمك","تونه","روبيان","جمبري","سلمون","محار"]);
const SOY = normalizeArrArabic(["صويا","توفو","تمبيه","صلصه صويا","صوص صويا"]);
const LEGUMES = normalizeArrArabic(["فول","فاصوليا","لوبيا","حمص","عدس","بزلاء","بازلاء","فول الصويا","ترمس"]);
const ALL_FRUITS = normalizeArrArabic([
  "تفاح","موز","برتقال","عنب","كمثرى","خوخ","مشمش","كيوي","مانجو","اناناس","رمان","تين","تمر","بطيخ","شمام","جوافه","بابايا","كاكا","يوسفي","نكتارين","افوكادو","قشطة","تين شوكي","برقوق","ليمون","ليمون حلو","جريب فروت"
]);
const BERRIES_ALLOWED = normalizeArrArabic(["توت","توت ازرق","بلو بيري","فراوله","فراولة","توت اسود","بلاك بيري","كرانبيري","توت بري"]);

// الزيوت النباتية المسموحة (غير مهدرجة) حسب التحديث:
const ALLOWED_PLANT_OILS = normalizeArrArabic([
  "زيت زيتون","زيت الافوكادو","زيت أفوكادو","زيت سمسم","زيت جوز الهند"
]);

// منتجات الألبان: المسموح فقط "كريمة الطبخ" الحيوانية والأجبان الحيوانية كاملة الدسم
const DAIRY_PERMITTED_KEYWORDS = normalizeArrArabic([
  "كريمه طبخ","كريمة طبخ","كريمه خفق","كريمة خفق","جبن كامل الدسم","جبنه كامله الدسم","شيدر كامل الدسم","موزاريلا كامله الدسم","جبن حيواني","جبنه حيوانيه","قشطه بلدي","قشطة بلدي"
]);
const DAIRY_WIDE = normalizeArrArabic([
  "حليب","لبن","زبادي","يوغرت","جبن","جبنه","قشطه","قشطة","كريمه","كريمة","لبنه","لبنة","ماسكرپوني","ماسكربوني","ريكوتا","قريش","قشطة نباتية","كريمة نباتية"
]);

function n(s){ return normalizeArabic(String(s||"")); }

/* ========================================================================== */
/*                     حظر الاقتراحات (التقديم) وفق النظام                    */
/* ========================================================================== */
function allergyBansFromUser(allergiesRaw){
  const s = n((Array.isArray(allergiesRaw)?allergiesRaw.join(" "):""));
  const bans = [];
  if (s.includes("جلوتين") || s.includes("قمح")) bans.push(...GLUTEN);
  if (s.includes("ألبان") || s.includes("البان") || s.includes("لاكتوز")) bans.push(...DAIRY_WIDE);
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
  // نظام د. محمد سعيد: ممنوعات إضافية في الاقتراحات/التقديم
  if (d.includes("محمد سعيد") || d.includes("dr_mohamed_saeed")) {
    bans.push(
      ...SWEETENERS,
      ...PROCESSED_OILS,        // الزيوت البذرية/المهدرجة/الصناعية
      ...HIGH_CARB_SIDES,
      ...LEGUMES,
      ...ALL_FRUITS             // سنسمح في المكوّنات فقط بالتوتيات صراحة
    );
    // لا نمنع الزيوت المسموحة (زيت زيتون/أفوكادو/سمسم/جوز الهند)
  }
  if (d === "low_fat") bans.push(n("زبدة"), n("سمن"), n("قلي عميق"));
  if (d === "vegan") bans.push(n("حيواني"), ...normalizeArrArabic(["لحم","دجاج","بيض","سمك","حليب","جبن","زبادي"]));
  return Array.from(new Set(bans));
}

function isSuggestionAllowed(text, dietType, allergies){
  const t = n(text);
  const bans = new Set([...dietSpecificBans(dietType), ...allergyBansFromUser(allergies)]);
  for (const b of bans){ if (b && t.includes(b)) return false; }
  // لا مُحلّيات إطلاقًا
  if ((n(dietType).includes("محمد سعيد") || n(dietType).includes("dr_mohamed_saeed")) && SWEETENERS.some(sw => t.includes(sw))) return false;
  // لا نمنع ذكر الزيوت المسموحة؛ نمنع فقط الزيوت الصناعية/المهدرجة المذكورة أعلاه
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

/* ========================================================================== */
/*                            منطق الحلويات والسلامة                           */
/* ========================================================================== */
const DESSERT_SAVORY_BANNED = normalizeArrArabic([
  "لحم","دجاج","ديك رومي","سمك","تونة","سجق","نقانق","سلامي","بسطرمة","مرق",
  "ثوم","بصل","كركم","كمون","كزبرة ناشفة","بهارات","شطة","صلصة صويا","معجون طماطم"
]);
const DESSERT_SWEET_POSITIVE = normalizeArrArabic(["فانيلا","كاكاو","قرفه","هيل","توت","فراوله","ماسكربوني","كريمه","كريمة","زبدة الفول السوداني"]);
function isDessert(mealType){ return /حلويات|تحليه|dessert/i.test(String(mealType||"")); }
function dessertLooksIllogical(recipe){
  const ingN = normalizeArabic((recipe?.ingredients||[]).join(" "));
  return DESSERT_SAVORY_BANNED.some(k => ingN.includes(k));
}
function dessertLacksSweetness(recipe){
  // عام لغير نظام د. محمد سعيد (لأن المُحليات ممنوعة هناك)
  const ingN = normalizeArabic((recipe?.ingredients||[]).join(" "));
  return !DESSERT_SWEET_POSITIVE.some(k => ingN.includes(k));
}

/* ========================================================================== */
/*                             تاريخ منع التكرار                               */
/* ========================================================================== */
async function loadHistory(){
  const { json, sha, missing } = await ghGetJson(HISTORY_PATH);
  if (missing || !json) return { data:{ users:{} }, sha:null };
  if (!json.users || typeof json.users !== "object") return { data:{ users:{} }, sha };
  return { data: json, sha };
}
async function saveHistory(history, sha, message){ return ghPutJson(HISTORY_PATH, history, sha, message); }
function getUserHistoryNode(historyData, userId){
  if (!historyData.users[userId]) historyData.users[userId] = { fingerprints: [], bans: [] };
  if (!Array.isArray(historyData.users[userId].fingerprints)) historyData.users[userId].fingerprints = [];
  if (!Array.isArray(historyData.users[userId].bans)) historyData.users[userId].bans = [];
  historyData.users[userId].fingerprints = historyData.users[userId].fingerprints.slice(-400);
  historyData.users[userId].bans = historyData.users[userId].bans.slice(-800);
  return historyData.users[userId];
}
function canonicalFingerprint(input, recipe){
  const base = {
    mealType: String(input?.mealType||"").trim(),
    cuisine: String(input?.cuisine||"").trim(),
    dietType: String(input?.dietType||"").trim(),
    title: normalizeArabic(recipe?.title||""),
    ingredients: (recipe?.ingredients||[]).map(x => normalizeArabic(String(x||""))).sort(),
    protein: Math.round(toNum(recipe?.macros?.protein_g)||0),
    carbs: Math.round(toNum(recipe?.macros?.carbs_g)||0),
    fat: Math.round(toNum(recipe?.macros?.fat_g)||0),
  };
  return hash(JSON.stringify(base));
}
function isDuplicateFingerprint(userNode, fp){ return userNode.fingerprints.includes(fp); }
function deriveBanKeysFromRecipe(recipe){
  const titleKey = normalizeArabic(recipe?.title||"");
  const ingKey = normalizeArabic((recipe?.ingredients||[]).join(" | "));
  return [`title:${titleKey}`, `ings:${hash(ingKey)}`];
}
function buildBanList(userNode){ return Array.from(new Set(userNode.bans)).slice(-50); }
function pushRecipeToHistory(userNode, input, recipe){
  const fp = canonicalFingerprint(input, recipe);
  userNode.fingerprints = Array.from(new Set([...userNode.fingerprints, fp])).slice(-400);
  const bans = deriveBanKeysFromRecipe(recipe);
  userNode.bans = Array.from(new Set([...userNode.bans, ...bans])).slice(-800);
  return fp;
}

/* ========================================================================== */
/*                        أدلة مطابخ (إرشادية فقط)                            */
/* ========================================================================== */
const CUISINE_GUIDES = {
  "مطبخ مصري": `- منزلي/إسكندراني/ريفي؛ اختلاف تقنية (طاجن/تسبيك/شوي).`,
  "شامي": `- لبناني/سوري/فلسطيني؛ حمضي-عشبي (سماق/ليمون/زيت زيتون).`,
  "خليجي": `- كبسات/مندي/مظبي؛ توابل دافئة ونكهات دخانية.`,
  "مغربي": `- طواجن/طاجين؛ كمون/كركم/زنجبيل/قرفة مع زيت زيتون.`,
  "متوسطي (Mediterranean)": `- يوناني/إيطالي/إسباني؛ فرق في الشوي/الخبز/اليخنات.`,
  "إيطالي": `- لحوم/أسماك/خضار؛ تجنّب الخبز/المعكرونة.`,
  "يوناني": `- زيت زيتون/أعشاب/ليمون؛ أطباق بحرية وخضار.`,
  "تركي": `- مشويات/مقبلات زيت الزيتون.`,
  "هندي": `- شمالي/جنوبي؛ اضبط الكارب.`,
  "تايلندي": `- حلو-حامض-حار مع أعشاب طازجة.`,
  "ياباني": `- بحرية/شوي؛ تجنّب الأرز/السكر.`
};

/* ========================================================================== */
/*                              برمبت أساسي                                   */
/* ========================================================================== */
function systemInstruction(maxSteps = 8){
  return `
أنت شيف محترف وخبير تغذية. أعد **JSON فقط** وفق المخطط:
{
  "title": string,
  "servings": number,
  "total_time_min": number,
  "macros": { "protein_g": number, "carbs_g": number, "fat_g": number, "calories": number },
  "ingredients": string[],
  "steps": string[],  // بحد أقصى ${maxSteps} خطوات قصيرة
  "serving_suggestions": string[], // 2–5 نقاط تقديم مناسبة
  "lang": "ar"
}

[قواعد إلزامية]
1) العربية الفصحى فقط ولا شيء خارج JSON.
2) **الجرام فقط** لكل المكوّنات (وزن نيّئ).
3) صافي الكارب فقط، والسعرات = 4/4/9 بدقة ±2%.
4) التزام صارم بالنظام الغذائي والحساسيات والمكوّنات المتاحة.
5) عنوان فريد وتقنية/نكهة مختلفة.
6) في نظام "د. محمد سعيد":
   - الحد الأقصى للكارب **5 جم/حصة**.
   - ممنوع السكريات والمحليات (حتى ستيفيا).
   - **الزيوت المسموحة فقط**: غير المهدرجة مثل (زيت الزيتون، زيت الأفوكادو، زيت السمسم، زيت جوز الهند) + الدهون الحيوانية (زبدة/سمن/شحم).
   - ممنوع الزيوت البذرية/الصناعية/المهدرجة (كانولا، ذرة، صويا، عباد الشمس، بذر العنب…).
   - ممنوع البقوليات والنشويات والدقيق/الطحين.
   - ممنوع الفواكه، **مسموح فقط التوتيات** ضمن حد الكارب.
   - منتجات الألبان **المسموحة فقط**: كريمة الطبخ الحيوانية، والأجبان الحيوانية كاملة الدسم.
   - ممنوع ذكر كلمة "كيتو" بتاتًا.
`.trim();
}
function sanitizeAvailableList(list){
  const arr = Array.isArray(list) ? list : [];
  return Array.from(new Set(
    arr.map(s => String(s||"").replace(/[{}\[\]<>:;"/\\|`~]/g," ").replace(/\s+/g," ").trim()).filter(Boolean)
  ));
}
function userPrompt(input, banList = []){
  const {
    mealType="وجبة", cuisine="متنوع", dietType="balanced",
    caloriesTarget=500, customMacros=null, allergies=[], focus="", availableIngredients=[]
  } = input || {};
  const diversitySeed = Math.floor(Date.now()/60000)%9973;
  const guide = CUISINE_GUIDES[cuisine] || `- نوّع الأساليب داخل هذا المطبخ وتجنّب تكرار نفس الطبق.`;

  const available = sanitizeAvailableList(availableIngredients);
  const availableLine = available.length
    ? `«مكونات المستخدم»: ${available.join(", ")} — استخدمها كأساس مع أوزان جرام دقيقة، وأضف فقط الضروري تقنيًا.`
    : "";

  const customLine = (String(dietType)==="custom" && customMacros)
    ? `استخدم هذه الماكروز **لكل حصة** حرفيًا: بروتين ${Number(customMacros.protein_g)} جم، كارب ${Number(customMacros.carbs_g)} جم (صافي)، دهون ${Number(customMacros.fat_g)} جم. والسعرات = 4P+4C+9F.`
    : "";

  const drMohHard = (DR_MOH.test(String(dietType||"")))
    ? `
[قواعد "د. محمد سعيد" الصارمة]
- ≤ 5 جم كارب/حصة.
- لا محليات/سكريات مطلقًا (حتى ستيفيا/اريثريتول/سيروبات).
- **مسموح بالزيوت غير المهدرجة فقط**: زيت الزيتون، زيت الأفوكادو، زيت السمسم، زيت جوز الهند. ومسموح الدهون الحيوانية.
- **ممنوع الزيوت البذرية/الصناعية/المهدرجة**: كانولا، ذرة، صويا، عباد الشمس، بذر العنب… إلخ.
- لا بقوليات ولا نشويات ولا دقيق/طحين ولا حبوب.
- لا فواكه؛ الاستثناء الوحيد: التوتيات.
- منتجات الألبان المسموحة فقط: كريمة طبخ حيوانية + أجبان حيوانية كاملة الدسم.
- لا تكتب كلمة "كيتو".
`.trim()
    : "";

  const banBlock = banList.length ? `\n[محظورات التكرار]\n- ${banList.slice(0,25).join("\n- ")}\n` : "";

  return `
أنشئ وصفة ${/حلويات|تحليه/i.test(mealType)?"حلويات":mealType} من مطبخ ${cuisine} لنظام ${dietType}.
السعرات المستهدفة للحصة: ${Number(caloriesTarget)}.
حساسيات يجب تجنبها: ${(Array.isArray(allergies)&&allergies.length)?allergies.join(", "):"لا شيء"}.
${focus ? `تركيز خاص: ${focus}.` : ""}
[تنويع صارم] diversity_seed=${diversitySeed}
${guide}
${availableLine}
${customLine}
${drMohHard}
${banBlock}
أعد النتيجة كـ JSON فقط.
`.trim();
}

/* ========================================================================== */
/*                       استخراج JSON من رد Gemini                            */
/* ========================================================================== */
function extractJsonFromCandidates(jr){
  const text =
    jr?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("") ||
    jr?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) return null;
  let s = String(text).trim().replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
  const first = s.indexOf("{"), last = s.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  try { return JSON.parse(s.slice(first,last+1)); } catch { return null; }
}

/* ========================================================================== */
/*                           نداء توليد واحد للموديل                           */
/* ========================================================================== */
async function callOnce(model, input, banList = [], timeoutMs = CALL_TIMEOUT_MS){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { role:"system", parts:[{ text: systemInstruction(8) }] },
    contents: [{ role:"user", parts:[{ text: userPrompt(input, banList) }] }],
    generationConfig: { temperature: 0.38, topP: 0.9, maxOutputTokens: 1100 },
    safetySettings: []
  };
  const abort = new AbortController();
  const t = setTimeout(()=>abort.abort(), Math.max(1200, Math.min(29000, timeoutMs)));
  try{
    const resp = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body), signal: abort.signal });
    const txt = await resp.text();
    let data; try{ data = JSON.parse(txt); }catch{ data = null; }
    if (!resp.ok) return { ok:false, error: (data?.error?.message || `HTTP_${resp.status}`), stage: "model_http" };
    let json = (data && typeof data === "object" && data.title) ? data : extractJsonFromCandidates(data);
    if (!json) return { ok:false, error:"gemini_returned_non_json", stage:"model_parse" };

    if (!json.lang) json.lang = "ar";
    if (Array.isArray(json.steps) && json.steps.length > 10){
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
    if (!v.ok) return { ok:false, error:`schema_validation_failed:${v.error}`, stage:"schema" };

    return { ok:true, recipe: json };
  }catch(e){
    return { ok:false, error: String(e && e.message || e), stage:"exception" };
  }finally{
    clearTimeout(t);
  }
}

/* ========================================================================== */
/*                      فحص أصالة الاسم (لا يُسقط الطلب)                      */
/* ========================================================================== */
function nameCheckSystemInstruction(){
  return `
أنت خبير مطابخ وثقافات غذائية. قرّر هل الاسم معروف ومتعارف عليه ضمن المطبخ/الدولة.
أعد JSON فقط:
{ "is_recognized": boolean, "canonical_name_ar": string, "country_or_region_ar": string, "rationale": string, "confidence_0_1": number }
`.trim();
}
function buildNameCheckPrompt(recipe, input){
  const cuisine = String(input?.cuisine||"").trim() || "متوسط/شرق أوسطي";
  return `
- الاسم: ${String(recipe?.title||"").trim()}
- المطبخ: ${cuisine}
- المكونات (موجز): ${(recipe?.ingredients||[]).slice(0,8).join("، ")}
- خطوات مختصرة: ${(recipe?.steps||[]).slice(0,3).join(" | ")}
`.trim();
}
async function verifyDishNameWithAI(model, recipe, input, timeoutMs = NAMECHECK_TIMEOUT_MS){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { role:"system", parts:[{ text: nameCheckSystemInstruction() }] },
    contents: [{ role:"user", parts:[{ text: buildNameCheckPrompt(recipe, input) }] }],
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 300 },
    safetySettings: []
  };
  const abort = new AbortController();
  const t = setTimeout(()=>abort.abort(), Math.max(2000, Math.min(20000, timeoutMs)));
  try{
    const r = await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body), signal: abort.signal });
    const txt = await r.text();
    let data; try{ data = JSON.parse(txt); }catch{ data = null; }
    if(!r.ok) return { ok:false, error: data?.error?.message || `HTTP_${r.status}` };
    const raw = data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("") || "";
    const s = raw.trim().replace(/^```json\s*/i,"").replace(/```$/,"").trim();
    const first = s.indexOf("{"), last = s.lastIndexOf("}");
    if(first === -1 || last === -1) return { ok:false, error:"name_check_non_json" };
    const json = JSON.parse(s.slice(first,last+1));
    if (typeof json?.is_recognized !== "boolean") return { ok:false, error:"name_check_schema" };
    return { ok:true, verdict: json };
  }catch(e){
    return { ok:false, error: String(e && e.message || e) };
  }finally{
    clearTimeout(t);
  }
}
function addCanonicalNameConstraintPrompt(input, suggestion){
  const cuisine = String(input?.cuisine||"").trim();
  const hint = suggestion?.canonical_name_ar
    ? `اختر اسم طبق كانوني معروف في هذا المطبخ، مثل «${suggestion.canonical_name_ar}» كمثال مرجعي فقط (لا تُكرر نفس الطبق إذا تعارض).`
    : `اختر اسم طبق كانوني ومعروف ضمن هذا المطبخ بدقة.`;
  return `
[قيد الاسم الأصيل]
- اسم طبق كانوني ومعروف ضمن «${cuisine}»، مناسب للمكوّنات والماكروز والحساسيات، وغير عام.
${hint}
أعد JSON بالمخطط المعتاد.
`.trim();
}

/* ========================================================================== */
/*                        مساعدين لتطبيق القيود الصارمة                        */
/* ========================================================================== */
function includesAllAvailable(recipe, availableRaw){
  const available = sanitizeAvailableList(availableRaw);
  if (!available.length) return true;
  const ing = " " + normalizeArabic((recipe?.ingredients || []).join(" ")) + " ";
  return available.every(a => {
    const term = normalizeArabic(a);
    return term && ing.includes(" " + term + " ");
  });
}
function filterServingBlock(rec, input){
  rec.serving_suggestions = filterServingSuggestions(
    rec.serving_suggestions,
    String(input?.dietType||"").trim(),
    Array.isArray(input?.allergies)?input.allergies:[]
  );
}

/* إزالة كلمة كيتو من العنوان إن وُجدت */
function sanitizeTitleNoKeto(title){
  let t = String(title||"");
  t = t.replace(/كيتو/gi, "").replace(/keto/gi,"").replace(/\s{2,}/g," ").trim();
  if (!t) t = "وصفة منخفضة الكارب";
  return t;
}

/* قيد صريح لقواعد د. محمد سعيد لإعادة الإرسال عند الإصلاح */
function drMohHardConstraintPrompt(){
  return `
[قواعد إلزامية لنظام د. محمد سعيد]
- ≤ 5 جم كارب صافي للحصة.
- لا محليات/سكريات مطلقًا (حتى ستيفيا/اريثريتول/سيروبات).
- مسموح بالزيوت غير المهدرجة فقط: زيت الزيتون، زيت الأفوكادو، زيت السمسم، زيت جوز الهند. ومسموح الدهون الحيوانية.
- ممنوع الزيوت البذرية/الصناعية/المهدرجة (كانولا، ذرة، صويا، عباد الشمس، بذر العنب…).
- لا بقوليات ولا نشويات ولا دقيق/طحين ولا حبوب.
- لا فواكه؛ الاستثناء الوحيد: التوتيات.
- منتجات الألبان المسموحة فقط: كريمة طبخ حيوانية، أجبان حيوانية كاملة الدسم.
- لا تذكر كلمة "كيتو".
`.trim();
}

/* تحقّق صارم لمكوّنات/ماكروز نظام د. محمد سعيد */
function violatesDrMoh(recipe){
  const carbs = toNum(recipe?.macros?.carbs_g || 0);
  const ingRaw = (recipe?.ingredients || []).join(" | ");
  const ing = normalizeArabic(ingRaw);

  // 1) كارب ≤ 5 جم/حصة
  if (carbs > 5) return true;

  // 2) سكريات/محليات ممنوعة تمامًا
  const bannedSweet = normalizeArrArabic([
    "سكر","عسل","دبس","شراب","سيرب","glucose","fructose","corn syrup","hfcs",
    "ستيفيا","اريثريتول","سوربيتول","مالتيتول","سكر جوز الهند","سكر بني"
  ]);
  if (bannedSweet.some(k => ing.includes(k))) return true;

  // 3) الزيوت: نمنع الزيوت البذرية/المهدرجة/الصناعية، ونسمح
  // زيت الزيتون/الأفوكادو/السمسم/جوز الهند والدهون الحيوانية.
  const mentionsAnyProcessedOil = PROCESSED_OILS.some(k => ing.includes(k));
  if (mentionsAnyProcessedOil) return true;

  const mentionsGenericOil = ing.includes("زيت");
  const mentionsAllowedOil = ALLOWED_PLANT_OILS.some(k => ing.includes(k));
  // إذا ذُكرت كلمة "زيت" دون تحديد نوع، نعتبرها مخالفة لتجنّب إدخال زيت صناعي مبهم.
  if (mentionsGenericOil && !mentionsAllowedOil) return true;

  // 4) بقوليات ممنوعة
  if (LEGUMES.some(k => ing.includes(k))) return true;

  // 5) نشويات/حبوب/دقيق/طحين/رز/خبز/بطاطس/ذرة... إلخ
  if (HIGH_CARB_SIDES.some(k => ing.includes(k))) return true;
  if (GLUTEN.some(k => ing.includes(k))) return true;
  if (/\bنشا|نشا\b/.test(ing)) return true;

  // 6) فواكه (مسموح فقط التوتيات)
  const hasAnyFruit = ALL_FRUITS.some(k => ing.includes(k));
  if (hasAnyFruit){
    // مخالفة إن وُجدت أي فاكهة ليست ضمن التوتيات
    const hasNonBerryFruit = ALL_FRUITS.some(f => ing.includes(f) && !BERRIES_ALLOWED.some(b => ing.includes(b)));
    if (hasNonBerryFruit) return true;
  }

  // 7) منتجات الألبان: مسموح فقط كريمة طبخ حيوانية + أجبان كاملة الدسم حيوانية
  const mentionsDairy = DAIRY_WIDE.some(k => ing.includes(k));
  if (mentionsDairy){
    const permitted = DAIRY_PERMITTED_KEYWORDS.some(k => ing.includes(k));
    if (!permitted) return true;
  }

  // 8) العنوان سيُنظّف لاحقًا من كلمة "كيتو"
  return false;
}

/* ========================================================================== */
/*                              المدخل الرئيسي                                */
/* ========================================================================== */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return resJson(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  // اشتراك
  let auth;
  try {
    const gate = await ensureActiveSubscription(event);
    if (!gate.ok) return bad(gate.code, gate.msg);
    auth = gate.user;
  } catch {
    return bad(500, "subscription_gate_error");
  }

  // إدخال
  let input = {};
  try { input = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "invalid_json_body"); }

  const isCustom = String(input?.dietType || "") === "custom";
  let customMacros = null;
  if (isCustom){
    const cm = input?.customMacros || {};
    const p = Number(cm.protein_g), c = Number(cm.carbs_g), f = Number(cm.fat_g);
    if (![p,c,f].every(Number.isFinite)) return bad(400, "custom_macros_invalid");
    if (p < 0 || c < 0 || f < 0) return bad(400, "custom_macros_negative");
    customMacros = { protein_g: p, carbs_g: c, fat_g: f };
  }
  const availableIngredients = Array.isArray(input?.availableIngredients) ? sanitizeAvailableList(input.availableIngredients) : [];
  const wantDrMoh = DR_MOH.test(String(input?.dietType || ""));
  const wantDessert = isDessert(input?.mealType);
  const caloriesTarget = Number(input?.caloriesTarget)||0;
  const allergies = Array.isArray(input?.allergies) ? input.allergies : [];

  // تاريخ
  let history, historySha;
  try {
    const { data, sha } = await loadHistory();
    history = data; historySha = sha || null;
  } catch {
    history = { users:{} }; historySha = null;
  }
  const userId = String(auth?.email || auth?.id || "unknown_user");
  const userNode = getUserHistoryNode(history, userId);
  const baseBanList = buildBanList(userNode);

  const errors = {};

  // قيد واضح لنظام د. محمد سعيد
  const hardConstraint = wantDrMoh ? [drMohHardConstraintPrompt()] : [];

  for (const model of MODEL_POOL.slice(0, MAX_MODELS)){
    let attempts = 0;
    let usedBanList = [...baseBanList, ...hardConstraint];

    while (attempts < MAX_ATTEMPTS_PER_MODEL){
      attempts++;

      // --------- توليد سريع ---------
      let gen = await callOnce(model, { ...input, customMacros, availableIngredients }, usedBanList, CALL_TIMEOUT_MS);
      if (!gen.ok){ errors[`${model}#${attempts}`] = `${gen.stage||"model"}:${gen.error}`; break; }
      let rec = gen.recipe;

      // تصحيحات عامة
      if (Array.isArray(rec.ingredients)) rec.ingredients = enforceGramHints(rec.ingredients);
      rec.macros = reconcileCalories(rec.macros);

      // عنوان غير عام
      if (titleTooGeneric(rec)) {
        const rDiv = await callOnce(model, { ...input, customMacros, availableIngredients }, usedBanList, Math.min(8000, CALL_TIMEOUT_MS));
        if (rDiv.ok) rec = rDiv.recipe; else { errors[`${model}#${attempts}-div`] = rDiv.error; break; }
      }

      // ===== إصلاحات خاصة بنظام د. محمد سعيد =====
      if (wantDrMoh) {
        rec.title = sanitizeTitleNoKeto(rec.title);

        if (violatesDrMoh(rec)){
          const tightenBans = [
            "no_sweeteners_any_kind",
            "no_seed_oils_or_hydrogenated_oils",
            "only_non_hydrogenated_oils_allowed:olive,avocado,sesame,coconut",
            "no_legumes_no_starches_no_flours",
            "no_fruits_except_berries",
            "dairy_only_cooking_cream_and_full_fat_animal_cheese",
            "carbs_per_serving_max_5g",
            "never_write_keto_word"
          ].map(x => `drmoh:${x}`);
          const r2 = await callOnce(
            model,
            { ...input, customMacros, availableIngredients },
            [...usedBanList, ...tightenBans, drMohHardConstraintPrompt()],
            CALL_TIMEOUT_MS
          );
          if (r2.ok) {
            r2.recipe.title = sanitizeTitleNoKeto(r2.recipe.title);
            if (!violatesDrMoh(r2.recipe)) rec = r2.recipe;
          }
        }
      }

      // توافق مع المكوّنات المتاحة
      if (availableIngredients.length && !includesAllAvailable(rec, availableIngredients)){
        const rAvail = await callOnce(model, { ...input, customMacros, availableIngredients }, usedBanList, CALL_TIMEOUT_MS);
        if (rAvail.ok && includesAllAvailable(rAvail.recipe, availableIngredients)) rec = rAvail.recipe;
      }

      // منطق الحلويات
      if (wantDessert){
        if (!wantDrMoh && (dessertLooksIllogical(rec) || dessertLacksSweetness(rec))){
          const rDess = await callOnce(model, { ...input, customMacros, availableIngredients }, usedBanList, CALL_TIMEOUT_MS);
          if (rDess.ok && !dessertLooksIllogical(rDess.recipe) && !dessertLacksSweetness(rDess.recipe)) rec = rDess.recipe;
        } else if (wantDrMoh && dessertLooksIllogical(rec)) {
          const rDess2 = await callOnce(model, { ...input, customMacros, availableIngredients }, usedBanList, CALL_TIMEOUT_MS);
          if (rDess2.ok && !dessertLooksIllogical(rDess2.recipe)) rec = rDess2.recipe;
        }
      }

      // اتّساق الطاقة
      if (energyLooksOff(rec)){
        const rEnergy = await callOnce(model, { ...input, customMacros, availableIngredients }, usedBanList, CALL_TIMEOUT_MS);
        if (rEnergy.ok && !energyLooksOff(rEnergy.recipe)) rec = rEnergy.recipe;
      }

      // اقتراب السعرات من الهدف
      if (caloriesTarget && targetCaloriesFar(rec, caloriesTarget)){
        const rTarget = await callOnce(model, { ...input, customMacros, availableIngredients }, usedBanList, CALL_TIMEOUT_MS);
        if (rTarget.ok && !targetCaloriesFar(rTarget.recipe, caloriesTarget)) rec = rTarget.recipe;
      }

      // معقولية الماكروز مقابل الكتلة
      if (macrosVsMassImplausible(rec)){
        const rMass = await callOnce(model, { ...input, customMacros, availableIngredients }, usedBanList, CALL_TIMEOUT_MS);
        if (rMass.ok && !macrosVsMassImplausible(rMass.recipe)) rec = rMass.recipe;
      }

      // اقتراحات تقديم ملتزمة
      rec.serving_suggestions = filterServingBlock(rec, input) || [];

      // فحص الاسم (اختياري)
      const nameCheck = await verifyDishNameWithAI(model, rec, input, NAMECHECK_TIMEOUT_MS);
      if (nameCheck.ok){
        const v = nameCheck.verdict;
        const conf = Number(v?.confidence_0_1 || 0);
        if (!v.is_recognized || conf < NAMECHECK_MIN_CONF) {
          const constrained = await callOnce(
            model,
            { ...input, customMacros, availableIngredients, _name_constraint: true },
            [...usedBanList, addCanonicalNameConstraintPrompt(input, v)],
            CALL_TIMEOUT_MS
          );
          if (constrained.ok) {
            const rec2 = constrained.recipe;
            const check2 = await verifyDishNameWithAI(model, rec2, input, Math.min(4000, NAMECHECK_TIMEOUT_MS));
            if (check2.ok && check2.verdict?.is_recognized && Number(check2.verdict?.confidence_0_1||0) >= NAMECHECK_MIN_CONF) {
              if (check2.verdict.canonical_name_ar && normalizeArabic(check2.verdict.canonical_name_ar) !== normalizeArabic(rec2.title)) {
                rec2.title = check2.verdict.canonical_name_ar.trim();
              }
              rec = rec2;
            }
          }
        } else if (v.canonical_name_ar && normalizeArabic(v.canonical_name_ar) !== normalizeArabic(rec.title)) {
          rec.title = v.canonical_name_ar.trim();
        }
      }

      // ===== منع التكرار التاريخي =====
      const fp = canonicalFingerprint(input, rec);
      if (isDuplicateFingerprint(userNode, fp)){
        const newBans = deriveBanKeysFromRecipe(rec);
        usedBanList = Array.from(new Set([...usedBanList, ...newBans, `fp:${fp.slice(0,16)}`])).slice(-60);
        break; // جرّب الموديل التالي
      }

      // تنظيف العنوان نهائيًا من "كيتو"
      rec.title = sanitizeTitleNoKeto(rec.title);

      // حفظ والرد
      pushRecipeToHistory(userNode, input, rec);
      try { await saveHistory(history, historySha, `recipe: add fp for ${userId}`); } catch { /* لا تعطل الاستجابة */ }

      const finalNote = wantDrMoh ? "strict_drmoh_rules_enforced" : "unique_recipe_generated";
      return ok({ recipe: rec, model, note: finalNote });
    }
  }

  return bad(502, "generation_failed_for_all_models", {
    reason: "time_budget_or_namecheck_or_model_http",
    tried: MODEL_POOL.slice(0, MAX_MODELS),
    attempts_per_model: MAX_ATTEMPTS_PER_MODEL,
    last_errors: errors
  });
};
