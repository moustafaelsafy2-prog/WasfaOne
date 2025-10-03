// /netlify/functions/aiDietAssistant.js
// Deterministic Arabic diet assistant — robust greeting & scope detection (handles timestamps/extra lines).

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// تم تحديث قائمة النماذج بناءً على طلب المستخدم لضمان أقصى تغطية
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

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";
const PACK_PATH  = "data/assistant_pack.json";

// لتمكين استخدام Buffer في بيئات غير Node.js مثل Canvas
const Buffer = require('buffer').Buffer;

async function ghGetJson(path){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  // التأكد من أن المحتوى موجود قبل محاولة التحويل
  const content = data.content ? Buffer.from(data.content, "base64").toString("utf-8") : "{}";
  return { json: JSON.parse(content), sha: data.sha };
}

/* === Dubai date & sub window === */
function todayDubai(){
  // استخدام en-CA لضمان تنسيق YYYY-MM-DD
  const now = new Date();
  return now.toLocaleDateString("en-CA", { timeZone:"Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit" });
}
function withinWindow(start, end){
  const d = todayDubai();
  if(start && d < start) return false;
  if(end && d > end) return false;
  return true;
}

/* === HTTP === */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Session-Nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

/* === subscription gate === */
// تم ترك هذه الدالة كما هي، مع افتراض أن البيئة ستوفر التوابع اللازمة
async function ensureActiveSubscription(event) {
  const token = event.headers["x-auth-token"] || event.headers["X-Auth-Token"];
  const nonce = event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"];
  if (!token || !nonce) return { ok:false, code:401, msg:"unauthorized" };
  const { json: users } = await ghGetJson(USERS_PATH);
  // فحص حالة عدم وجود المستخدمين
  if (!Array.isArray(users)) return { ok:false, code:500, msg:"user_data_error" };

  const idx = users.findIndex(u => (u.token||u.auth_token||"") === token);
  if (idx === -1) return { ok:false, code:401, msg:"unauthorized" };
  const user = users[idx];
  if ((user.session_nonce||"") !== nonce) return { ok:false, code:401, msg:"bad_session" };
  const today = todayDubai();
  if (user.end_date && today > user.end_date) return { ok:false, code:403, msg:"subscription_expired" };
  if ((String(user.status||"").toLowerCase() !== "active") || !withinWindow(user.start_date, user.end_date))
    return { ok:false, code:403, msg:"inactive_or_out_of_window" };
  return { ok:true, user };
}

/* === pack cache === */
let PACK_CACHE = { data:null, ts:0 };
async function loadPack(force=false){
  const maxAgeMs = 5*60*1000;
  const now = Date.now();
  if(!force && PACK_CACHE.data && (now - PACK_CACHE.ts) < maxAgeMs) return PACK_CACHE.data;
  try{
    const { json } = await ghGetJson(PACK_PATH);
    PACK_CACHE = { data: json || {}, ts: now };
    return PACK_CACHE.data || {};
  }catch(e){
    console.error("Failed to load pack, using fallback:", e);
    // توفير Fallback أكثر شمولًا في حالة فشل الاتصال بـ GitHub
    return {
      system: "أنت مساعد تغذية عربي عملي ودقيق. رحّب وردّ السلام، واكتب ردودًا موجزة (3–8 أسطر)...",
      prompts:{
        greeting: "وعليكم السلام ورحمة الله، أهلًا بك! ما هدفك الآن؟ ثم أرسل: وزنك/طولك/عمرك/جنسك/نشاطك.",
        off_scope: "أعتذر بلطف، اختصاصي تغذية فقط. ما هدفك الغذائي الآن؟",
        repeat_unanswered: "يبدو أنّ سؤالي السابق لم يُجب بعد. للمتابعة بدقّة: {{question}}",
        ask_missing_bundle: "لو تكرّمت أرسل: وزن __ كجم، طول __ سم، عمر __ سنة، جنس ذكر/أنثى، نشاط خفيف/متوسط/عال."
      },
      extract_regex:{},
      knowledge:{ activity_factors:{ sedentary:1.2, light:1.375, moderate:1.55, active:1.725, athlete:1.9 } },
      conversions:{ lb_to_kg:0.45359237, inch_to_cm:2.54, ft_to_cm:30.48, m_to_cm:100 }
    };
  }
}

/* === helpers & normalization === */
function sanitizeReply(t=""){
  let s = String(t||"").replace(/```[\s\S]*?```/g,"");
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu,""); // إزالة الإيموجي
  s = s.split("\n").filter(line => !/^\s*>/g.test(line)).join("\n"); // إصلاح إزالة الاقتباسات
  s = s.trim().replace(/\n{3,}/g,"\n\n");
  return s;
}
function normalizeDigits(s=""){
  // تحويل الأرقام العربية إلى الإنجليزية
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(s||"").replace(/[\u0660-\u0669]/g, d => map[d] ?? d);
}
/** يأخذ نص المستخدم كاملًا:
 * - يزيل المحارف الخفية/التنسيقية
 * - يقسم لأسطر، يأخذ آخر سطر غير فارغ
 * - يحذف الطوابع الزمنية الشائعة في بدايته (مثل 00:58 أو [00:58])
 * - يطبع الأرقام العربية → إنجليزية
 */
function extractUtterance(raw=""){
  const cleaned = String(raw||"")
    .replace(/[\u200B-\u200F\u202A-\u202E]/g,"") // محارف اتجاه خفية
    .replace(/\r/g,"");
  // فلترة الأسطر الفارغة أو أسطر الاقتباس
  const lines = cleaned.split("\n").map(l=>l.trim()).filter(l => Boolean(l) && !l.startsWith('>'));
  const last = lines.length ? lines[lines.length-1] : "";
  const noTs = last.replace(/^\[?\s*\d{1,2}:\d{2}\s*\]?\s*[-–:]?\s*/,"");
  return normalizeDigits(noTs).trim();
}

/* === intent & scope detection (robust) === */
const GREET_ANY_RE = /(السلام\s*عليكم|سلام\s*عليكم|السلام|سلام|مرحبا|مرحباً|أهلًا|اهلاً|هلا|صباح الخير|مساء الخير)/i;
// تحسين لغة كشف النطاق لتكون أكثر شمولاً للكلمات العربية والإنجليزية
const SCOPE_ALLOW_RE = /(?:سعرات|كالور|ماكروز|بروتين|دهون|كارب|كربوهيدرات|ألياف|ماء|ترطيب|نظام|حِمية|رجيم|وجبة|وصفات|صيام|كيتو|لو كارب|متوسطي|داش|نباتي|macro|protein|carb|fat|fiber|calorie|diet|meal|fasting|glycemic|keto|mediterranean|dash|vegan|lchf|صحة|رياضة|تمرين)/i;

function toGeminiContents(messages){
  const hist = (Array.isArray(messages)? messages : []).slice(-16);
  // التأكد من أن جميع الأرقام في محتوى المستخدم يتم تحويلها إلى الإنجليزية لتطبيق Regex دقيق
  return hist.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: normalizeDigits(String(m.content||"")) }]
  }));
}
function lastOfRole(messages, role="assistant"){
  for(let i=messages.length-1;i>=0;i--){
    if(messages[i].role===role) return String(messages[i].content||"");
  }
  return "";
}
function lastUserMessage(messages){
  for (let i = messages.length - 1; i >= 0; i--){
    if (messages[i].role === "user") return String(messages[i].content||"");
  }
  return "";
}

/* === state extraction === */
function buildState(messages, pack){
  const rx = pack?.extract_regex || {};
  const re = (p)=> p ? new RegExp(p,'i') : null;

  // تم تحسين التعبيرات العادية في assistant_pack.json
  const RE_WEIGHT = re(rx.weight_any);
  const RE_HEIGHT = re(rx.height_any);
  const RE_FT_IN  = re(rx.height_ft_in);
  const RE_AGE    = re(rx.age_years);
  const RE_SEX    = re(rx.sex);
  const RE_ACT    = re(rx.activity);
  const RE_GOAL   = re(rx.goal);
  const RE_DIET   = re(rx.diet);

  const activityAliases = pack?.knowledge?.activity_aliases || {};
  const sexAliases      = pack?.knowledge?.sex_aliases || {};
  const conv = pack?.conversions || { lb_to_kg:0.45359237, inch_to_cm:2.54, ft_to_cm:30.48, m_to_cm:100 };

  const state = { weight_kg:null, height_cm:null, age_years:null, sex:null, activity_key:null, goal:null, diet:null };

  function mapActivity(txt){
    const t = (txt||"").trim();
    // استخدام الخرائط أولاً، ثم المطابقة الإنجليزية
    const key = activityAliases[t] || activityAliases[t.toLowerCase()] || null;
    if(key) return key;
    if(/sedentary/i.test(t)) return "sedentary";
    if(/light/i.test(t))     return "light";
    if(/moderate/i.test(t))  return "moderate";
    if(/active/i.test(t))    return "active";
    if(/athlete|very\s*active/i.test(t)) return "athlete";
    return null;
  }
  function mapSex(txt){
    const t = (txt||"").trim();
    const key = sexAliases[t] || sexAliases[t.toLowerCase()] || null;
    if(key) return key;
    if(/male/i.test(t)) return "male";
    if(/female/i.test(t)) return "female";
    return null;
  }
  // إصلاح دالة parseNumeric لاستخدام replace بدلاً من regex
  function parseNumeric(x){ 
    const v = parseFloat(String(x).replace(",", ".")); 
    return Number.isFinite(v) ? v : null; 
  }

  function applyFrom(text0){
    if(!text0) return;
    // يجب تحويل الأرقام هنا أيضًا لضمان عمل regex المرفق في pack
    const text = normalizeDigits(text0); 

    // --- WEIGHT ---
    const wMatch = RE_WEIGHT ? text.match(RE_WEIGHT) : null;
    if(wMatch){
      let w = parseNumeric(wMatch[1]);
      if(w!=null){
        const matchEndIndex = (wMatch.index || 0) + (wMatch[0] || "").length;
        // التحقق من وجود وحدة 'lb' أو 'باوند' بعد الرقم
        const checkArea = text.slice(matchEndIndex, matchEndIndex + 10);
        if(/lb|lbs|باوند|رطل/i.test(wMatch[0] + checkArea)) {
           w = w * (conv.lb_to_kg || 0.45359237);
        }
        state.weight_kg = Math.round(w * 10) / 10;
      }
    }

    // --- HEIGHT ---
    const fti = RE_FT_IN ? text.match(RE_FT_IN) : null;
    if(fti){
      const ft = parseNumeric(fti[1]);
      const inch = parseNumeric(fti[2]);
      if(ft!=null && inch!=null){
        const cm = ft*(conv.ft_to_cm||30.48) + inch*(conv.inch_to_cm||2.54);
        state.height_cm = Math.round(cm);
      }
    }else{
      const hMatch = RE_HEIGHT ? text.match(RE_HEIGHT) : null;
      if(hMatch){
        let h = parseNumeric(hMatch[1]);
        if(h!=null){
          const matchEndIndex = (hMatch.index || 0) + (hMatch[0] || "").length;
          const checkArea = text.slice(matchEndIndex, matchEndIndex + 5);
          const isMeter = /م|m/i.test(hMatch[0] + checkArea);

          if (isMeter) {
             // إذا كانت الوحدة متر، حوّل إلى سم
             state.height_cm = Math.round(h * (conv.m_to_cm || 100));
          } else {
             // وإلا افترض أنها سم
             state.height_cm = Math.round(h);
          }
        }
      }
    }

    // --- AGE ---
    const aMatch = RE_AGE ? text.match(RE_AGE) : null;
    if(aMatch){
      const a = parseNumeric(aMatch[1]);
      if(a!=null) state.age_years = Math.round(a);
    }

    // --- SEX ---
    const sMatch = RE_SEX ? text.match(RE_SEX) : null;
    if(sMatch){ state.sex = mapSex(sMatch[1]) || state.sex; }

    // --- ACTIVITY ---
    const actMatch = RE_ACT ? text.match(RE_ACT) : null;
    if(actMatch){ state.activity_key = mapActivity(actMatch[1]) || state.activity_key; }

    // --- GOAL ---
    const gMatch = RE_GOAL ? text.match(RE_GOAL) : null;
    if(gMatch){
      const gRaw = gMatch[1];
      if(/خس|تنزيل|انقاص|فقدان|نزول/i.test(gRaw)) state.goal = "loss";
      else if(/زياد/i.test(gRaw)) state.goal = "gain";
      else if(/حفاظ|تثبيت/i.test(gRaw)) state.goal = "maintain";
      else if(/بناء\s*عضل/i.test(gRaw)) state.goal = "build";
    }

    // --- DIET ---
    const dMatch = RE_DIET ? text.match(RE_DIET) : null;
    if(dMatch){
      const d = dMatch[1].toLowerCase().replace(/\s+/g,'');
      if(/كيتو|keto/.test(d)) state.diet = "keto";
      else if(/لوكارب|lchf/.test(d)) state.diet = "lchf";
      else if(/متوسطي|med/.test(d)) state.diet = "med";
      else if(/dash/.test(d)) state.diet = "dash";
      else if(/نباتي|vegan/.test(d)) state.diet = "vegan";
      else if(/balanced|متوازن/.test(d)) state.diet = "balanced";
    }
  }

  // تطبيق المنطق على كل رسالة بالترتيب لضمان أولوية الأحدث (Most Recent Wins)
  for(const m of (messages||[])){ 
    if(m && typeof m.content==="string"){ 
      applyFrom(m.content); 
    } 
  }
  return state;
}

/* === intent === */
function detectIntent(utter, pack){
  const intents = pack?.intents || {};
  // الدعم لـ Regex Strings فقط
  function hit(keys){ return Array.isArray(keys) && keys.some(k=> new RegExp(k,'i').test(utter)); }
  if(GREET_ANY_RE.test(utter)) return "greet";
  if(hit(intents.off_scope)) return "off_scope";
  if(hit(intents.calc_calories)) return "calc_calories";
  if(hit(intents.calc_macros)) return "calc_macros";
  if(hit(intents.diet_pick)) return "diet_pick";
  // إذا لم يتم تحديد نية واضحة، ولكن السؤال يحتوي على كلمات تدل على النطاق، اعتبره 'chat'
  if(SCOPE_ALLOW_RE.test(utter)) return "chat";
  return "chat";
}
function isAmbiguousAffirmation(s){
  return /\b(نعم|اي|أجل|تمام|طيب|اوكي|موافق|اكيد|Yes|Yeah|Ok|Okay)\b/i.test(String(s||""));
}

/* === system prompt === */
function systemPromptFromPack(pack){
  const base = String(pack?.system || "").trim();
  const extra = `
[قيود أسلوبية]
- لا تعِدْ نسخ نصّ المستخدم أو بياناته حرفيًا داخل الرد.
- إن احتجت تأكيدًا فاجعله في جملة موجزة.
- لا تبدأ بأسطر فارغة. الرد 3–8 أسطر بالعربية الفصحى.
- استخدم الأرقام العربية {٠١٢٣٤٥٦٧٨٩} عند طباعة النتائج في النص للمستخدم.
- تأكد من تحويل الوحدات بشكل صحيح وعرض القيم الموحدة (كجم/سم) في الحسابات.
`.trim();
  return base ? (base + "\n" + extra) : extra;
}

/* === model calls (deterministic) === */
// تم تنفيذ Exponential Backoff هنا لزيادة الاحترافية
async function callModel(model, body, attempt = 0){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  body.generationConfig = { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 1024 };
  const abort = new AbortController();
  const timeoutMs = 25000;
  const t = setTimeout(()=>abort.abort(), timeoutMs);
  
  try{
    const resp = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body), signal: abort.signal });
    clearTimeout(t); // مسح المؤقت قبل معالجة الاستجابة
    
    const txt = await resp.text();
    let data = null; try{ data = JSON.parse(txt); }catch(_){}

    if(!resp.ok){
      const code = data?.error?.code || resp.status;
      const msg  = data?.error?.message || `HTTP_${resp.status}`;
      
      // تنفيذ Exponential Backoff للتعامل مع الأخطاء 429 و 5xx
      if ((code === 429 || String(code).startsWith("5")) && attempt < 3) {
        const delay = Math.pow(2, attempt) * 600; // 600ms, 1200ms, 2400ms
        await new Promise(res => setTimeout(res, delay));
        return callModel(model, body, attempt + 1); // محاولة جديدة
      }

      return { ok:false, error: msg, code };
    }
    
    const reply =
      data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("") ||
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      
    if(!reply || !reply.trim()) return { ok:false, error:"empty_reply" };
    
    return { ok:true, reply: sanitizeReply(reply) };
  }catch(e){
    clearTimeout(t);
    return { ok:false, error: String(e && e.message || e), code: "network_or_timeout" };
  }
}
async function tryModelsSequential(body){
  const errors = {};
  for (const model of MODEL_POOL){
    const r = await callModel(model, body);
    if (r.ok) return { ok:true, model, reply: r.reply };
    errors[model] = r.error;
    // لا حاجة لإعادة المحاولة هنا لأنها تمت داخل callModel
  }
  return { ok:false, errors };
}


/* === energy & missing === */
function computeEnergy(state, pack){
  const W = +state.weight_kg, H = +state.height_cm, A = +state.age_years;
  if(!W || !H || !A || !state.sex || !state.activity_key) return null;
  const act = pack?.knowledge?.activity_factors || {};
  const factor = act[state.activity_key] || 1.2;
  let BMR = 0;
  
  // تطبيق معادلة Mifflin-St Jeor
  if(state.sex==="male"){ 
    BMR = 10*W + 6.25*H - 5*A + 5; 
  }
  else if (state.sex==="female"){ 
    BMR = 10*W + 6.25*H - 5*A - 161; 
  } else {
    // حالة الجنس غير معروف
    return null; 
  }
  
  const TDEE = BMR * factor;
  let kcal = TDEE;
  
  // تطبيق استهداف السعرات الحرارية
  if(state.goal==="loss") kcal = TDEE * 0.8; // ~20% عجز
  else if(state.goal==="gain") kcal = TDEE * 1.1; // ~10% فائض
  else if(state.goal==="maintain" || state.goal==="build") kcal = TDEE;
  
  // تقريب لأقرب 10 kcal حسب سياسة pack
  return { BMR: Math.round(BMR), TDEE: Math.round(TDEE), kcal_target: Math.round(kcal/10)*10, activity_factor: factor };
}
function requiredFieldsByIntent(intent){
  const full = ["weight_kg","height_cm","age_years","sex","activity_key"];
  if(intent==="calc_calories" || intent==="calc_macros") return full;
  // إذا كان الهدف هو diet_pick، نحتاج البيانات الأساسية أيضًا لاقتراح النظام المناسب
  if(intent==="diet_pick") return full;
  // يمكن إضافة أهداف أخرى هنا
  return [];
}
function computeMissing(state, intent){
  const need = new Set(requiredFieldsByIntent(intent));
  const miss = [];
  for(const k of need){ if(state[k]==null) miss.push(k); }
  return miss;
}
function arabicLabel(field){
  // توفير تسميات عربية أكثر دقة
  return ({
    weight_kg:"الوزن (كجم)",
    height_cm:"الطول (سم)",
    age_years:"العمر (سنة)",
    sex:"الجنس (ذكر/أنثى)",
    activity_key:"مستوى النشاط (خامل/خفيف/متوسط/عال/رياضي)"
  })[field] || field;
}

/* === build model body === */
function genderHint(sex){
  if(sex==="female") return "المخاطبة: مؤنث (إن لزم).";
  if(sex==="male")   return "المخاطبة: مذكّر (إن لزم).";
  return "المخاطبة: حيادية إن لم تُعرف.";
}
function buildModelBody(pack, messages, state, intent, energy, extraUserDirective){
  const systemText = systemPromptFromPack(pack);
  
  // إضافة البيانات الشخصية الموحدة (kg/cm) إلى السياق الداخلي
  const stateSummary = [
    "سياق داخلي مختصر (لا تُظهره للمستخدم):",
    `- وزن: ${state.weight_kg ?? "?"} كجم`,
    `- طول: ${state.height_cm ?? "?"} سم`,
    `- عمر: ${state.age_years ?? "?"} سنة`,
    `- جنس: ${state.sex ?? "?"}`,
    `- نشاط: ${state.activity_key ?? "?"}`,
    `- هدف: ${state.goal ?? "?"}`,
    `- نظام: ${state.diet ?? "?"}`,
    genderHint(state.sex),
  ];
  
  // إضافة بيانات الطاقة إذا كانت متوفرة
  if(energy){
    stateSummary.push(
      `- BMR≈ ${energy.BMR} kcal`,
      `- TDEE≈ ${energy.TDEE} kcal (عامل نشاط ${energy.activity_factor})`,
      `- هدف سعرات≈ ${energy.kcal_target} kcal`
    );
  }
  
  const rules = [
    "- لا تعِد كتابة نص المستخدم أو بياناته داخل الرد.",
    "- الرد 3–8 أسطر بالعربية الفصحى البسيطة.",
    "- سؤال واحد موجّه (أو سؤالان كحد أقصى).",
    "- إن خرج السؤال عن التغذية: اعتذر بلطف وأعِد التوجيه.",
    "- إن تجاهل المستخدم السؤال السابق: كرّر نفس السؤال."
  ];
  
  // دمج السياق والرسالة الأخيرة للمستخدم في محتوى واحد في دور 'user'
  const lastUserText = lastUserMessage(messages);
  const directiveText = extraUserDirective ? `\n- ملاحظة: ${extraUserDirective}` : '';

  const finalUserPrompt = 
    stateSummary.join("\n") + 
    "\n[إرشادات التنفيذ]" +
    rules.join("\n") +
    directiveText + 
    `\n\n[رسالة المستخدم]: ${lastUserText}`;
    
  // إرسال جميع الرسائل السابقة بالإضافة إلى الموجه النهائي
  const contents = toGeminiContents(messages);
  contents.pop(); // إزالة الرسالة الأخيرة للمستخدم لأنها أضيفت في finalUserPrompt

  contents.push({ role:"user", parts:[{ text: finalUserPrompt }] });

  return { systemInstruction: { parts:[{ text: systemText }] }, contents, safetySettings: [] };
}

/* === Handler === */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  try{
    // فحص الاشتراك
    const gate = await ensureActiveSubscription(event);
    if(!gate.ok) return bad(gate.code, gate.msg);
  }catch(e){ return bad(500, "subscription_gate_error: " + e.message); }

  let body = {};
  try{ body = JSON.parse(event.body || "{}"); }
  catch{ return bad(400, "invalid_json_body"); }

  const messages = Array.isArray(body.messages) ? body.messages.map(m=>({ role:String(m.role||"").toLowerCase(), content:String(m.content||"") })) : [];

  if (!messages.length) return ok({ reply: "", model: "no-op", diagnostics:{ reason:"no_messages_provided" } });

  const lastUserRaw = lastUserMessage(messages) || "";
  const utter = extractUtterance(lastUserRaw); // النص المعالج بالأرقام الإنجليزية
  const lastAssistant = lastOfRole(messages, "assistant");

  // intent/pack logic
  let pack;
  try{ pack = await loadPack(false); }
  catch(e){ pack = {}; }
  
  const intent = detectIntent(utter, pack);
  const state = buildState(messages, pack);
  const energy = computeEnergy(state, pack);


  // --- 1. Quick Off-Scope & Greeting ---
  
  // كشف النطاق السريع: إذا لم يكن ترحيبًا ولم يحتوي على أي كلمة في نطاق التغذية
  const offscopeQuick = !!utter && !GREET_ANY_RE.test(utter) && !SCOPE_ALLOW_RE.test(utter);

  if(offscopeQuick && intent !== "greet"){
    const offScopeDirective = String(pack?.prompts?.off_scope || "أعتذر بلطف، اختصاصي تغذية فقط. ما هدفك الغذائي الآن؟");
    return ok({ reply: offScopeDirective, model: "server-guard-offscope" });
  }
  
  if(intent === "greet"){
    const greetingText = String(pack?.prompts?.greeting || "وعليكم السلام ورحمة الله، أهلًا بك! ما هدفك الآن؟ ثم أرسل: وزنك/طولك/عمرك/جنسك/نشاطك.");
    // استخدام نموذج للترحيب لجعله طبيعيًا أكثر
    const bodyModel = { systemInstruction: { parts:[{ text: systemPromptFromPack(pack) }] }, contents: [{ role:"user", parts:[{ text: greetingText }] }] };
    const attempt = await tryModelsSequential(bodyModel);
    if(attempt.ok) return ok({ reply: attempt.reply, model: attempt.model });
    return ok({ reply: greetingText, model: "server-fallback-greeting", diagnostics:{ reason:"all_models_failed_on_greeting" } });
  }
  
  // --- 2. Repeat Previous Question (Ambiguous/Unanswered) ---

  let repeatPreviousQuestion = false;
  let previousQuestionText = null;
  const missingForIntent = computeMissing(state, intent);

  if(lastAssistant && /[؟?]/.test(lastAssistant)){
    const ambiguous = isAmbiguousAffirmation(utter);
    
    // التكرار يحدث إذا كان الرد مبهمًا، أو إذا كان الرد لم يكمل البيانات الناقصة المطلوبة للنية
    if(ambiguous || (missingForIntent.length > 0 && !lastUserRaw.includes(lastAssistant))){
        repeatPreviousQuestion = true;
        // استخراج السؤال الأخير فقط
        const questionLines = lastAssistant.split(/\n/).filter(l => /[؟?]/.test(l));
        previousQuestionText = questionLines[questionLines.length - 1] || lastAssistant;
    }
  }

  if(repeatPreviousQuestion && previousQuestionText){
    const text = (pack?.prompts?.repeat_unanswered || "يبدو أن سؤالي السابق لم يُجب بعد. للمتابعة بدقة: {{question}}").replace("{{question}}", previousQuestionText.trim());
    return ok({ reply: text, model: "server-guard-repeat" });
  }

  // --- 3. Ask for Missing Data ---
  
  if(missingForIntent.length > 0){
    // إذا كان النقص في معلومة واحدة أو اثنتين، اطلبها مباشرة
    if(missingForIntent.length <= 2){
      const ask = "لا أستطيع الإكمال بدقة دون: " + missingForIntent.map(arabicLabel).join(" و ") + ".";
      const hint = pack?.logic_policies?.format_hint || "أرسلها بصيغة سريعة مثل: 90ك، 175سم، 28 سنة، ذكر، نشاط خفيف.";
      return ok({ reply: `${ask}\n${hint}`, model:"server-guard-missing-short" });
    }else{
      // إذا كان النقص كبيرًا، اطلب الحزمة الكاملة
      const bundle = String(pack?.prompts?.ask_missing_bundle || "لو تكرّمت أرسل: وزن __ كجم، طول __ سم، عمر __ سنة، جنس ذكر/أنثى، نشاط خفيف/متوسط/عال.");
      return ok({ reply: bundle, model:"server-guard-missing-full" });
    }
  }

  // --- 4. Call Model (Main Logic) ---

  const bodyModel = buildModelBody(pack, messages, state, intent, energy, null);
  const attempt = await tryModelsSequential(bodyModel);
  if (attempt.ok) return ok({ reply: attempt.reply, model: attempt.model });

  // Fallback آمن إذا فشلت جميع المحاولات
  const safeFallback = "حدث تعذّر مؤقّت في توليد الرد. أعد المحاولة لاحقًا أو أرسل: وزنك/طولك/عمرك/جنسك/نشاطك وهدفك وسأحسبها لك فورًا.";
  return ok({ reply: safeFallback, model: "server-fallback-main", diagnostics:{ reason:"all_models_failed_main", errors: attempt.errors } });
};
