// netlify/functions/aiDietAssistant.js
// Diet-only Arabic WhatsApp-like assistant — ultra-precise, context-aware, and resilient.
// ✅ يتذكّر كامل المحادثة (آخر 16 تبادلاً على الأقل)
// ✅ يردّ السلام، ويحيّي، ويعيد السؤال نفسه إن لم يُجَب
// ✅ يلتقط الوزن/الطول/العمر/الجنس/النشاط من أي رسالة سابقة ويُوحّد الوحدات
// ✅ يتعامل مع الأرقام العربية ٠١٢٣٤٥٦٧٨٩ والإنجليزية، والقدم/البوصة، والباوند
// ✅ يكشف النواقص ويسأل فقط عمّا ينقص (سؤال واحد أو اثنان)
// ✅ يحسم التعارض: الأحدث ينسخ الأقدم
// ✅ حارس نطاق تغذية فقط + تحويل لرد اعتذاري لطيف عند الخروج
// ✅ يحسب BMR/TDEE على الخادم عند توافر المعطيات ويزوّد النموذج بها
// ✅ يمنع اقتباس/إعادة لصق كلام المستخدم أو بياناته داخل الرد
// ✅ يضبط المخاطبة مذكّر/مؤنّث عند الإمكان

/* ===== بيئة Gemini ===== */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/* ===== حوض النماذج ===== */
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

/* ===== GitHub (اشتراك + تحميل حزم المعرفة) ===== */
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";
const PACK_PATH  = "data/assistant_pack.json"; // الحزمة المصغّرة (تعليمات+معرفة)

/* ===== GitHub helpers ===== */
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

/* ===== وقت دبي + نافذة الاشتراك ===== */
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

/* ===== HTTP ===== */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Session-Nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

/* ===== اشتراك ===== */
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

/* ===== تحميل حزمة المعرفة مع كاش داخلي ===== */
let PACK_CACHE = { data:null, ts:0 };
async function loadPack(force=false){
  const maxAgeMs = 5*60*1000; // 5 دقائق
  const now = Date.now();
  if(!force && PACK_CACHE.data && (now - PACK_CACHE.ts) < maxAgeMs) return PACK_CACHE.data;
  try{
    const { json } = await ghGetJson(PACK_PATH);
    PACK_CACHE = { data: json || {}, ts: now };
    return PACK_CACHE.data || {};
  }catch{
    // fallback بسيط إن لم تتوفر الحزمة
    const fallback = {
      system: "أنت مساعد تغذية عربي عملي ودقيق. رحّب وردّ السلام، واكتب ردودًا موجزة (3–8 أسطر) دون زخارف. التزم بالنطاق الغذائي فقط. لا تعِد نسخ نص المستخدم أو بياناته حرفيًا. إذا احتجت تأكيدًا فاجعله بجملة موجزة. اسأل نقصًا واحدًا أو اثنين بحد أقصى. عند عدم الإجابة: كرّر نفس السؤال بلطف بنفس الصياغة أو صياغة أقصر. اذكر الحسابات بإيجاز عند الحاجة. لا تبدأ بأسطر فارغة.",
      prompts:{
        greeting: "وعليكم السلام ورحمة الله، أنا مساعدك التغذوي. ما هدفك الحالي؟ ثم أرسل: وزنك/طولك/عمرك/جنسك/نشاطك.",
        off_scope: "أعتذر بلطف، اختصاصي تغذية فقط. أعد صياغة سؤالك ضمن التغذية (أنظمة، سعرات/ماكروز، وجبات، بدائل، حساسيات…). ما هدفك الغذائي الآن؟",
        repeat_unanswered: "يبدو أنّ سؤالي السابق لم يُجب بعد. للمتابعة بدقّة: {{question}}"
      },
      intents:{
        off_scope:["\\b(سعر|ذهب|سياسة|برمجة|تداول|استثمار|دين)\\b"],
        calc_calories:["سعرات","السعرات","حساب\\s*سعرات","TDEE","BMR"],
        calc_macros:["ماكرو","ماكروز","macros","macro"],
        diet_pick:["كيتو","متوسطي","داش","لو\\s*كارب","نباتي","vegan","keto","med"]
      },
      extract_regex:{
        weight_any:"(?:وزني|وزن|kg|كيلو|كجم|كغ)\\s*[:=]?(\\d+(?:[\\.,]\\d+)?)",
        height_any:"(?:طولي|طول|سم|cm|m)\\s*[:=]?(\\d+(?:[\\.,]\\d+)?)(?:\\s*(?:سم|cm|m))?",
        height_ft_in:"(\\d+)\\s*(?:ft|قدم)\\s*(\\d+)\\s*(?:in|بوصة|انش)",
        age_years:"(?:عمري|عمر|سني|سن|\\bage\\b)\\s*[:=]?(\\d{1,3})",
        sex:"\\b(ذكر|أنثى|انثى|male|female)\\b",
        activity:"\\b(خامل|قليل\\s*الحركة|متوسط|عال|رياضي|sedentary|light|moderate|active|athlete|very\\s*active)\\b",
        goal:"(خسارة|تنزيل|انقاص|زيادة|حفاظ|تثبيت|بناء\\s*عضل)",
        diet:"(كيتو|keto|لوكارب|lchf|متوسطي|med|dash|داش|نباتي|vegan|balanced|متوازن)"
      },
      knowledge:{
        activity_aliases:{
          "خامل":"sedentary","قليل الحركة":"light","خفيف الحركة":"light","متوسط":"moderate","عال":"active","رياضي":"athlete",
          "sedentary":"sedentary","light":"light","moderate":"moderate","active":"active","athlete":"athlete","very active":"athlete"
        },
        sex_aliases:{ "ذكر":"male","Male":"male","male":"male","أنثى":"female","انثى":"female","Female":"female","female":"female" },
        activity_factors:{ sedentary:1.2, light:1.375, moderate:1.55, active:1.725, athlete:1.9 },
        formulas:{ targets:{}, mifflin:{} }
      },
      conversions:{ lb_to_kg:0.45359237, inch_to_cm:2.54, ft_to_cm:30.48, m_to_cm:100 }
    };
    PACK_CACHE = { data:fallback, ts: now };
    return fallback;
  }
}

/* ===== حارس النطاق ===== */
const SCOPE_ALLOW_RE = /(?:سعرات|كالور|ماكروز|بروتين|دهون|كار|كارب|كربوهيدرات|ألياف|ماء|ترطيب|نظام|حِمية|رجيم|وجبة|وصفات|غذائ|صيام|كيتو|لو كارب|متوسطي|داش|نباتي|نباتيه|سعر حراري|مؤشر جلايسيمي|حساسي|تحسس|سكري|ضغط|كلى|كبد|كوليسترول|وجبات|تقسيم السعرات|macro|protein|carb|fat|fiber|calorie|diet|meal|fasting|glycemic|keto|mediterranean|dash|vegan|lchf)/i;

/* ===== تحية ===== */
const GREET_RE = /^(?:\s*(?:السلام\s*عليكم|وعليكم\s*السلام|مرحبا|مرحباً|أهلًا|اهلاً|هلا|مساء الخير|صباح الخير)\b|^\s*السلام\s*$)/i;

/* ===== أدوات مساعدة ===== */
function sanitizeReply(t=""){
  // إزالة كتل كود والإيموجي
  let s = String(t||"").replace(/```[\s\S]*?```/g,"");
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu,"");

  // منع اقتباس نص المستخدم إن وُجد على شكل > أو """: احذف أي سطر يبدأ بـ ">" أو يحتوي """user"""
  s = s.split("\n").filter(line => !/^\s*>/.test(line)).join("\n");

  // تقليل الفراغات: لا أسطر فارغة في البداية، ولا أسطر متتالية كثيرة
  s = s.trim().replace(/\n{3,}/g,"\n\n");

  // سطر افتتاحي زائد مثل "أهلاً وسهلاً بك!" فقط دون محتوى؟ اتركه ثم أكمل؛ لا حاجة لتعديل إضافي هنا
  return s;
}
function toGeminiContents(messages){
  const hist = (Array.isArray(messages)? messages : []).slice(-16);
  return hist.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content||"") }]
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

/* ===== تطبيع الأرقام العربية → إنجليزية ===== */
function normalizeDigits(s=""){
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(s||"").replace(/[\u0660-\u0669]/g, d => map[d] ?? d);
}

/* ===== استخراج المعطيات من كامل المحادثة ===== */
function buildState(messages, pack){
  const rx = pack?.extract_regex || {};
  const re = (p)=> p ? new RegExp(p,'i') : null;

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

  const state = {
    weight_kg:null,
    height_cm:null,
    age_years:null,
    sex:null,              // "male"/"female"
    activity_key:null,     // sedentary/light/moderate/active/athlete
    goal:null,             // loss/gain/maintain/build
    diet:null,             // keto/med/lchf/dash/vegan/balanced...
    raw:{}
  };

  function mapActivity(txt){
    const t = (txt||"").trim();
    const key = activityAliases[t] || null;
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
    const key = sexAliases[t] || null;
    if(key) return key;
    if(/male/i.test(t)) return "male";
    if(/female/i.test(t)) return "female";
    return null;
  }
  function normalizeHeight(num, unitText){
    let v = +num;
    if(!Number.isFinite(v)) return null;
    const u = (unitText||"").toLowerCase();
    if(/m\b/.test(u)) return Math.round(v * (conv.m_to_cm || 100));
    return Math.round(v); // افتراضي سم
  }
  function parseNumeric(x){ const v = parseFloat(String(x).replace(",", ".")); return Number.isFinite(v) ? v : null; }

  function applyFrom(text0){
    if(!text0) return;
    const text = normalizeDigits(text0);

    const wMatch = RE_WEIGHT ? text.match(RE_WEIGHT) : null;
    if(wMatch){
      let w = parseNumeric(wMatch[1]);
      if(w!=null){
        const unit = text.slice(wMatch.index || 0).slice(String(wMatch[0]||"").indexOf(wMatch[1])+String(wMatch[1]).length).slice(0,8);
        if(/lb|lbs|باوند|رطل/i.test(unit)) w = w * (conv.lb_to_kg || 0.45359237);
        state.weight_kg = Math.round(w * 10) / 10;
      }
    }

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
          const unitText = (hMatch[0]||"").replace(String(hMatch[1]), "");
          state.height_cm = normalizeHeight(h, unitText);
        }
      }
    }

    const aMatch = RE_AGE ? text.match(RE_AGE) : null;
    if(aMatch){
      const a = parseNumeric(aMatch[1]);
      if(a!=null) state.age_years = Math.round(a);
    }

    const sMatch = RE_SEX ? text.match(RE_SEX) : null;
    if(sMatch){
      state.sex = mapSex(sMatch[1]) || state.sex;
    }

    const actMatch = RE_ACT ? text.match(RE_ACT) : null;
    if(actMatch){
      state.activity_key = mapActivity(actMatch[1]) || state.activity_key;
    }

    const gMatch = RE_GOAL ? text.match(RE_GOAL) : null;
    if(gMatch){
      const gRaw = gMatch[1];
      if(/خس|تنزيل|انقاص/i.test(gRaw)) state.goal = "loss";
      else if(/زياد/i.test(gRaw)) state.goal = "gain";
      else if(/حفاظ|تثبيت/i.test(gRaw)) state.goal = "maintain";
      else if(/بناء\s*عضل/i.test(gRaw)) state.goal = "build";
    }

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

  for(const m of (messages||[])){ if(m && typeof m.content==="string"){ applyFrom(m.content); } }
  return state;
}

/* ===== نوايا ===== */
function detectIntent(lastUser, pack){
  const intents = pack?.intents || {};
  const t = normalizeDigits(lastUser||"");
  function hit(keys){ return Array.isArray(keys) && keys.some(k=> new RegExp(k,'i').test(t)); }
  if(GREET_RE.test(t)) return "greet";
  if(hit(intents.off_scope)) return "off_scope";
  if(hit(intents.calc_calories)) return "calc_calories";
  if(hit(intents.calc_macros)) return "calc_macros";
  if(hit(intents.diet_pick)) return "diet_pick";
  return "chat";
}

/* ===== حسابات BMR/TDEE ===== */
function computeEnergy(state, pack){
  const W = +state.weight_kg, H = +state.height_cm, A = +state.age_years;
  if(!W || !H || !A || !state.sex || !state.activity_key) return null;

  const act = pack?.knowledge?.activity_factors || {};
  const factor = act[state.activity_key] || 1.2;

  let BMR = 0;
  if(state.sex==="male"){
    BMR = 10*W + 6.25*H - 5*A + 5;
  }else{
    BMR = 10*W + 6.25*H - 5*A - 161;
  }
  const TDEE = BMR * factor;

  let kcal = TDEE;
  if(state.goal==="loss") kcal = TDEE * 0.8;
  else if(state.goal==="gain") kcal = TDEE * 1.1;
  else if(state.goal==="maintain") kcal = TDEE;

  return {
    BMR: Math.round(BMR),
    TDEE: Math.round(TDEE),
    kcal_target: Math.round(kcal/10)*10,
    activity_factor: factor
  };
}

/* ===== النواقص ===== */
function requiredFieldsByIntent(intent){
  const full = ["weight_kg","height_cm","age_years","sex","activity_key"];
  if(intent==="calc_calories" || intent==="calc_macros") return full;
  return [];
}
function computeMissing(state, intent){
  const need = new Set(requiredFieldsByIntent(intent));
  const miss = [];
  for(const k of need){ if(state[k]==null) miss.push(k); }
  return miss;
}
function arabicLabel(field){
  return ({
    weight_kg:"الوزن (كجم)",
    height_cm:"الطول (سم)",
    age_years:"العمر (سنة)",
    sex:"الجنس (ذكر/أنثى)",
    activity_key:"مستوى النشاط (خامل/خفيف/متوسط/عال/رياضي)"
  })[field] || field;
}

/* ===== إجابة مبهمة ===== */
function isAmbiguousAffirmation(s){
  return /\b(نعم|اي|أجل|تمام|طيب|اوكي|موافق|اكيد|Yes|Yeah|Ok|Okay)\b/i.test(String(s||""));
}

/* ===== تعليمات النظام (تمنع اقتباس المستخدم) ===== */
function systemPromptFromPack(pack){
  const base = String(pack?.system || "").trim();
  const extra = `
[قيود أسلوبية حاسمة]
- لا تعِدْ نسخ نصّ المستخدم أو بياناته حرفيًا داخل الرد. لا تقتبس كلامه ولا تسرده سطرًا بسطر.
- إن احتجت تأكيدًا فاجعله في جملة موجزة مثل: "للتأكيد: هدفك خسارة الوزن؟"
- لا تبدأ بأسطر فارغة. اجعل الافتتاح سطرًا واحدًا واضحًا ثم صلب الرد.
- استخدم مخاطبة مناسبة (مذكر/مؤنث) إن أمكن، دون مبالغة.
`.trim();
  return base ? (base + "\n" + extra) : extra;
}

/* ===== استدعاء النموذج ===== */
async function callModel(model, body){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const abort = new AbortController();
  const timeoutMs = 24000;
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

/* ===== بناء محتوى الطلب للنموذج ===== */
function genderHint(sex){
  if(sex==="female") return "المخاطبة: مؤنث (إن لزم).";
  if(sex==="male")   return "المخاطبة: مذكّر (إن لزم).";
  return "المخاطبة: حيادية إن لم تُعرف.";
}
function buildModelBody(pack, messages, state, intent, energy, extraUserDirective){
  const systemText = systemPromptFromPack(pack);

  const summary = [
    "سياق داخلي مختصر (لا تُظهره للمستخدم):",
    `- وزن: ${state.weight_kg ?? "?"} كجم`,
    `- طول: ${state.height_cm ?? "?"} سم`,
    `- عمر: ${state.age_years ?? "?"} سنة`,
    `- جنس: ${state.sex ?? "?"}`,
    `- نشاط: ${state.activity_key ?? "?"}`,
    `- هدف: ${state.goal ?? "?"}`,
    `- نظام: ${state.diet ?? "?"}`,
    genderHint(state.sex),
    "- لا تعِد كتابة نص المستخدم أو بياناته داخل الرد. اكتفِ بتأكيد موجز عند الحاجة.",
    "- الرد 3–8 أسطر، عربية فصحى بسيطة، بلا زخارف/إيموجي.",
    "- اسأل سؤالًا واحدًا موجّهًا (أو سؤالين بحد أقصى).",
    "- إن خرج السؤال عن التغذية: اعتذر بلطف وأعِد التوجيه.",
    "- إن تجاهل المستخدم السؤال السابق: كرّر نفس السؤال بلطف بنفس المعنى."
  ];
  if(energy){
    summary.push(
      `- BMR≈ ${energy.BMR} kcal`,
      `- TDEE≈ ${energy.TDEE} kcal (عامل نشاط ${energy.activity_factor})`,
      `- هدف سعرات مبدئي≈ ${energy.kcal_target} kcal`
    );
  }
  if(extraUserDirective) summary.push(`- ملاحظة: ${extraUserDirective}`);

  const contents = toGeminiContents(messages);
  contents.push({ role:"user", parts:[{ text: summary.join("\n") }] });

  return {
    systemInstruction: { role:"system", parts:[{ text: systemText }] },
    contents,
    generationConfig: { temperature: 0.18, topP: 0.9, maxOutputTokens: 900 },
    safetySettings: []
  };
}

/* ===== Handler ===== */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  // اشتراك
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

  const messages = Array.isArray(body.messages) ? body.messages.map(m=>({ role:String(m.role||"").toLowerCase(), content:String(m.content||"") })) : [];
  const scope = String(body.scope||"diet_only").toLowerCase();
  const lastUser = lastUserMessage(messages);
  const lastAssistant = lastOfRole(messages, "assistant");
  const isGreetingOnly = (!messages.length) || GREET_RE.test(String(lastUser||"").trim());

  // تحميل الحزمة
  let pack;
  try{ pack = await loadPack(false); }
  catch(e){ pack = {}; }

  // حارس نطاق سريع
  const offscopeQuick = (scope === "diet_only") && lastUser && !SCOPE_ALLOW_RE.test(lastUser) && !GREET_RE.test(lastUser);
  // نية
  const intent = isGreetingOnly ? "greet" : detectIntent(lastUser, pack);

  // بناء حالة المستخدم من كامل المحادثة
  const state = buildState(messages, pack);

  // حسابات BMR/TDEE إن أمكن
  const energy = computeEnergy(state, pack);

  // كشف سؤال سابق غير مُجاب
  let repeatPreviousQuestion = false;
  let previousQuestionText = null;
  if(lastAssistant){
    const hadQuestion = /[؟?]/.test(lastAssistant);
    if(hadQuestion){
      const ambiguous = isAmbiguousAffirmation(lastUser);
      const missNow = computeMissing(state, intent);
      if(ambiguous || missNow.length>0){
        repeatPreviousQuestion = true;
        previousQuestionText = lastAssistant.split(/\n/).find(l=>/[؟?]/.test(l)) || lastAssistant;
      }
    }
  }

  // تحية فقط
  if(isGreetingOnly){
    const greeting = String(pack?.prompts?.greeting || "وعليكم السلام ورحمة الله، أنا مساعدك التغذوي. ما هدفك الحالي؟ ثم أرسل: وزنك/طولك/عمرك/جنسك/نشاطك.");
    const bodyModel = {
      systemInstruction: { role:"system", parts:[{ text: systemPromptFromPack(pack) }] },
      contents: [{ role:"user", parts:[{ text: greeting }] }],
      generationConfig: { temperature: 0.18, topP: 0.9, maxOutputTokens: 380 },
      safetySettings: []
    };
    for(const model of MODEL_POOL){
      const r = await callModel(model, bodyModel);
      if(r.ok) return ok({ reply: r.reply, model });
    }
    return bad(502, "model_failed_greeting");
  }

  // خارج النطاق
  if(offscopeQuick || intent === "off_scope"){
    const offScopeDirective = String(pack?.prompts?.off_scope || "أعتذر بلطف، اختصاصي تغذية فقط. أعد صياغة سؤالك ضمن التغذية (أنظمة، سعرات/ماكروز، وجبات، بدائل، حساسيات…). ما هدفك الغذائي الآن؟");
    const bodyModel = {
      systemInstruction: { role:"system", parts:[{ text: systemPromptFromPack(pack) }] },
      contents: [{ role:"user", parts:[{ text: offScopeDirective }] }],
      generationConfig: { temperature: 0.12, topP: 0.9, maxOutputTokens: 240 },
      safetySettings: []
    };
    for(const model of MODEL_POOL){
      const r = await callModel(model, bodyModel);
      if(r.ok) return ok({ reply: r.reply, model });
    }
    return ok({ reply: offScopeDirective, model: "server-fallback" });
  }

  // لو السؤال السابق لم يُجب — كرّر نفس السؤال بلطف
  if(repeatPreviousQuestion && previousQuestionText){
    const text = (pack?.prompts?.repeat_unanswered || "يبدو أن سؤالي السابق لم يُجب بعد. للمتابعة بدقّة: {{question}}")
      .replace("{{question}}", previousQuestionText.trim());
    return ok({ reply: text, model: "server-guard" });
  }

  // نواقص مطلوبة للحساب
  const missing = computeMissing(state, intent);
  if(missing.length>0){
    if(missing.length <= 2){
      const ask = "لا أستطيع الإكمال بدقة دون: " + missing.map(arabicLabel).join(" و ") + ".";
      const hint = "أرسلها بصيغة سريعة مثل: 90ك، 175سم، 28 سنة، ذكر، نشاط خفيف.";
      return ok({ reply: `${ask}\n${hint}`, model:"server-guard" });
    }else{
      const bundle = String(pack?.prompts?.ask_missing_bundle || "لو تكرّمت أرسل: وزن __ كجم، طول __ سم، عمر __ سنة، جنس ذكر/أنثى، نشاط خفيف/متوسط/عال.");
      return ok({ reply: bundle, model:"server-guard" });
    }
  }

  // “نعم” مبهمة بعد سؤال تفضيل
  if(isAmbiguousAffirmation(lastUser) && /(?:أم|or|\bvs\b)/i.test(lastAssistant||"")){
    const text = String(pack?.prompts?.clarify_ambiguous_yes || "للتأكيد: هل تقصد {{option_a}} أم {{option_b}}؟")
      .replace("{{option_a}}","الخيار الأول")
      .replace("{{option_b}}","الخيار الثاني");
    return ok({ reply: text, model:"server-guard" });
  }

  // بناء الطلب للنموذج مع ملخص داخلي “لا تُظهره”
  const userDirective = null;
  const bodyModel = buildModelBody(pack, messages, state, intent, energy, userDirective);

  // استدعاء النموذج عبر الحوض
  const errors = {};
  for (const model of MODEL_POOL){
    const r = await callModel(model, bodyModel);
    if (r.ok){
      return ok({ reply: r.reply, model });
    }
    errors[model] = r.error;
  }

  // فشل كل النماذج
  const safeFallback = "حدث تعذّر مؤقّت في توليد الرد. أعد المحاولة أو أرسل: وزنك/طولك/عمرك/جنسك/نشاطك وهدفك وسأحسبها لك فورًا.";
  return bad(502, "All models failed", { errors, tried: MODEL_POOL, reply: safeFallback });
};
