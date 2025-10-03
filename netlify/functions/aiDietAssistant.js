// netlify/functions/aiDietAssistant.js
// Fully-AI WhatsApp-like diet assistant (Arabic) — ذكي جدًا، سياقي، مهني، يراجع كل المحادثة، ويملأ البيانات الناقصة.
// ✅ الميزات الجوهرية:
//   1) يردّ التحية ويرحّب دون افتراض أهداف.
//   2) يلتزم بالنطاق الغذائي فقط، ويعيد توجيه أي سؤال خارج التغذية بلطف.
//   3) يطبع المحادثة ذهنيًا (normalize) ليحتمل الأخطاء الإملائية والأرقام العربية، ثم يستخرج الخانات (Slots).
//   4) مدير نوايا (Intents) + ملء خانات: يحدد المطلوب لكل نية ويطلب فقط الناقص بسؤال واحد أو اثنين.
//   5) منع التكرار: إذا لم يُجب المستخدم عن سؤالٍ محدد، يُعاد نفس السؤال مرة واحدة بلطف مع سبب الحاجة (Anti-loop).
//   6) يتابع عند رسائل التأكيد القصيرة (نعم/تمام/أوكي) دون اعتذار ويكمل المسار السابق.
//   7) حساب TDEE/السعرات (Mifflin–St Jeor) + عامل نشاط + عجز مدروس لخسارة الوزن، مع تذكير 4/4/9 عند الحاجة.
//   8) أسلوب عربي فصيح موجز (3–8 أسطر)، سؤال واحد أو سؤالان كحد أقصى.
//   9) نفس بوابة الاشتراك والـ model pool المستخدمة في توليد الوصفات.
//
// POST { messages:[{role,content}], lang?: "ar", scope?: "diet_only" } -> { ok, reply, model }

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/* ===== Same model pool as generateRecipe ===== */
const MODEL_POOL = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro",
  "gemini-1.5-pro-001",
  "gemini-pro",
  "gemini-1.0-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash-latest"
];

/* ===== GitHub helpers for subscription gate ===== */
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

/* ===== HTTP helpers ===== */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Session-Nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

/* ===== Subscription gate (same as generateRecipe) ===== */
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

/* ===== Regex guards & shortcuts ===== */
// لا نرفض التحية أو التأكيد القصير حتى لو بلا كلمات تغذوية.
const SCOPE_ALLOW_RE =
  /(?:سعرات|كالوري|كالور|ماكروز|بروتين|دهون|كارب|كربوهيدرات|ألياف|ماء|ترطيب|نظام|حِمية|رجيم|وجبة|وصفات|غذائ|صيام|كيتو|لو ?كارب|متوسطي|داش|نباتي|سعر حراري|مؤشر جلايسيمي|حساسي|تحسس|سكري|ضغط|كلى|كبد|كوليسترول|وجبات|تقسيم السعرات|macro|protein|carb|fat|fiber|calorie|diet|meal|fasting|glycemic|keto|mediterranean|dash|vegan|lchf|cut|bulk|maintenance)/i;

const GREET_RE = /^(?:\s*(?:السلام\s*عليكم|وعليكم\s*السلام|مرحبا|مرحباً|أهلًا|اهلاً|هلا|مساء الخير|صباح الخير|سلام)\b|\s*السلام\s*)$/i;
const ACK_RE   = /^(?:نعم|اي|إي|ايوه|أيوه|أجل|تمام|حسنًا|حسنا|طيب|اوكي|أوكي|Ok|OK|Yes|Okay)\s*\.?$/i;

/* =========================
   تطبيع عربي قبل الاستخراج
   ========================= */
const AR_DIGITS = /[\u0660-\u0669]/g;       // ٠-٩
const AR_PEH    = /پ/g;  // احتياطي
const AR_GAF    = /گ/g;  // احتياطي
const TASHKEEL  = /[\u064B-\u0652]/g;
const EXTRA     = /[^\S\r\n]+/g;

const COMMON_FIXES = [
  [/خصارة|خساره|خصاره/g, "خسارة"],
  [/سقليل|سليل|قليل ?الحرك[هة]م?|قليل الحركه/g, "قليل الحركة"],
  [/طؤل|طؤلي|طول[ي]?/g, "طول"],
  [/وزني|الوزن/g, "وزن"],
  [/عمري|العمر/g, "عمر"],
  [/سم(?=\d)/g, "سم "],
  [/كجم|كغ|كيلو ?جرام|كيلو جرام/g, "كجم"],
  [/ك(?=\s|$)/g, "كجم"],
  [/سم(?=\s|$)/g, "سم"],
  [/نشاطي|مستوى النشاط/g, "نشاط"],
  [/ذكر|رجل/g, "ذكر"],
  [/أنثى|امرأة|انثى/g, "أنثى"],
];

function arabicDigitsToLatin(s){
  return s.replace(AR_DIGITS, ch => String(ch.charCodeAt(0) - 0x0660));
}
function normalizeArabic(s=""){
  let t = String(s||"");
  t = arabicDigitsToLatin(t);
  t = t.replace(TASHKEEL,"");
  for (const [re, rep] of COMMON_FIXES){ t = t.replace(re, rep); }
  t = t.replace(AR_PEH,"ب").replace(AR_GAF,"ك");
  t = t.replace(/\s+/g," ").trim();
  return t;
}

/* ==============================
   استخراج الخانات (Slots) الذكي
   ============================== */
// Regex مرنة للأرقام مع الوحدات
const NUM = "(\\d{1,3}(?:[\\.,]\\d{1,2})?)";
const WEIGHT_RE = new RegExp(`(?:وزن|وزنك|weight)[:=\\s]*${NUM}\\s*(?:كجم|kg)?`,"i");
const HEIGHT_RE = new RegExp(`(?:طول|طولك|height)[:=\\s]*${NUM}\\s*(?:سم|cm)?`,"i");
const AGE_RE    = new RegExp(`(?:عمر|عمرك|age)[:=\\s]*(${NUM})`,"i");
const SEX_RE    = /\b(ذكر|أنثى)\b/i;
const GOAL_RE   = /(خسارة|نقص|تنزيل|تخسيس|زيادة|بناء|تثبيت)\s*(?:وزن|عضل|كتلة)?/i;
const DIET_RE   = /(كيتو|لو ?كارب|متوسطي|داش|نباتي|paleo|صيام متقطع)/i;
const ALLERGY_RE= /(حساسي(?:ة|ات)|لا(?: أتحمل| أتناول)|تحسس)\s*[:=]?\s*([^.\n،]+)/i;
const ACT_RE    = /(خامل|قليل الحركة|خفيف|متوسط|عال(?:ي)?(?:\s*النشاط)?|sedentary|light|moderate|active)/i;
const DISEASE_RE= /(سكر[يي]?|ضغط|كلى|كبد|دهون(?: على)? الكبد|كوليسترول|نقرس)/i;

function mapActivity(aRaw=""){
  const s = aRaw.toLowerCase();
  if (/خامل|قليل/.test(s) || /sedentary/.test(s)) return "sedentary";
  if (/خفيف|light/.test(s)) return "light";
  if (/متوسط|moderate/.test(s)) return "moderate";
  if (/عال/.test(s) || /active/.test(s)) return "active";
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
  const profile = {
    goal: null, weight_kg: null, height_cm: null, age: null,
    sex: null, activity: null, preferred_diet: null, allergies: [], conditions: []
  };
  for (const m of messages){
    const original = String(m.content||"");
    const text = normalizeArabic(original);

    const w = text.match(WEIGHT_RE); if (w) profile.weight_kg = tryNum(w[1]);
    const h = text.match(HEIGHT_RE); if (h) profile.height_cm = tryNum(h[1]);
    const a = text.match(AGE_RE);    if (a) profile.age = tryNum(a[1]);
    const sx= text.match(SEX_RE);    if (sx) profile.sex = mapSex(sx[1]) || profile.sex;

    const g = text.match(GOAL_RE);   if (g) profile.goal = mapGoal(g[0]) || profile.goal;
    const d = text.match(DIET_RE);   if (d) profile.preferred_diet = d[1];

    const act= text.match(ACT_RE);   if (act) profile.activity = mapActivity(act[1]) || profile.activity;

    const dis= text.match(DISEASE_RE); if (dis && !profile.conditions.includes(dis[1])) profile.conditions.push(dis[1]);
    const al = text.match(ALLERGY_RE);
    if (al){
      const list = al[2].split(/[،,]/).map(s=>normalizeArabic(s)).filter(Boolean);
      for (const item of list){ if (!profile.allergies.includes(item)) profile.allergies.push(item); }
    }

    // دعم صيغة سريعة: "181 سم 104 ك 38 عام ذكر قليل الحركة"
    // الطول
    if (profile.height_cm==null){
      const h2 = text.match(new RegExp(`${NUM}\\s*سم`,"i")); if (h2) profile.height_cm = tryNum(h2[1]);
    }
    // الوزن
    if (profile.weight_kg==null){
      const w2 = text.match(new RegExp(`${NUM}\\s*(?:كجم|kg)`,"i")); if (w2) profile.weight_kg = tryNum(w2[1]);
    }
    // العمر رقم عارٍ متبوع ب (عام|سنة)
    if (profile.age==null){
      const a2 = text.match(new RegExp(`${NUM}\\s*(?:عام|سنة)`,"i")); if (a2) profile.age = tryNum(a2[1]);
    }
  }

  if (!profile.allergies.length) delete profile.allergies;
  if (!profile.conditions.length) delete profile.conditions;
  Object.keys(profile).forEach(k=> (profile[k]==null || profile[k]==="") && delete profile[k]);
  return profile;
}

function buildMemoryCard(profile){
  if (!profile || !Object.keys(profile).length) return null;
  return {
    role:"user",
    parts:[{ text:
`ملف المستخدم (مستخلص من المحادثة السابقة):
${JSON.stringify(profile, null, 2)}
استخدم هذه المعطيات كأساس افتراضي حتى يغيّرها المستخدم. خصّص التوصيات وفقًا لها.` }]
  };
}

/* ==============
   Intent detector
   ============== */
const INTENTS = [
  {
    id: "calc_tdee_macros",
    re: /(احسب|حساب)\s+(?:سعرات|tdee|الاحتياج|طاقة|ماكروز|macros)|(?:سعراتي|كم\s+سعره)|(?:اريد|أريد)\s+حساب\s+(?:سعرات|ماكروز)|(?:السعرات\s*اول[اًا]?)/i,
    needs: ["goal","weight_kg","height_cm","age","activity","sex"]
  },
  {
    id: "recommend_diet",
    re: /(رشح|اقترح|أفضل)\s+(?:نظام|حمية|رجيم)|اي\s+نظام\s+يناسبني|ماذا\s+أختار\s+من\s+الأنظمة/i,
    needs: ["goal","activity","allergies","preferred_diet","conditions"]
  },
  {
    id: "meal_plan",
    re: /(خطة|برنامج|وجبات)\s+(?:يومي|اسبوعي|أسبوعي|شامل)|رتب\s+وجباتي|قسّم\s+سعراتي/i,
    needs: ["goal","weight_kg","activity","preferred_diet","allergies"]
  },
  {
    id: "adjust_recipe",
    re: /(عدّل|بدّل|بدائل|بديل)\s+(?:مكونات|وصفة|طبق)|(?:هل\s+هذه\s+الوجبة\s+مناسبة)/i,
    needs: ["goal","allergies","preferred_diet"]
  }
];

function detectIntent(text){
  const t = normalizeArabic(text||"");
  for (const it of INTENTS){
    if (it.re.test(t)) return it;
  }
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

/* ==================
   حساب TDEE والسعرات
   ================== */
function mifflinStJeor({ sex, weight_kg, height_cm, age }){
  if (!sex || !weight_kg || !height_cm || !age) return null;
  // BMR = (10 * weight) + (6.25 * height) - (5 * age) + s
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
  if (profile.goal === "loss")      target = Math.max(1000, Math.round(tdee * 0.8));  // عجز ~20%
  else if (profile.goal === "gain") target = Math.round(tdee * 1.1);                   // فائض ~10%
  // توزيع ماكروز افتراضي بسيط (يمكن للموديل شرحه):
  // بروتين 1.6–2.2 جم/كجم (نختار 1.8 افتراضيًا)، دهون 25–30%، والباقي كارب.
  const protein_g = Math.round((profile.weight_kg || 70) * 1.8);
  const fat_kcal  = Math.round(target * 0.28);
  const fat_g     = Math.round(fat_kcal / 9);
  const prot_kcal = protein_g * 4;
  const carb_kcal = Math.max(0, target - fat_kcal - prot_kcal);
  const carbs_g   = Math.round(carb_kcal / 4);
  return { bmr, tdee, target, protein_g, fat_g, carbs_g };
}

/* ======================
   حوارات موجّهة للموديل
   ====================== */
function systemPrompt(){
  return `
أنت مساعد تغذية عربي يعمل بأسلوب دردشة واتساب، ودود وعملي ودقيق.
مهمتك: تقديم إرشاد غذائي عملي ومخصص **فقط بناءً على ما يذكره المستخدم صراحة**.

[النطاق]
- التغذية والأنظمة (كيتو/متوسطي/داش/نباتي/لو-كارب/صيام متقطع…)،
- حساب السعرات والماكروز (4/4/9)،
- بدائل المكوّنات، تقييم الوجبات، الحساسيات، إدارة الوزن، الترطيب، توقيت/تحضير الوجبات.

[المحظور]
- لا تفترض هدفًا أو حالة غير مذكورة.
- لا مواضيع خارج التغذية، ولا تشخيص طبي أو جرعات دواء.

[الأسلوب]
- عند التحية: ردّ التحية وعرّف نفسك ثم اسأل عن الهدف والبيانات الأساسية (وزن/طول/عمر/نشاط) في سؤال واحد أو سؤالين.
- عند رسالة تأكيد قصيرة: تابع مباشرةً آخر إجراء منطقي (حساب/ترشيح/خطة) بلا اعتذار.
- إذا لم يُجب المستخدم عن سؤالك: أعد طرح **نفس السؤال** بلطف وبصياغة مباشرة، مع جملة قصيرة توضح سبب الحاجة.
- إذا طرح المستخدم سؤالًا جديدًا يتطلّب بيانات ناقصة: راجع التاريخ، واطلب **فقط المفقود** لإكمال الإجابة الدقيقة (سؤال واحد أو سؤالان).
- الرد موجز (3–8 أسطر) وبالعربية الفصحى المبسطة، ويمكن استخدام نقاط مختصرة.
- بلا وجوه تعبيرية ولا زخارف.

[الحسابات]
- السعرات = (4×البروتين + 4×الكربوهيدرات + 9×الدهون). اذكرها عند الحاجة.

[الذاكرة]
- راجع المحادثة كاملة. اعتبر القياسات/الحساسيات/التفضيلات المذكورة سابقًا افتراضًا حتى يُغيّرها المستخدم.
- لا تُدخل معلومات من خارج المحادثة.
`.trim();
}

function sanitizeReply(t=""){
  let s = String(t||"");
  s = s.replace(/```[\s\S]*?```/g,"").trim();   // إزالة أسوار الأكواد
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu,"");   // إزالة الإيموجي
  s = s.replace(/\n{3,}/g,"\n\n").trim();        // تقليم الأسطر
  return s;
}

function toGeminiContents(messages){
  // نمرر التاريخ كما هو (للفهم العام)، لكن الاستخراج تم على النسخة المُطبَّعة.
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

/* ===== Re-ask & continuation helpers ===== */
const CORE_Q_HINTS = /(هدفك|هدفك\s+الحالي|وزنك|طولك|عمرك|نشاطك)/i;
function userProvidedCoreData(textRaw){
  const text = normalizeArabic(textRaw||"");
  return !!(
    text.match(WEIGHT_RE)||
    text.match(HEIGHT_RE)||
    text.match(AGE_RE)||
    text.match(GOAL_RE)||
    text.match(ACT_RE)||
    text.match(SEX_RE)
  );
}
function needsReAsk(messages){
  const lastUser = lastUserMessage(messages) || "";
  const lastBot  = lastAssistantMessage(messages) || "";
  if (!lastBot) return false;
  const botAskedQuestion = /[؟?]\s*$/.test(lastBot) || CORE_Q_HINTS.test(lastBot);
  const userNonAnswer = (!lastUser.trim()) || GREET_RE.test(lastUser) || ACK_RE.test(lastUser) || (!userProvidedCoreData(lastUser) && !SCOPE_ALLOW_RE.test(lastUser));
  return botAskedQuestion && userNonAnswer;
}
function buildReAskPrompt(messages){
  const lastBot = lastAssistantMessage(messages) || "";
  const fallback = "من فضلك أخبرني بوضوح عن هدفك (خسارة/زيادة وزن أو بناء عضل) واذكر: وزنك، طولك، عمرك، جنسك، ومستوى نشاطك اليومي، لأكمل الحساب بدقة.";
  const question = lastBot && lastBot.trim() ? lastBot.trim() : fallback;
  const polite = `لم أتلقَّ إجابة عن سؤالي السابق. أعد طرحه بلطف وبشكل مباشر مع سبب الحاجة:\n"""${question}"""`;
  return { role:"user", parts:[{ text: polite }] };
}
function buildContinuationHint(lastAssistant, lastUser){
  const text = `
رسالة المستخدم قصيرة وتعبّر عن التأكيد: """${normalizeArabic(lastUser)}"""
رسالتك السابقة كانت: """${lastAssistant || "(لا توجد)"}"""
تابِع الإجراء المقترح في رسالتك السابقة مباشرةً (مثل: حساب السعرات/الماكروز، ترشيح نظام، أو طلب البيانات الأساسية) بلا اعتذار، وبسؤال واحد على الأكثر.`.trim();
  return { role:"user", parts:[{ text }] };
}

/* ===== Content shapers ===== */
function buildGreetingPrompt(){
  return {
    role:"user",
    parts:[{ text:
`وُجدت تحية/سلام من المستخدم. اكتب ردًا عربيًا موجزًا:
- ابدأ بالسلام المناسب والتحية الودية.
- عرّف نفسك كمساعد تغذية يقدم إرشادًا عمليًا مخصصًا.
- اسأل سؤالًا موجّهًا عن الهدف (خسارة/زيادة وزن، بناء عضل، ضبط سكر…).
- في نفس الرسالة اطلب: الوزن، الطول، العمر، الجنس، مستوى النشاط (سؤال واحد أو سؤالان).
- لا تفترض أي هدف غير مذكور.` }] }
}
function buildOffScopePrompt(){
  return {
    role:"user",
    parts:[{ text:
`السؤال خارج نطاق التغذية. اكتب ردًا عربيًا موجزًا جدًا يوضح:
- اعتذار لطيف وأنك مساعد تغذية فقط.
- اطلب إعادة الصياغة ضمن التغذية (أنظمة/سعرات/ماكروز/وجبات/بدائل/حساسيات…).
- اختم بسؤال واحد فقط لإرجاع النقاش للنطاق (مثال: ما هدفك الغذائي الآن؟).` }] }
}
function buildPersonalizerHint(lastMsg){
  const hints = [
    "حلّل رسالة المستخدم لاستخراج الهدف والتفضيلات والحساسيات والقيود.",
    "اقترح أنظمة ملائمة أو احسب السعرات/الماكروز عند الطلب.",
    "اربط الرد بما سبق في المحادثة، وذكّر بالمعلومات المهمة عند الحاجة.",
    "اختصر الرد (3–8 أسطر) واستخدم سؤالًا واحدًا أو سؤالين فقط."
  ].join("\n- ");
  return { role:"user", parts:[{ text:
`هذه رسالة المستخدم للتحليل الشخصي:\n"""${normalizeArabic(lastMsg)}"""\n\n- ${hints}` }] };
}

/* ===== Specialized prompts when data is complete ===== */
function buildComputeCaloriesPrompt(profile, targets){
  const p = { ...profile };
  const t = { ...targets };
  // نجعل الموديل يقدّم الجواب مهنيًا وبالعربية الموجزة:
  const text = `
لديك كل البيانات اللازمة لحساب السعرات والماكروز. اكتب ردًا عربيًا موجزًا ومحترفًا:
- أكّد الاستلام: ذكر، عمر ${p.age}، طول ${p.height_cm} سم، وزن ${p.weight_kg} كجم، نشاط ${p.activity}، هدف ${p.goal}.
- اعرض BMR و TDEE وهدف السعرات اليومي (${t.target} ك.سع) مع الإشارة إلى سبب العجز/الفائض حسب الهدف.
- اقترح ماكروز تقريبية: بروتين ~${t.protein_g} جم، دهون ~${t.fat_g} جم، كارب ~${t.carbs_g} جم.
- ذكّر بصيغة الطاقة: السعرات = 4P + 4C + 9F.
- أختم بسؤال واحد فقط (مثال: هل تفضّل تقسيمًا معينًا للوجبات أو نظامًا محددًا؟).`.trim();
  return { role:"user", parts:[{ text }] };
}

/* ===== Model call ===== */
async function callModel(model, contents, timeoutMs = 24000){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { role:"system", parts:[{ text: systemPrompt() }] },
    contents,
    generationConfig: { temperature: 0.22, topP: 0.9, maxOutputTokens: 900 },
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

/* ===== Handler ===== */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  // Subscription gate
  try{
    const gate = await ensureActiveSubscription(event);
    if(!gate.ok) return bad(gate.code, gate.msg);
  }catch(_){
    return bad(500, "subscription_gate_error");
  }

  // Parse body
  let body = {};
  try{ body = JSON.parse(event.body || "{}"); }
  catch{ return bad(400, "invalid_json_body"); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const scope = String(body.scope||"diet_only").toLowerCase();

  // تجهيز السياق
  const lastUser = lastUserMessage(messages);
  const lastBot  = lastAssistantMessage(messages);

  const profile  = extractProfileFromMessages(messages);
  const memoryCard = buildMemoryCard(profile);

  let contents;

  if (!messages.length) {
    // لا تاريخ: تحية وتعريف مختصر + جمع بيانات أساسية
    contents = [ buildGreetingPrompt() ];
  } else if (GREET_RE.test(normalizeArabic(lastUser || ""))) {
    // تحية/سلام فقط → رحّب واسأل حياديًا
    contents = [ buildGreetingPrompt() ];
  } else if (needsReAsk(messages)) {
    // المستخدم لم يجب على السؤال → أعد نفس السؤال بلطف + سبب الحاجة
    contents = [ buildReAskPrompt(messages) ];
  } else if (ACK_RE.test((lastUser||"").trim())) {
    // تأكيد قصير → تابع المسار السابق
    contents = [
      ...(memoryCard ? [memoryCard] : []),
      ...toGeminiContents(messages.slice(-8)),
      buildContinuationHint(lastBot, lastUser)
    ];
  } else {
    // تحديد نية
    const intent = detectIntent(lastUser || "");
    const missing = intent ? inferMissing(profile, intent.needs) : [];

    // حارس النطاق: لا نرفض إن كان هناك سياق تغذوي قريب
    const recentContextHasDiet = messages.slice(-6).some(m => SCOPE_ALLOW_RE.test(String(m.content||"")));
    const isOffscope = (scope === "diet_only") && lastUser && !SCOPE_ALLOW_RE.test(lastUser) && !recentContextHasDiet;

    if (isOffscope){
      contents = [ buildOffScopePrompt() ];
    } else if (intent && missing.length){
      // سؤال جديد يتطلب بيانات ناقصة → نطلب فقط المفقود
      const known = memoryCard ? [memoryCard] : [];
      contents = [
        ...known,
        buildMissingInfoPrompt(intent, profile, missing, lastUser)
      ];
    } else if (intent && intent.id === "calc_tdee_macros"){
      // لدينا كل المطلوب للحساب → نفّذ
      const targets = calcTargets(profile);
      if (!targets){
        // احترازيًا، إن فشل الحساب نطلب المفقود (لن نصل هنا عادة)
        const miss = inferMissing(profile, INTENTS.find(i=>i.id==="calc_tdee_macros").needs);
        contents = [ buildMissingInfoPrompt({id:"calc_tdee_macros"}, profile, miss, lastUser) ];
      } else {
        contents = [
          ...(memoryCard ? [memoryCard] : []),
          buildComputeCaloriesPrompt(profile, targets)
        ];
      }
    } else {
      // حوار طبيعي مع تخصيص ذكي
      contents = [
        ...(memoryCard ? [memoryCard] : []),
        ...toGeminiContents(messages),
        buildPersonalizerHint(lastUser||"")
      ];
    }
  }

  // استدعاء النموذج من الحوض
  const errors = {};
  for (const model of MODEL_POOL){
    const r = await callModel(model, contents);
    if (r.ok) return ok({ reply: r.reply, model });
    errors[model] = r.error;
  }

  return bad(502, "All models failed for your key/region on v1beta", { errors, tried: MODEL_POOL });
};
