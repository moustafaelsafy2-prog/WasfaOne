// netlify/functions/aiDietAssistant.js
// Fully-AI WhatsApp-like diet assistant (Arabic), strict diet-only scope.
// - كل الردود تُولّد من النموذج (لا قوالب ثابتة سوى الحواجز).
// - نفس بوابة الاشتراك مثل generateRecipe (x-auth-token, x-session-nonce).
// - نفس حوض النماذج (Gemini family).
// - POST { messages:[{role,content}], lang?: "ar", scope?: "diet_only" } -> { ok, reply, model }.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/* ===== Same model pool as generateRecipe ===== */
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

/* ===== Diet-only scope guard (server-side) ===== */
const SCOPE_ALLOW_RE = /(?:سعرات|كالور|ماكروز|بروتين|دهون|كار|كارب|كربوهيدرات|ألياف|ماء|ترطيب|نظام|حِمية|رجيم|وجبة|وصفات|غذائ|صيام|كيتو|لو كارب|متوسطي|داش|نباتي|نباتيه|سعر حراري|مؤشر جلايسيمي|حساسي|تحسس|سكري|ضغط|كلى|كبد|كوليسترول|وجبات|تقسيم السعرات|macro|protein|carb|fat|fiber|calorie|diet|meal|fasting|glycemic|keto|mediterranean|dash|vegan|lchf)/i;

/* ===== Greetings & off-scope detection ===== */
const GREET_RE = /^(?:\s*(?:السلام\s*عليكم|وعليكم\s*السلام|مرحبا|مرحباً|أهلًا|اهلاً|هلا|مساء الخير|صباح الخير)\b|^\s*السلام\s*$)/i;

/* ===== System prompt (قوي، شخصي، عربي، مرن، 2 أسئلة كحد أقصى) =====
   مُحسّن ليفهم سياق المستخدم، يخصص الرد، يرحّب، ويعيد التوجيه عند الخروج عن النطاق.
*/
function systemPrompt(){
  return `
أنت مساعد تغذية عربي يعمل بأسلوب دردشة واتساب، ودود وعملي ودقيق. هدفك تقديم إرشاد غذائي عملي ومخصص.
[النطاق المسموح]
- كل ما يتعلق بالتغذية والعادات الغذائية وأنظمة الحِمية (كيتو/متوسطي/داش/نباتي/لو-كارب/صيام متقطع…)، تقسيم السعرات والماكروز (4/4/9)، بدائل المكونات، تقييم الوجبات، الحساسيات، إدارة الوزن، الترطيب، توقيت الوجبات، تجهيز الوجبات مسبقًا، تكييف الوصفات مع ظروف بسيطة شائعة.
[المحظور]
- أي موضوع خارج التغذية (برمجة، سياسة، دين، أسواق، علاقات، إلخ)، أو طب عالي الخطورة/تشخيص/جرعات أدوية.
[الأسلوب]
- رحّب وردّ السلام إن وُجد، ثم قدّم ردًا موجزًا للغاية (3–8 أسطر) واضحًا وشخصيًا مبنيًا على رسالة المستخدم.
- لا تستخدم الوجوه التعبيرية أو الزخارف.
- استخدم نقاط موجزة عند الحاجة.
- اطرح **سؤالًا واحدًا أو سؤالين بحد أقصى** لاستكمال البيانات أو التأكد من الهدف.
- عند الخروج عن النطاق: اعتذر بلطف، ووضّح أنك متخصص بالتغذية فقط، ثم اقترح إعادة صياغة السؤال ضمن التغذية مع **سؤال واحد موجّه** للعودة للنطاق.
[حسابات وتذكيرات]
- ذكّر عند الحاجة أن السعرات = (4×البروتين + 4×الكربوهيدرات + 9×الدهون).
- لا تعطِ أرقامًا طبية دقيقة لحالات خاصة؛ انصح بمراجعة مختص عند الضرورة.
[التخصيص الذكي]
- استخلص الهدف (إنقاص/زيادة وزن، ضبط سكر، أداء رياضي…) من كلام المستخدم.
- التقط إشارات الحساسية أو التفضيلات (نباتي، لا ألبان…).
- عند السلام أو التحية فقط، قدّم تعريفًا قصيرًا بنفسك واسأل عن الهدف والبيانات الأساسية (وزن/طول/عمر/نشاط) في سؤال واحد أو اثنين.
`.trim();
}

/* ===== Utilities ===== */
function sanitizeReply(t=""){
  // إزالة أي أسوار كود أو حشو زائد
  let s = String(t||"").replace(/```[\s\S]*?```/g,"").trim();
  // منع الوجوه التعبيرية الشائعة
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu,"");
  // تقليم فراغات زائدة
  s = s.replace(/\n{3,}/g,"\n\n").trim();
  return s;
}

function toGeminiContents(messages){
  // آخر 16 تبادلًا كحد أقصى
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

/* ===== Content shapers ===== */
function buildGreetingPrompt(){
  return {
    role:"user",
    parts:[{ text:
`وُجدت تحية/سلام من المستخدم. اكتب ردًا موجزًا عربيًا:
- ابدأ بالسلام المناسب والتحية الودية.
- عرّف نفسك كمساعد تغذية يقدّم إرشادًا غذائيًا عمليًا ومخصصًا.
- اطلب الهدف الحالي للمستخدم (مثال: نزول وزن، بناء عضل، ضبط سكر…).
- اطلب في سؤال واحد أو سؤالين فقط: الوزن، الطول، العمر، ومستوى النشاط (خام).
- بدون وجوه تعبيرية أو زخارف، وبنبرة عملية مشجعة.` }] }
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
  // تلميحات إضافية للنموذج لاستخراج سياق أعمق بدون زيادة الإطالة
  const hints = [
    "حلّل الرسالة لاستخراج الهدف الغذائي والتفضيلات والحساسيات والقيود.",
    "اختصر الرد لثلاثة إلى ثمانية أسطر مع نقاط موجزة إن لزم.",
    "اقترح بدائل عملية وبسيطة من نفس المطبخ إن ذكر المستخدم أطعمة محددة.",
    "استخدم سؤالًا واحدًا أو سؤالين فقط لاستكمال البيانات."
  ].join("\n- ");
  return {
    role:"user",
    parts:[{ text:
`هذه رسالة المستخدم للتحليل الشخصي:\n"""${lastMsg}"""\n\n- ${hints}` }]
  };
}

/* ===== Model call with pool & timeouts ===== */
async function callModel(model, contents, timeoutMs = 24000){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { role:"system", parts:[{ text: systemPrompt() }] },
    contents,
    // ميل أقل للعشوائية مع بقاء السلاسة
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 900 },
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

  let contents;
  if (!messages.length) {
    // لا تاريخ: تحية وتعريف مختصر + جمع بيانات أساسية
    contents = [
      buildGreetingPrompt()
    ];
  } else if (GREET_RE.test(lastUser || "")) {
    // تحية/سلام فقط
    contents = [
      buildGreetingPrompt()
    ];
  } else {
    // حارس النطاق (تحقق سريع)
    const offscope = (scope === "diet_only") && lastUser && !SCOPE_ALLOW_RE.test(lastUser);
    if (offscope){
      contents = [ buildOffScopePrompt() ];
    } else {
      // حوار طبيعي مع تلميحات تخصيص ذكية
      contents = [
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
