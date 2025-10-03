// netlify/functions/aiDietAssistant.js
// Fully-AI WhatsApp-like diet assistant (Arabic) — ذكي جدًا، سياقي، مهني، يراجع كل المحادثة.
// ✅ الميزات:
//   1) يردّ التحية ويعرّف بنفسه دون افتراض أهداف.
//   2) يتابع عند رسائل التأكيد القصيرة (نعم/تمام/أوكي) دون اعتذار.
//   3) إن لم يُجِب المستخدم على سؤالٍ طُرح، يُعيد نفس السؤال بلطف ولا يتخطّاه.
//   4) عند سؤالٍ جديد يتطلّب بيانات ناقصة، يراجع التاريخ ويطلب فقط المفقود بدقة (1–2 سؤال).
//   5) يحسب السعرات/الماكروز عند الطلب، ويرشّح الأنظمة دون خروج عن النطاق.
//   6) حارس نطاق التغذية فقط + بوابة اشتراك مطابقة لتوليد الوصفات.
// POST { messages:[{role,content}], lang?: "ar", scope?: "diet_only" } -> { ok, reply, model }

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/* ===== Model pool (same as generateRecipe) ===== */
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

/* ===== System prompt (صارم ضد الافتراض، مرحِّب، قصير، 1–2 سؤال) ===== */
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
- إذا لم يُجب المستخدم عن سؤالك: أعد طرح **نفس السؤال** بلطف وبصياغة مباشرة.
- إذا طرح المستخدم سؤالًا جديدًا يتطلّب بيانات ناقصة: راجع التاريخ، واطلب **فقط المفقود** لإكمال إجابة دقيقة (سؤال واحد أو سؤالان).
- الرد موجز (3–8 أسطر) وبالعربية الفصحى المبسطة، ويمكن استخدام نقاط مختصرة.
- بلا وجوه تعبيرية ولا زخارف.

[الحسابات]
- السعرات = (4×البروتين + 4×الكربوهيدرات + 9×الدهون). اذكرها عند الحاجة.

[الذاكرة]
- راجع المحادثة كاملة. اعتبر القياسات/الحساسيات/التفضيلات المذكورة سابقًا افتراضًا حتى يُغيّرها المستخدم.
- لا تُدخل معلومات من خارج المحادثة.
`.trim();
}

/* ===== Utilities ===== */
function sanitizeReply(t=""){
  let s = String(t||"");
  s = s.replace(/```[\s\S]*?```/g,"").trim();   // إزالة أسوار الأكواد
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu,"");   // إزالة الإيموجي
  s = s.replace(/\n{3,}/g,"\n\n").trim();        // تقليم الأسطر
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

/* ===== Smart profile extractor ===== */
const WEIGHT_RE = /(?:وزني|الوزن|weight)\s*[:=]?\s*(\d{2,3})\s*(?:ك?جم|kg)?/i;
const HEIGHT_RE = /(?:طولي|الطول|height)\s*[:=]?\s*(\d{2,3})\s*(?:س?م|cm)?/i;
const AGE_RE    = /(?:عمري|العمر|age)\s*[:=]?\s*(\d{1,2})\s*(?:سنة|عام)?/i;
const GOAL_RE   = /(نقص|تنزيل|خسارة|تخسيس|cut|bulk|زيادة|بناء|تثبيت|حفاظ)\s*(?:\w+\s*)?(?:وزن|عضل|كتلة)?/i;
const DIET_RE   = /(كيتو|لو ?كارب|متوسطي|داش|نباتي|vegan|lchf|paleo|صيام متقطع)/i;
const ALLERGY_RE= /(حساسي(?:ة|ات)|لا(?: أتحمل| أتناول)|تحسس)\s*[:=]?\s*([^.\n،]+)/i;
const ACT_RE    = /(خامل|خفيف|متوسط|عال(?:ي)?\s*النشاط|sedentary|light|moderate|active)/i;
const DISEASE_RE= /(سكر[يي]?|ضغط|كلى|كبد|دهون(?: على)? الكبد|كوليسترول|نقرس)/i;

function extractProfileFromMessages(messages){
  const profile = {
    goal: null, weight_kg: null, height_cm: null, age: null,
    activity: null, preferred_diet: null, allergies: [], conditions: []
  };
  for (const m of messages){
    const text = String(m.content||"");
    const w = text.match(WEIGHT_RE); if (w) profile.weight_kg = Number(w[1]);
    const h = text.match(HEIGHT_RE); if (h) profile.height_cm = Number(h[1]);
    const a = text.match(AGE_RE);    if (a) profile.age = Number(a[1]);
    const g = text.match(GOAL_RE);   if (g) profile.goal = g[0];
    const d = text.match(DIET_RE);   if (d) profile.preferred_diet = d[1];
    const act= text.match(ACT_RE);   if (act) profile.activity = act[1];
    const dis= text.match(DISEASE_RE); if (dis && !profile.conditions.includes(dis[1])) profile.conditions.push(dis[1]);
    const al = text.match(ALLERGY_RE);
    if (al){
      const list = al[2].split(/[،,]/).map(s=>s.trim()).filter(Boolean);
      for (const item of list){ if (!profile.allergies.includes(item)) profile.allergies.push(item); }
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

/* ===== Intent & missing-info detection (لسؤال جديد) ===== */
// نحدد نوايا شائعة وما البيانات اللازمة لكل نية للحصول على إجابة دقيقة.
const INTENTS = [
  {
    id: "calc_tdee_macros",
    re: /(احسب|حساب)\s+(?:سعرات|tdee|الاحتياج|طاقة|ماكروز|macros)|(?:سعراتي|كم\s+سعره)|ما\s*هي\s*سعراتي/i,
    needs: ["goal","weight_kg","height_cm","age","activity"]
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
  if (!text) return null;
  for (const it of INTENTS){
    if (it.re.test(text)) return it;
  }
  // مؤشرات عامة تفيد الحاجة للبيانات الأساسية بدون نية محددة
  if (/(ماكروز|سعرات|tdee|رجيم|نظام|خطة|وجبات)/i.test(text)){
    return { id:"generic_diet_help", re:/./, needs:["goal","weight_kg","height_cm","age","activity"] };
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
    goal: "هدفك الحالي (نزول/زيادة وزن، بناء عضل…)",
    weight_kg: "وزنك (كجم)",
    height_cm: "طولك (سم)",
    age: "عمرك",
    activity: "مستوى نشاطك اليومي (خامل/خفيف/متوسط/عالٍ)",
    preferred_diet: "تفضيلك للنظام (مثل: متوسطي/لو-كارب/نباتي… إن وجد)",
    allergies: "أي حساسيات غذائية",
    conditions: "حالات صحية مهمة (مثل سكري/ضغط… إن وجدت)"
  };
  return missing.map(k=> map[k] || k);
}

function buildMissingInfoPrompt(intent, profile, missing, lastMsg){
  const known = Object.keys(profile||{})
    .map(k => `${k}: ${Array.isArray(profile[k]) ? profile[k].join(", ") : profile[k]}`)
    .join(", ");
  const list = humanizeMissing(missing).join("، ");
  const intro = intent?.id === "calc_tdee_macros"
    ? "لأحسب احتياجك بدقة"
    : intent?.id === "meal_plan"
      ? "لأبني لك خطة وجبات دقيقة"
      : intent?.id === "recommend_diet"
        ? "لأرشّح نظامًا مناسبًا لك"
        : "لأقدّم لك جوابًا دقيقًا";
  const text = `
رسالة المستخدم:\n"""${lastMsg}"""\n
المعلومات المتوفرة: ${known || "لا شيء مسجّل"}.
المعلومات الناقصة: ${list}.
اكتب ردًا عربيًا موجزًا ومحترفًا:
- اشرح بجملة واحدة لماذا تحتاج هذه البيانات لإكمال الطلب.
- اطلب فقط العناصر الناقصة بصياغة مباشرة (سؤال واحد أو سؤالان كحد أقصى).
- بلا افتراضات، بلا إطالة، وبلا زخارف.`.trim();
  return { role:"user", parts:[{ text }] };
}

/* ===== Re-ask & continuation helpers ===== */
const CORE_Q_HINTS = /(هدفك|هدفك\s+الحالي|وزنك|طولك|عمرك|نشاطك)/i;
function userProvidedCoreData(text){
  return !!(text.match(WEIGHT_RE)||text.match(HEIGHT_RE)||text.match(AGE_RE)||text.match(GOAL_RE)||text.match(ACT_RE));
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
  const fallback = "من فضلك أخبرني بوضوح عن هدفك الغذائي (مثل: نزول وزن/زيادة وزن/بناء عضل) واذكر: وزنك، طولك، عمرك، ومستوى نشاطك اليومي، لأخصص لك الخطة.";
  const question = lastBot && lastBot.trim() ? lastBot.trim() : fallback;
  const polite = `لم أتلقَّ إجابة عن سؤالي السابق. أعد طرحه بلطف وبشكل مباشر دون افتراضات:\n"""${question}"""`;
  return { role:"user", parts:[{ text: polite }] };
}
function buildContinuationHint(lastAssistant, lastUser){
  const text = `
رسالة المستخدم قصيرة وتعبّر عن التأكيد: """${lastUser}"""
رسالتك السابقة كانت: """${lastAssistant || "(لا توجد)"}"""
تابِع الإجراء المقترح في رسالتك السابقة مباشرةً (مثل: حساب الماكروز/السعرات، ترشيح نظام، أو طلب البيانات الأساسية) بلا اعتذار وبسؤال واحد على الأكثر.`.trim();
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
- اسأل سؤالًا موجّهًا عن الهدف (نزول/زيادة وزن، بناء عضل، ضبط سكر…).
- في نفس الرسالة اطلب: الوزن، الطول، العمر، مستوى النشاط (سؤال واحد أو سؤالان).
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
    "حلّل الرسالة لاستخراج الهدف الغذائي والتفضيلات والحساسيات والقيود.",
    "اقترح أنظمة ملائمة أو احسب السعرات/الماكروز عند الطلب.",
    "اربط الرد بما سبق في المحادثة، وذكّر بالمعلومات المهمة عند الحاجة.",
    "اختصر الرد (3–8 أسطر) واستخدم سؤالًا واحدًا أو سؤالين فقط."
  ].join("\n- ");
  return { role:"user", parts:[{ text:
`هذه رسالة المستخدم للتحليل الشخصي:\n"""${lastMsg}"""\n\n- ${hints}` }] };
}

/* ===== Model call with pool & timeouts ===== */
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

  // تجهيز المحادثة للموديل
  const lastUser = lastUserMessage(messages);
  const lastBot  = lastAssistantMessage(messages);
  const profile  = extractProfileFromMessages(messages);
  const memoryCard = buildMemoryCard(profile);

  let contents;

  if (!messages.length) {
    // لا تاريخ: تحية وتعريف مختصر + جمع بيانات أساسية
    contents = [ buildGreetingPrompt() ];
  } else if (GREET_RE.test(lastUser || "")) {
    // تحية/سلام فقط → رحّب واسأل حياديًا
    contents = [ buildGreetingPrompt() ];
  } else if (needsReAsk(messages)) {
    // المستخدم لم يجب على السؤال → أعد نفس السؤال بلطف
    contents = [ buildReAskPrompt(messages) ];
  } else if (ACK_RE.test((lastUser||"").trim())) {
    // تأكيد قصير → تابع المسار السابق
    contents = [
      ...(memoryCard ? [memoryCard] : []),
      ...toGeminiContents(messages.slice(-8)),
      buildContinuationHint(lastBot, lastUser)
    ];
  } else {
    // إن كان السؤال الجديد يتطلب معلومات ناقصة، نطلب فقط المفقود لإكمال الإجابة
    const intent = detectIntent(lastUser || "");
    const missing = intent ? inferMissing(profile, intent.needs) : [];
    const recentContextHasDiet = messages.slice(-6).some(m => SCOPE_ALLOW_RE.test(String(m.content||"")));
    const isOffscope = (scope === "diet_only") && lastUser && !SCOPE_ALLOW_RE.test(lastUser) && !recentContextHasDiet;

    if (isOffscope){
      contents = [ buildOffScopePrompt() ];
    } else if (intent && missing.length){
      contents = [
        ...(memoryCard ? [memoryCard] : []),
        buildMissingInfoPrompt(intent, profile, missing, lastUser)
      ];
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
