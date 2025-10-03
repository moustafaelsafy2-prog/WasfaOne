// netlify/functions/aiDietAssistant.js
// Fully-AI WhatsApp-like diet assistant (Arabic) — ذكي جدًا، سياقي، مرن، يربط الردود بالمحادثة كاملة.
// ✅ يصلّح مشكلات: (1) التحية لا تُرفض بعد الآن، (2) "نعم/تمام" تُعامل كتأكيد للاستمرار، لا كخروج عن النطاق.
// - كل الردود تُولَّد من النموذج (لا قوالب ثابتة سوى الحواجز).
// - يراجع المحادثة كاملة، يبني "ملف مستخدم" ذكيًا، يرد السلام، يحسب السعرات/الماكروز عند الطلب، ويرشح الأنظمة.
// - نفس بوابة الاشتراك مثل generateRecipe (x-auth-token, x-session-nonce).
// - نفس حوض النماذج (Gemini family).
// - POST { messages:[{role,content}], lang?: "ar", scope?: "diet_only" } -> { ok, reply, model }.

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

/* ===== Diet-only scope guard (server-side) =====
   ⚠️ مهم: لا نرفض رسائل التحية أو التأكيد القصير (نعم/تمام/إي) حتى لو لم تحتوي كلمات تغذية.
*/
const SCOPE_ALLOW_RE =
  /(?:سعرات|كالوري|كالور|ماكروز|بروتين|دهون|كارب|كربوهيدرات|ألياف|ماء|ترطيب|نظام|حِمية|رجيم|وجبة|وصفات|غذائ|صيام|كيتو|لو ?كارب|متوسطي|داش|نباتي|سعر حراري|مؤشر جلايسيمي|حساسي|تحسس|سكري|ضغط|كلى|كبد|كوليسترول|وجبات|تقسيم السعرات|macro|protein|carb|fat|fiber|calorie|diet|meal|fasting|glycemic|keto|mediterranean|dash|vegan|lchf|cut|bulk|maintenance)/i;

const GREET_RE = /^(?:\s*(?:السلام\s*عليكم|وعليكم\s*السلام|مرحبا|مرحباً|أهلًا|اهلاً|هلا|مساء الخير|صباح الخير|سلام)\b|\s*السلام\s*)$/i;
const ACK_RE   = /^(?:نعم|اي|إي|ايوه|أيوه|أجل|تمام|حسنًا|حسنا|طيب|اوكي|موافق|Yes|OK|Okay)\.?$/i;

/* ===== System prompt (قوي، شخصي، عربي، مرن، 2 أسئلة كحد أقصى) ===== */
function systemPrompt(){
  return `
أنت مساعد تغذية عربي يعمل بأسلوب دردشة واتساب، ودود وعملي ودقيق. هدفك تقديم إرشاد غذائي عملي ومخصص.
[النطاق]
- تغذية وأنظمة الحِمية (كيتو/متوسطي/داش/نباتي/لو-كارب/صيام متقطع…)، تقسيم السعرات والماكروز (4/4/9)، بدائل المكونات، تقييم الوجبات، الحساسيات، إدارة الوزن، الترطيب، توقيت وتجهيز الوجبات.
[المحظور]
- ما هو خارج التغذية، أو طب عالي الخطورة/تشخيص/جرعات.
[الأسلوب]
- رحّب وردّ السلام عند التحية.
- ردّ موجز جدًا (3–8 أسطر) واضح وشخصي مبني على المحادثة كاملة.
- نقاط مختصرة عند الحاجة.
- **سؤال واحد أو سؤالان بحد أقصى** لاستكمال البيانات.
- عند رسالة تأكيد قصيرة (مثل "نعم"/"تمام"): تابع الإجراء المقترح سابقًا مباشرةً دون اعتذار.
- عند الخروج عن النطاق: اعتذر بلطف واطلب إعادة الصياغة ضمن التغذية مع سؤال واحد موجّه.
[الحسابات]
- السعرات = (4×البروتين + 4×الكربوهيدرات + 9×الدهون). استخدمها عند طلب الماكروز/السعرات.
[الذاكرة]
- راجع المحادثة كاملة. اعتبر القياسات/الحساسيات/التفضيلات المذكورة سابقًا افتراضًا حتى يُغيّرها المستخدم.
`.trim();
}

/* ===== Utilities ===== */
function sanitizeReply(t=""){
  let s = String(t||"");
  s = s.replace(/```[\s\S]*?```/g,"").trim();   // أزل أسوار الأكواد
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu,"");   // بلا رموز/إيموجي
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

/* ===== Lightweight conversation memory extractor (smart profile) ===== */
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

/* ===== Conversation control hints ===== */
// عندما تكون رسالة المستخدم تأكيدًا قصيرًا، نمرّر تلميح "تابع الإجراء السابق" بدل رفض النطاق.
function buildContinuationHint(lastAssistant, lastUser){
  const text = `
رسالة المستخدم قصيرة وتعبّر عن التأكيد: """${lastUser}"""
رسالتك السابقة كانت: """${lastAssistant || "(لا توجد)"}"""
تابِع الإجراء المقترح في رسالتك السابقة مباشرةً (مثل: حساب الماكروز/السعرات، اقتراح نظام، بناء خطة يومية...) ولا تقدّم اعتذارًا. اجعل الرد موجزًا ومحترفًا مع سؤال واحد بحد أقصى إن لزم.`.trim();
  return { role:"user", parts:[{ text }] };
}

function buildGreetingPrompt(){
  return {
    role:"user",
    parts:[{ text:
`وُجدت تحية/سلام من المستخدم. اكتب ردًا موجزًا عربيًا:
- ابدأ بالسلام المناسب والتحية الودية.
- عرّف نفسك كمساعد تغذية يقدم إرشادًا عمليًا ومخصصًا.
- اطلب الهدف الحالي (نزول/زيادة وزن، بناء عضل، ضبط سكر…).
- اطلب في سؤال واحد أو سؤالين فقط: الوزن، الطول، العمر، ومستوى النشاط.
- بلا وجوه تعبيرية أو زخارف.` }] }
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
    "اقترح أنظمة ملائمة مع تبرير مختصر، ويمكنك حساب الماكروز/السعرات إذا طُلِب.",
    "اختصر الرد لثلاثة إلى ثمانية أسطر مع نقاط موجزة إن لزم.",
    "اربط الرد بما سبق في المحادثة وذكّر بالمعلومات المهمة عند الحاجة.",
    "استخدم سؤالًا واحدًا أو سؤالين فقط لاستكمال البيانات."
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
    // تحية/سلام فقط → رحّب وقدّم الأسئلة الأساسية
    contents = [ buildGreetingPrompt() ];
  } else if (ACK_RE.test((lastUser||"").trim())) {
    // تأكيد قصير (نعم/تمام/أوكي) → تابع ما اقترحه المساعد سابقًا
    contents = [
      ...(memoryCard ? [memoryCard] : []),
      ...toGeminiContents(messages.slice(-8)), // سياق كافٍ
      buildContinuationHint(lastBot, lastUser)
    ];
  } else {
    // حارس النطاق: لا نرفض إن كان هناك سياق تغذوي سابق مؤخرًا
    const recentContextHasDiet = messages.slice(-6).some(m => SCOPE_ALLOW_RE.test(String(m.content||"")));
    const offscope = (scope === "diet_only") && lastUser && !SCOPE_ALLOW_RE.test(lastUser) && !recentContextHasDiet && !ACK_RE.test(lastUser);
    if (offscope){
      contents = [ buildOffScopePrompt() ];
    } else {
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
