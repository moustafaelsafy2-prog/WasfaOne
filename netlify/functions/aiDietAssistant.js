// netlify/functions/aiDietAssistant.js
// Arabic diet assistant — ذكي، مرن، سياقي، بدعم "حزمة معرفة تغذوية" وحواجز دقّة (منطق gemini-proxy).
// - يرحّب ويردّ السلام.
// - يحلل سجل المحادثة كاملًا ويستخلص البيانات (وزن/طول/عمر/جنس/نشاط/هدف/تفضيلات…).
// - عند تأكيد قصير مثل "نعم/تمام/أوكي": يتابع الإجراء المعلّق (كحساب السعرات) مباشرة بلا تكرار.
// - إن طرح المستخدم سؤالًا جديدًا يحتاج بيانات ناقصة: يراجع السجل ويسأل فقط الناقص (سؤال واحد أو اثنان).
// - إن لم يرد المستخدم على سؤال سابق: يعيد نفس السؤال مرة واحدة بلطف مع توضيح السبب.
// - نطاق صارم تغذوي فقط؛ يعتذر بلطف عن غير ذلك ويوجّه للسياق الصحيح.
// - مُعزَّز بحزمة معرفة تغذوية عملية + Guardrails للغة والدقة ومنع الاختلاق.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/* ======================= Model pool (Pro-first) ======================= */
const MODEL_POOL = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-1.5-pro",
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro-001",
  "gemini-pro",
  "gemini-1.0-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash-latest"
];

/* ======================= GitHub subscription gate ======================= */
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

/* ======================= HTTP helpers ======================= */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Session-Nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

/* ======================= Subscription gate ======================= */
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
    await ghPutJson(USERS_PATH, users, sha, `assistant: auto-suspend expired ${user.email}`);
    return { ok:false, code:403, msg:"subscription_expired" };
  }
  if ((String(user.status||"").toLowerCase() !== "active") || !withinWindow(user.start_date, user.end_date)) {
    return { ok:false, code:403, msg:"inactive_or_out_of_window" };
  }
  return { ok:true, user };
}

/* ======================= Scope & patterns ======================= */
const SCOPE_ALLOW_RE =
  /(?:سعرات|كالوري|كالور|ماكروز|بروتين|دهون|كارب|كربوهيدرات|ألياف|ماء|ترطيب|نظام|حِمية|رجيم|وجبة|وصفات|غذائ|صيام|الكيتو|كيتو|لو ?كارب|متوسطي|داش|نباتي|سعر حراري|مؤشر جلايسيمي|حساسي|تحسس|سكري|ضغط|كلى|كبد|كوليسترول|وجبات|تقسيم السعرات|macro|protein|carb|fat|fiber|calorie|diet|meal|fasting|glycemic|keto|mediterranean|dash|vegan|lchf|cut|bulk|maintenance)/i;

const GREET_RE = /^(?:\s*(?:السلام\s*عليكم|وعليكم\s*السلام|مرحبا|مرحباً|أهلًا|اهلاً|هلا|مساء الخير|صباح الخير|سلام)\b|\s*السلام\s*)$/i;
const ACK_RE   = /^(?:نعم|اي|إي|ايوه|أيوه|أجل|تمام|حسنًا|حسنا|طيب|اوكي|أوكي|Ok|OK|Yes|Okay)\s*\.?$/i;

/* ======================= Arabic normalization ======================= */
const AR_DIGITS = /[\u0660-\u0669]/g;
const TASHKEEL  = /[\u064B-\u0652]/g;

const COMMON_FIXES = [
  [/خصارة|خساره|خصاره/g, "خسارة"],
  [/قليل ?الحرك[هة]م?|قليل الحركه/g, "قليل الحركة"],
  [/خفيف ?الحرك[هة]?/g, "خفيف الحركة"],
  [/\bذكري?\b/g, "ذكر"],
  [/\bانثى\b/g, "أنثى"],
  [/\bالكيتو\b/g, "كيتو"]
];
function arabicDigitsToLatin(s){ return s.replace(AR_DIGITS, ch => String(ch.charCodeAt(0) - 0x0660)); }
function normalizeArabic(s=""){
  let t = String(s||"");
  t = arabicDigitsToLatin(t).replace(TASHKEEL,"");
  for (const [re, rep] of COMMON_FIXES){ t = t.replace(re, rep); }
  return t.replace(/\s+/g," ").trim();
}

/* ======================= Slot extraction ======================= */
const NUM = "(\\d{1,3}(?:[\\.,]\\d{1,2})?)";

// وزن
const WEIGHT_RE_NAMED   = new RegExp(`(?:\\bوزن(?:ك)?\\b)[:=\\s]*${NUM}\\s*(?:ك(?:جم|ج)?|كيلو|kg)?`,"i");
const WEIGHT_RE_COMPACT = new RegExp(`\\b${NUM}\\s*(?:ك(?:جم|ج)?|كيلو|kg)\\b`,"i");
const WEIGHT_RE_TIGHT   = new RegExp(`\\b${NUM}\\s*ك\\b`,"i");

// طول
const HEIGHT_RE     = new RegExp(`(?:\\bطول(?:ك)?\\b)[:=\\s]*${NUM}\\s*(?:سم|cm)?`,"i");
const HEIGHT_COMPACT= new RegExp(`\\b${NUM}\\s*سم\\b`,"i");

// عمر
const AGE_RE        = new RegExp(`(?:\\bعمر(?:ك)?\\b|\\bage\\b)[:=\\s]*${NUM}`,"i");
const AGE_COMPACT   = new RegExp(`\\b${NUM}\\s*(?:عام|سنة|yr|y)\\b`,"i");

// جنس
const SEX_RE        = /\b(ذكر|أنثى)\b/i;

// هدف/نظام/نشاط/حالات
const GOAL_RE       = /(خسارة|نقص|تنزيل|تخسيس|زيادة|بناء|تثبيت)\s*(?:وزن|دهون|عضل|كتلة)?/i;
const DIET_RE       = /(الكيتو|كيتو|لو ?كارب|متوسطي|داش|نباتي|paleo|صيام متقطع)/i;
const ALLERGY_RE    = /(حساسي(?:ة|ات)|لا(?: أتحمل| أتناول)|تحسس)\s*[:=]?\s*([^.\n،]+)/i;
const ACT_RE        = /(خامل|قليل الحركة|خفيف الحركة|خفيف|متوسط|عال(?:ي)?(?:\s*النشاط)?|sedentary|light|moderate|active)/i;
const DISEASE_RE    = /(سكر[يي]?|ضغط|كلى|كبد|دهون(?: على)? الكبد|كوليسترول|نقرس)/i;

function mapActivity(aRaw=""){
  const s = aRaw.toLowerCase();
  if (/خامل|قليل/.test(s) || /sedentary/.test(s)) return "sedentary";
  if (/خفيف/.test(s) || /light/.test(s)) return "light";
  if (/متوسط|moderate/.test(s)) return "moderate";
  if (/عال|active/.test(s)) return "active";
  return null;
}
function mapGoal(gRaw=""){
  const s = gRaw.toLowerCase();
  if (/خسارة|نقص|تنزيل|تخسيس/.test(s)) return "loss";
  if (/زيادة|بناء/.test(s)) return "gain";
  if (/تثبيت|حفاظ/.test(s)) return "maintain";
  return null;
}
function mapSex(sexRaw=""){
  const s = sexRaw.toLowerCase();
  if (/ذكر/.test(s)) return "male";
  if (/أنثى/.test(s)) return "female";
  return null;
}
function tryNum(x){ if (x==null) return null; const n = Number(String(x).replace(",",".")); return Number.isFinite(n)? n : null; }

function extractProfileFromMessages(messages){
  const profile = { goal:null, weight_kg:null, height_cm:null, age:null, sex:null, activity:null, preferred_diet:null, allergies:[], conditions:[] };

  for (const m of messages){
    const text = normalizeArabic(String(m.content||""));
    if (!text) continue;

    let w = text.match(WEIGHT_RE_NAMED) || text.match(WEIGHT_RE_COMPACT) || text.match(WEIGHT_RE_TIGHT);
    if (w && profile.weight_kg==null) profile.weight_kg = tryNum(w[1]);

    let h = text.match(HEIGHT_RE) || text.match(HEIGHT_COMPACT);
    if (h && profile.height_cm==null) profile.height_cm = tryNum(h[1]);

    let a = text.match(AGE_RE) || text.match(AGE_COMPACT);
    if (a && profile.age==null) profile.age = tryNum(a[1]);

    let sx= text.match(SEX_RE);
    if (sx) profile.sex = mapSex(sx[1]) || profile.sex;

    const g = text.match(GOAL_RE); if (g) profile.goal = mapGoal(g[0]) || profile.goal;
    const d = text.match(DIET_RE); if (d) profile.preferred_diet = d[1].replace(/^الكيتو$/,"كيتو");
    const act= text.match(ACT_RE); if (act) profile.activity = mapActivity(act[1]) || profile.activity;

    const dis= text.match(DISEASE_RE); if (dis && !profile.conditions.includes(dis[1])) profile.conditions.push(dis[1]);
    const al = text.match(ALLERGY_RE);
    if (al){
      const list = al[2].split(/[،,]/).map(s=>normalizeArabic(s)).filter(Boolean);
      for (const item of list){ if (!profile.allergies.includes(item)) profile.allergies.push(item); }
    }

    // صيغة سريعة مثل: "104ك 181 سم 38 عام خفيف ذكر"
    if (/\bخفيف\b/.test(text) && !profile.activity) profile.activity = "light";
    if (/\bقليل الحركة\b/.test(text) && !profile.activity) profile.activity = "sedentary";
  }

  if (!profile.allergies.length) delete profile.allergies;
  if (!profile.conditions.length) delete profile.conditions;

  Object.keys(profile).forEach(k=> (profile[k]==null || profile[k]==="") && delete profile[k]);
  return profile;
}

/* ======================= Intent detection ======================= */
const INTENTS = [
  {
    id: "calc_tdee_macros",
    re: /(احسب|حساب)\s+(?:سعرات|سعراتي|tdee|الاحتياج|طاقة|ماكروز|macros)|(?:سعراتي|كم\s+سعره)|(?:أريد|اريد)\s+حساب\s+(?:سعرات|ماكروز)|(?:السعرات\s*اول[اًا]?)/i,
    needs: ["goal","weight_kg","height_cm","age","activity","sex"]
  },
  { id: "recommend_diet", re: /(رشح|اقترح|أفضل)\s+(?:نظام|حمية|رجيم)|اي\s+نظام\s+يناسبني|ماذا\s+أختار\s+من\s+الأنظمة/i, needs:["goal","activity","allergies","preferred_diet","conditions"] },
  { id: "meal_plan", re: /(خطة|برنامج|وجبات)\s+(?:يومي|اسبوعي|أسبوعي|شامل)|رتب\s+وجباتي|قسّم\s+سعراتي/i, needs:["goal","weight_kg","activity","preferred_diet","allergies"] },
  { id: "adjust_recipe", re: /(عدّل|بدّل|بدائل|بديل)\s+(?:مكونات|وصفة|طبق)|(?:هل\s+هذه\s+الوجبة\s+مناسبة)/i, needs:["goal","allergies","preferred_diet"] }
];
function detectIntent(text){
  const t = normalizeArabic(text||"");
  for (const it of INTENTS){ if (it.re.test(t)) return it; }
  if (/(ماكروز|سعرات|tdee|رجيم|نظام|خطة|وجبات)/i.test(t)){
    return { id:"generic_diet_help", re:/./, needs:["goal","weight_kg","height_cm","age","activity","sex"] };
  }
  return null;
}
function inferMissing(profile, needs){
  const missing = [];
  for (const key of (needs||[])){
    if (profile[key]==null || (Array.isArray(profile[key]) && !profile[key].length)) missing.push(key);
  }
  return missing;
}
function humanizeMissing(missing){
  const map = {
    goal: "هدفك الحالي (خسارة/زيادة وزن أو بناء عضل…)",
    weight_kg: "وزنك بالكيلوغرام",
    height_cm: "طولك بالسنتيمتر",
    age: "عمرك",
    sex: "جنسك (ذكر/أنثى)",
    activity: "مستوى نشاطك اليومي (خامل/خفيف/متوسط/عالٍ)",
    preferred_diet: "تفضيلك للنظام (مثل: متوسطي/لو-كارب/نباتي… إن وجد)",
    allergies: "أي حساسيات غذائية",
    conditions: "حالات صحية مهمة (مثل سكري/ضغط… إن وجدت)"
  };
  return missing.map(k=> map[k] || k);
}

/* ======================= Calories & macros ======================= */
function mifflinStJeor({ sex, weight_kg, height_cm, age }){
  if (!sex || !weight_kg || !height_cm || !age) return null;
  const base = (10*weight_kg) + (6.25*height_cm) - (5*age) + (sex==="male"? 5 : -161);
  return Math.max(800, Math.round(base));
}
function activityFactor(activity){
  switch(activity){
    case "sedentary": return 1.2;
    case "light":     return 1.375;
    case "moderate":  return 1.55;
    case "active":    return 1.725;
    default:          return 1.3;
  }
}
function calcTargets(profile){
  const bmr = mifflinStJeor(profile);
  if (bmr==null) return null;
  const tdee = Math.round(bmr * activityFactor(profile.activity || "light"));
  let target = tdee;
  if (profile.goal === "loss")      target = Math.max(1000, Math.round(tdee * 0.8));  // -20%
  else if (profile.goal === "gain") target = Math.round(tdee * 1.1);                   // +10%

  const isKeto = String(profile.preferred_diet||"").includes("كيتو");
  const protein_g = Math.round((profile.weight_kg || 70) * 1.8);
  let carbs_g, fat_g;

  if (isKeto){
    const carbs_kcal  = Math.round(target * 0.07); // 5–10%
    const fat_kcal    = Math.max(0, target - (protein_g*4) - carbs_kcal);
    carbs_g           = Math.round(carbs_kcal / 4);
    fat_g             = Math.round(fat_kcal / 9);
  } else {
    const fat_kcal    = Math.round(target * 0.28);
    fat_g             = Math.round(fat_kcal / 9);
    const carb_kcal   = Math.max(0, target - (protein_g*4) - fat_kcal);
    carbs_g           = Math.round(carb_kcal / 4);
  }

  return { bmr, tdee, target, protein_g, fat_g, carbs_g };
}

/* ======================= Guardrails (منطق gemini-proxy) ======================= */
function buildGuardrails({ lang="ar", useImageBrief=false, level="strict" }){
  const L = (lang === "ar") ? {
    mirror: "أجب حصراً باللغة العربية الظاهرة. لا تخلط لغات ولا تضف ترجمة.",
    beBrief: "اختصر الحشو وركّز على خطوات قابلة للتنفيذ بنبرة بشرية طبيعية.",
    imageBrief: "إن وُجدت صور: 3–5 نقاط تنفيذية دقيقة + خطوة فورية. دون مقدمات.",
    strict: "لا تختلق. عند الشك اطلب المعلومة الناقصة. اذكر الافتراضات والوحدات. أظهر الحسابات بدقة. التزم بالتوجيه حرفيًا."
  } : {
    mirror: "Answer strictly in the user's language. No mixing or translations.",
    beBrief: "Cut fluff; give precise, actionable steps in a human tone.",
    imageBrief: "If images exist: 3–5 actionable bullets + one immediate step. No preamble.",
    strict: "No fabrication. Ask for missing details. State assumptions/units. Show math accurately. Follow instructions exactly."
  };
  const lines = [L.mirror, L.beBrief, (useImageBrief ? L.imageBrief : ""), (level !== "relaxed" ? L.strict : "")].filter(Boolean);
  return `تعليمات حراسة موجزة (اتبعها بدقة):\n${lines.join("\n")}`;
}

/* ======================= Generation tuning (منطق gemini-proxy) ======================= */
function clampNumber(n, min, max, fallback){ const v = Number.isFinite(+n) ? +n : fallback; return Math.max(min, Math.min(max, v)); }
const MAX_OUTPUT_TOKENS_HARD = 8192;
function tuneGeneration({ temperature, top_p, max_output_tokens, useImageBrief, mode }) {
  let t   = (temperature   === undefined || temperature   === null) ? (useImageBrief ? 0.25 : 0.30) : temperature;
  let tp  = (top_p         === undefined || top_p         === null) ? 0.88 : top_p;
  let mot = (max_output_tokens === undefined || max_output_tokens === null)
              ? (useImageBrief ? 1536 : 6144)
              : max_output_tokens;

  if (mode === "qa" || mode === "factual") {
    t  = Math.min(t, 0.24);
    tp = Math.min(tp, 0.9);
    mot= Math.max(mot, 3072);
  }

  t   = clampNumber(t,   0.0, 1.0, 0.30);
  tp  = clampNumber(tp,  0.0, 1.0, 0.88);
  mot = clampNumber(mot, 1, MAX_OUTPUT_TOKENS_HARD, 6144);

  return { temperature: t, topP: tp, maxOutputTokens: mot };
}

/* ======================= Nutrition Knowledge Pack ======================= */
function nutritionPrimer(){
  return `
[حزمة معرفة تغذوية عملية — مرجع داخلي]
- الطاقة: 1g بروتين = 4 ك.سع، 1g كربوهيدرات = 4 ك.سع، 1g دهون = 9 ك.سع.
- بروتين: 1.6–2.2 جم/كجم وزن للحفاظ على الكتلة؛ حتى 2.4 جم/كجم لعجز كبير عند الرياضيين.
- دهون: 20–35% من السعرات، ولا تقل غالبًا عن 0.6 جم/كجم. في الكيتو أعلى، والكارب منخفض.
- كربوهيدرات: الباقي بعد البروتين والدهون؛ للكيتو صافي كارب ≈ 20–50 جم/يوم (5–10%).
- ألياف: 25–38 جم/يوم؛ ارفع تدريجيًا مع الترطيب.
- ترطيب: 30–35 مل/كجم/يوم مرجع أولي؛ راقب لون البول والنشاط/الطقس.
- نشاط تقريبي: خامل 1.2، خفيف 1.375، متوسط 1.55، عالٍ 1.725.
- توزيع: 3–4 وجبات مع 25–40 جم بروتين/وجبة للشبع والحفاظ على الكتلة.
- حساسات شائعة: جلوتين/لاكتوز/مكسرات/بيض/أسماك/صويا — احترم القيود.
- حالات خاصة (سكري/ضغط/كلى/كبد): تجنّب وصفات علاجية؛ انصح بمراجعة مختص.
- تذكير: السعرات = 4P + 4C + 9F.
`.trim();
}

/* ======================= System prompt ======================= */
function systemPrompt(){
  return `
أجب بالعربية حصراً وبأسلوب واتساب موجز (3–8 أسطر)، عملي، دقيق، وشخصي.
- ردّ التحية والسلام، ثم اطرح سؤالًا واحدًا أو اثنين بأقصى حد لاستكمال البيانات.
- عند تأكيد قصير (نعم/تمام/أوكي): تابع الإجراء السابق مباشرة (حساب/ترشيح/خطة) دون اعتذار.
- إن لم يُجَب سؤالك: أعد نفس السؤال مرة واحدة بلطف مع سبب الحاجة.
- عند سؤال جديد يحتاج بيانات ناقصة: راجع المحادثة، واطلب فقط الناقص (سؤال واحد أو اثنان).
- التزم بالنطاق الغذائي فقط؛ خارج النطاق اعتذر بلطف ووجّه للسياق الصحيح.
${nutritionPrimer()}
`.trim();
}

/* ======================= Utilities ======================= */
function sanitizeReply(t=""){
  let s = String(t||"");
  s = s.replace(/```[\s\S]*?```/g,"").trim();
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu,"");
  s = s.replace(/\n{3,}/g,"\n\n").trim();
  return s;
}
function toGeminiContents(messages){
  const hist = (Array.isArray(messages)? messages : []).slice(-16);
  return hist.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content||"") }]
  }));
}
function lastUserMessage(messages){
  for (let i = messages.length - 1; i >= 0; i--){
    if (messages[i].role === "user") return String(messages[i].content||"");
  }
  return "";
}
function lastAssistantMessage(messages){
  for (let i = messages.length - 1; i >= 0; i--){
    if (messages[i].role === "assistant") return String(messages[i].content||"");
  }
  return "";
}

const CORE_Q_HINTS = /(هدفك|وزنك|طولك|عمرك|جنسك|نشاطك)/i;
function userProvidedCoreData(textRaw){
  const text = normalizeArabic(textRaw||"");
  return !!(
    text.match(WEIGHT_RE_NAMED) || text.match(WEIGHT_RE_COMPACT) || text.match(WEIGHT_RE_TIGHT) ||
    text.match(HEIGHT_RE) || text.match(HEIGHT_COMPACT) ||
    text.match(AGE_RE) || text.match(AGE_COMPACT) ||
    text.match(GOAL_RE) || text.match(ACT_RE) || text.match(SEX_RE)
  );
}
function needsReAsk(messages){
  const lastUser = lastUserMessage(messages) || "";
  const lastBot  = lastAssistantMessage(messages) || "";
  if (!lastBot) return false;
  if (ACK_RE.test((lastUser||"").trim())) return false;
  const botAskedQuestion = /[؟?]\s*$/.test(lastBot) || CORE_Q_HINTS.test(lastBot);
  const userNonAnswer = (!lastUser.trim()) || (!userProvidedCoreData(lastUser) && !SCOPE_ALLOW_RE.test(lastUser));
  return botAskedQuestion && userNonAnswer;
}

/* ======================= Content builders ======================= */
function buildGreetingPrompt(){
  return { role:"user", parts:[{ text:
`وُجدت تحية/سلام من المستخدم. اكتب ردًا موجزًا:
- ردّ السلام والتحية وقدّم نفسك كمساعد تغذية عملي ودقيق.
- اسأل عن الهدف (خسارة/زيادة وزن، بناء عضل، ضبط سكر…).
- اطلب الوزن والطول والعمر والجنس ومستوى النشاط في سؤال واحد أو اثنين.` }] };
}
function buildOffScopePrompt(){
  return { role:"user", parts:[{ text:
`السؤال خارج التغذية. اكتب ردًا موجزًا جدًا:
- اعتذار لطيف وأنك مساعد تغذية فقط.
- اطلب إعادة الصياغة ضمن التغذية (أنظمة/سعرات/ماكروز/وجبات/بدائل/حساسيات…).
- اختم بسؤال واحد لإرجاع النقاش للنطاق (ما هدفك الغذائي الآن؟).` }] };
}
function buildReAskPrompt(messages){
  const lastBot = lastAssistantMessage(messages) || "من فضلك زودني بوزنك وطولك وعمرك وجنسك ومستوى نشاطك.";
  const polite = `لم أتلقَّ إجابة عن سؤالي السابق، وهذه المعلومة ضرورية لإتمام طلبك بدقة:\n"${lastBot}"`;
  return { role:"user", parts:[{ text: polite }] };
}
function buildPersonalizerHint(lastMsg){
  const guard = buildGuardrails({ lang:"ar", useImageBrief:false, level:"strict" });
  const text = `${guard}\n\nحلّل رسالة المستخدم وخصّص الرد بناءً على المحادثة كاملة، مع سؤالٍ واحد أو سؤالين فقط:\n"""${normalizeArabic(lastMsg||"")}"""`;
  return { role:"user", parts:[{ text }] };
}
function buildContinuationHint(lastAssistant, lastUser){
  const guard = buildGuardrails({ lang:"ar", useImageBrief:false, level:"strict" });
  const text = `${guard}\n\nرسالة المستخدم تأكيد قصير: """${normalizeArabic(lastUser)}"""\nسؤالك السابق: """${lastAssistant||""}"""\nتابِع الإجراء المقترح مباشرة (حساب/ترشيح/خطة) دون اعتذار أو تكرار غير لازم.`;
  return { role:"user", parts:[{ text }] };
}

function buildComputeCaloriesPrompt(profile, targets){
  const p = { ...profile }, t = { ...targets };
  const readableActivity = {sedentary:"قليل/خامل", light:"خفيف", moderate:"متوسط", active:"عالٍ"}[p.activity] || p.activity;
  const readableGoal = {loss:"خسارة", gain:"زيادة", maintain:"تثبيت"}[p.goal] || p.goal;

  const text = `
البيانات مكتملة، أعطِ خلاصة احترافية موجزة:
- ${p.sex==="male"?"ذكر":"أنثى"}, ${p.age} سنة، ${p.height_cm} سم، ${p.weight_kg} كجم، نشاط ${readableActivity}، هدف ${readableGoal}${p.preferred_diet?`, نظام مفضل: ${p.preferred_diet}`:""}.
- BMR ≈ ${t.bmr} ك.سع، TDEE ≈ ${t.tdee} ك.سع، الهدف اليومي ≈ ${t.target} ك.سع.
- ماكروز تقريبية: بروتين ≈ ${t.protein_g} جم، دهون ≈ ${t.fat_g} جم، كربوهيدرات ≈ ${t.carbs_g} جم${String(p.preferred_diet||"").includes("كيتو")?" (صافي كارب منخفض للكيتوزيس)":""}.
- تذكير: السعرات = 4P + 4C + 9F.
- اختم بسؤال واحد: هل ترغب بتقسيم السعرات على الوجبات أو بخطة أسبوعية مختصرة؟`.trim();

  return { role:"user", parts:[{ text }] };
}

/* ===== كشف نية مُعلّقة من ردّ المساعد السابق ===== */
const PENDING_PATTERNS = [
  { id:"calc_tdee_macros", re: /(أحسب|أقوم بحساب|هل ترغب(?:\/)?(?: تريد)? في? حساب)\s+(?:السعرات|الماكروز|الاحتياج|tdee)/i },
  { id:"calc_tdee_macros", re: /(هل\s+أعطيك|هل\s+ترغب\s+بمعرفة)\s+(?:الأرقام|السعرات|الماكروز)/i }
];
function detectPendingIntentFromAssistant(assistantText){
  const t = normalizeArabic(assistantText||"");
  for (const p of PENDING_PATTERNS){ if (p.re.test(t)) return { id:p.id }; }
  return null;
}

function buildMissingInfoPrompt(intent, profile, missing, lastMsg){
  const known = Object.keys(profile||{})
    .map(k => `${k}: ${Array.isArray(profile[k]) ? profile[k].join(", ") : profile[k]}`)
    .join(", ") || "لا شيء مسجّل";
  const list = humanizeMissing(missing).join("، ");
  const why = intent?.id === "calc_tdee_macros"
    ? "لأحسب احتياجك بدقة"
    : intent?.id === "meal_plan"
      ? "لأبني لك خطة وجبات دقيقة"
      : intent?.id === "recommend_diet"
        ? "لأرشّح نظامًا مناسبًا لك"
        : "لإعطاء جواب دقيق";

  const guard = buildGuardrails({ lang:"ar", useImageBrief:false, level:"strict" });

  const text = `
${guard}

رسالة المستخدم:\n"""${normalizeArabic(lastMsg||"")}"""\n
المعروف: ${known}.
ناقص: ${list}.
اكتب ردًا موجزًا:
- جملة سبب: ${why}.
- اطلب فقط العناصر الناقصة بصياغة مباشرة (سؤال واحد أو سؤالان).`.trim();
  return { role:"user", parts:[{ text }] };
}

/* ======================= Model call ======================= */
async function callModel(model, contents, timeoutMs = 24000){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const generationConfig = tuneGeneration({
    temperature: 0.22, top_p: 0.9, max_output_tokens: 900, useImageBrief:false, mode:"qa"
  });

  const body = {
    systemInstruction: { role:"system", parts:[
      { text: systemPrompt() },
      { text: buildGuardrails({ lang:"ar", useImageBrief:false, level:"strict" }) }
    ] },
    contents,
    generationConfig,
    safetySettings: []
  };

  const abort = new AbortController();
  const t = setTimeout(()=>abort.abort(), Math.max(1200, Math.min(26000, timeoutMs)));

  try{
    const resp = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body),
      signal: abort.signal
    });
    const txt = await resp.text();
    let data = null; try{ data = JSON.parse(txt); }catch(_){}
    if(!resp.ok){
      const msg = data?.error?.message || `HTTP_${resp.status}`;
      return { ok:false, error: msg };
    }
    const reply =
      data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("") ||
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if(!reply || !reply.trim()) return { ok:false, error:"empty_reply" };
    return { ok:true, reply: sanitizeReply(reply) };
  }catch(e){
    return { ok:false, error: String(e && e.message || e) };
  }finally{
    clearTimeout(t);
  }
}

/* ======================= Handler ======================= */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  // Subscription
  try{
    const gate = await ensureActiveSubscription(event);
    if(!gate.ok) return bad(gate.code, gate.msg);
  }catch(_){
    return bad(500, "subscription_gate_error");
  }

  // Parse
  let body = {};
  try{ body = JSON.parse(event.body || "{}"); }
  catch{ return bad(400, "invalid_json_body"); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const scope = String(body.scope||"diet_only").toLowerCase();

  const lastUser = lastUserMessage(messages);
  const lastBot  = lastAssistantMessage(messages);

  // استخرج ملفّ المستخدم من السجل
  const profile  = extractProfileFromMessages(messages);
  const memoryCard = Object.keys(profile||{}).length
    ? { role:"user", parts:[{ text: `ملف المستخدم:\n${JSON.stringify(profile, null, 2)}\nاستخدمه كأساس حتى يُحدّثه المستخدم.` }] }
    : null;

  let contents;

  // 1) بداية بلا سجل → تحية ذكية
  if (!messages.length) {
    contents = [ buildGreetingPrompt() ];
  }
  // 2) تحية/سلام
  else if (GREET_RE.test(normalizeArabic(lastUser||""))) {
    contents = [ buildGreetingPrompt() ];
  }
  // 3) تأكيد قصير (نعم/أوكي) → تابع الإجراء السابق
  else if (ACK_RE.test((lastUser||"").trim())) {
    const pending = detectPendingIntentFromAssistant(lastBot||"");
    if (pending && pending.id === "calc_tdee_macros"){
      const miss = inferMissing(profile, INTENTS.find(i=>i.id==="calc_tdee_macros").needs);
      if (!miss.length){
        const targets = calcTargets(profile);
        if (targets){
          contents = [ ...(memoryCard ? [memoryCard] : []), buildComputeCaloriesPrompt(profile, targets) ];
        } else {
          contents = [ ...(memoryCard ? [memoryCard] : []),
            buildMissingInfoPrompt({id:"calc_tdee_macros"}, profile,
              inferMissing(profile, INTENTS.find(i=>i.id==="calc_tdee_macros").needs), lastUser) ];
        }
      } else {
        contents = [ ...(memoryCard ? [memoryCard] : []),
          buildMissingInfoPrompt({id:"calc_tdee_macros"}, profile, miss, lastUser) ];
      }
    } else {
      contents = [ ...(memoryCard ? [memoryCard] : []),
        ...toGeminiContents(messages.slice(-8)),
        buildContinuationHint(lastBot, lastUser) ];
    }
  }
  // 4) لم يُجِب المستخدم على سؤالنا السابق → أعد السؤال بلطف
  else if (needsReAsk(messages)) {
    contents = [ buildReAskPrompt(messages) ];
  }
  // 5) حارس النطاق + معالجة النيّات/النواقص
  else {
    const intent = detectIntent(lastUser || "");
    const missing = intent ? inferMissing(profile, intent.needs) : [];

    const recentDiet = messages.slice(-6).some(m => SCOPE_ALLOW_RE.test(String(m.content||"")));
    const isOffscope = (scope === "diet_only") && lastUser && !SCOPE_ALLOW_RE.test(lastUser) && !recentDiet;

    if (isOffscope){
      contents = [ buildOffScopePrompt() ];
    } else if (intent && missing.length){
      contents = [ ...(memoryCard ? [memoryCard] : []),
        buildMissingInfoPrompt(intent, profile, missing, lastUser) ];
    } else if (intent && intent.id === "calc_tdee_macros"){
      const targets = calcTargets(profile);
      if (targets){
        contents = [ ...(memoryCard ? [memoryCard] : []), buildComputeCaloriesPrompt(profile, targets) ];
      } else {
        contents = [ ...(memoryCard ? [memoryCard] : []),
          buildMissingInfoPrompt({id:"calc_tdee_macros"}, profile,
            inferMissing(profile, INTENTS.find(i=>i.id==="calc_tdee_macros").needs), lastUser) ];
      }
    } else {
      contents = [ ...(memoryCard ? [memoryCard] : []),
        ...toGeminiContents(messages),
        buildPersonalizerHint(lastUser||"") ];
    }
  }

  // استدعاء النموذج مع السقوط الآمن عبر الحوض
  const errors = {};
  for (const model of MODEL_POOL){
    const r = await callModel(model, contents);
    if (r.ok) return ok({ reply: r.reply, model });
    errors[model] = r.error;
  }
  return bad(502, "All models failed for your key/region on v1beta", { errors, tried: MODEL_POOL });
};
