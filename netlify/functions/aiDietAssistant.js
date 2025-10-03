// /netlify/functions/aiDietAssistant.js
// Deterministic Arabic diet assistant — NO auto-greeting without user input.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MODEL_POOL = ["gemini-1.5-pro","gemini-1.5-flash","gemini-pro"];

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";
const PACK_PATH  = "data/assistant_pack.json";

async function ghGetJson(path){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content), sha: data.sha };
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

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-Session-Nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

async function ensureActiveSubscription(event) {
  const token = event.headers["x-auth-token"] || event.headers["X-Auth-Token"];
  const nonce = event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"];
  if (!token || !nonce) return { ok:false, code:401, msg:"unauthorized" };
  const { json: users } = await ghGetJson(USERS_PATH);
  const idx = (users||[]).findIndex(u => (u.token||u.auth_token||"") === token);
  if (idx === -1) return { ok:false, code:401, msg:"unauthorized" };
  const user = users[idx];
  if ((user.session_nonce||"") !== nonce) return { ok:false, code:401, msg:"bad_session" };
  const today = todayDubai();
  if (user.end_date && today > user.end_date) return { ok:false, code:403, msg:"subscription_expired" };
  if ((String(user.status||"").toLowerCase() !== "active") || !withinWindow(user.start_date, user.end_date))
    return { ok:false, code:403, msg:"inactive_or_out_of_window" };
  return { ok:true, user };
}

let PACK_CACHE = { data:null, ts:0 };
async function loadPack(force=false){
  const maxAgeMs = 5*60*1000;
  const now = Date.now();
  if(!force && PACK_CACHE.data && (now - PACK_CACHE.ts) < maxAgeMs) return PACK_CACHE.data;
  try{
    const { json } = await ghGetJson(PACK_PATH);
    PACK_CACHE = { data: json || {}, ts: now };
    return PACK_CACHE.data || {};
  }catch{
    return {
      system: "أنت مساعد تغذية عربي عملي ودقيق…",
      prompts:{
        greeting: "وعليكم السلام ورحمة الله، أهلًا بك! ما هدفك الآن؟ ثم أرسل: وزنك/طولك/عمرك/جنسك/نشاطك.",
        off_scope: "أعتذر بلطف، اختصاصي تغذية فقط. ما هدفك الغذائي الآن؟",
        repeat_unanswered: "يبدو أنّ سؤالي السابق لم يُجب بعد. للمتابعة بدقّة: {{question}}"
      },
      extract_regex:{},
      knowledge:{ activity_factors:{ sedentary:1.2, light:1.375, moderate:1.55, active:1.725, athlete:1.9 } },
      conversions:{ lb_to_kg:0.45359237, inch_to_cm:2.54, ft_to_cm:30.48, m_to_cm:100 }
    };
  }
}

const SCOPE_ALLOW_RE = /(?:سعرات|كالور|ماكروز|بروتين|دهون|كارب|كربوهيدرات|ألياف|ماء|ترطيب|نظام|حِمية|رجيم|وجبة|وصفات|صيام|كيتو|لو كارب|متوسطي|داش|نباتي|macro|protein|carb|fat|fiber|calorie|diet|meal|fasting|glycemic|keto|mediterranean|dash|vegan|lchf)/i;
const GREET_RE = /^(?:\s*(?:السلام\s*عليكم|وعليكم\s*السلام|مرحبا|مرحباً|أهلًا|اهلاً|هلا|مساء الخير|صباح الخير)\b|^\s*السلام\s*$)/i;

function sanitizeReply(t=""){
  let s = String(t||"").replace(/```[\s\S]*?```/g,"");
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu,"");
  s = s.split("\n").filter(line => !/^\s*>/.test(line)).join("\n");
  s = s.trim().replace(/\n{3,}/g,"\n\n");
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
function normalizeDigits(s=""){
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  return String(s||"").replace(/[\u0660-\u0669]/g, d => map[d] ?? d);
}

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

  const state = { weight_kg:null, height_cm:null, age_years:null, sex:null, activity_key:null, goal:null, diet:null };

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
    return Math.round(v);
  }
  function parseNumeric(x){ const v = parseFloat(String(x).replace(",", ".")); return Number.isFinite(v) ? v : null; }

  function applyFrom(text0){
    if(!text0) return;
    const text = normalizeDigits(text0);

    const wMatch = RE_WEIGHT ? text.match(RE_WEIGHT) : null;
    if(wMatch){
      let w = parseNumeric(wMatch[1]);
      if(w!=null){
        const after = text.slice((wMatch.index||0) + String(wMatch[0]||"").length, (wMatch.index||0)+String(wMatch[0]||"").length+8);
        if(/lb|lbs|باوند|رطل/i.test(after)) w = w * (conv.lb_to_kg || 0.45359237);
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
    if(sMatch){ state.sex = mapSex(sMatch[1]) || state.sex; }

    const actMatch = RE_ACT ? text.match(RE_ACT) : null;
    if(actMatch){ state.activity_key = mapActivity(actMatch[1]) || state.activity_key; }

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

function computeEnergy(state, pack){
  const W = +state.weight_kg, H = +state.height_cm, A = +state.age_years;
  if(!W || !H || !A || !state.sex || !state.activity_key) return null;
  const act = pack?.knowledge?.activity_factors || {};
  const factor = act[state.activity_key] || 1.2;
  let BMR = 0;
  if(state.sex==="male"){ BMR = 10*W + 6.25*H - 5*A + 5; }
  else { BMR = 10*W + 6.25*H - 5*A - 161; }
  const TDEE = BMR * factor;
  let kcal = TDEE;
  if(state.goal==="loss") kcal = TDEE * 0.8;
  else if(state.goal==="gain") kcal = TDEE * 1.1;
  else if(state.goal==="maintain") kcal = TDEE;
  return { BMR: Math.round(BMR), TDEE: Math.round(TDEE), kcal_target: Math.round(kcal/10)*10, activity_factor: factor };
}

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
function isAmbiguousAffirmation(s){
  return /\b(نعم|اي|أجل|تمام|طيب|اوكي|موافق|اكيد|Yes|Yeah|Ok|Okay)\b/i.test(String(s||""));
}

function systemPromptFromPack(pack){
  const base = String(pack?.system || "").trim();
  const extra = `
[قيود أسلوبية]
- لا تعِدْ نسخ نصّ المستخدم أو بياناته حرفيًا داخل الرد.
- إن احتجت تأكيدًا فاجعله في جملة موجزة.
- لا تبدأ بأسطر فارغة. الرد 3–8 أسطر بالعربية الفصحى.
`.trim();
  return base ? (base + "\n" + extra) : extra;
}

async function callModel(model, body){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  body.generationConfig = { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 1024 };
  const abort = new AbortController();
  const timeoutMs = 25000;
  const t = setTimeout(()=>abort.abort(), timeoutMs);
  try{
    const resp = await fetch(url, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body), signal: abort.signal
    });
    const txt = await resp.text();
    let data = null; try{ data = JSON.parse(txt); }catch(_){}
    if(!resp.ok){
      const code = data?.error?.code || resp.status;
      const msg  = data?.error?.message || `HTTP_${resp.status}`;
      return { ok:false, error: msg, code };
    }
    const reply =
      data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("") ||
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if(!reply || !reply.trim()) return { ok:false, error:"empty_reply" };
    return { ok:true, reply: sanitizeReply(reply) };
  }catch(e){
    return { ok:false, error: String(e && e.message || e), code: "network_or_timeout" };
  }finally{ clearTimeout(t); }
}
async function tryModelsSequential(body){
  const errors = {};
  for (const model of MODEL_POOL){
    const r1 = await callModel(model, body);
    if (r1.ok) return { ok:true, model, reply: r1.reply };
    errors[model] = r1.error;
    if (String(r1.code).startsWith("5") || String(r1.code) === "429"){
      await new Promise(res=>setTimeout(res, 600));
      const r2 = await callModel(model, body);
      if (r2.ok) return { ok:true, model, reply: r2.reply };
      errors[model] += ` | retry:${r2.error}`;
    }
  }
  return { ok:false, errors };
}

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
    "- لا تعِد كتابة نص المستخدم أو بياناته داخل الرد.",
    "- الرد 3–8 أسطر بالعربية الفصحى البسيطة.",
    "- سؤال واحد موجّه (أو سؤالان كحد أقصى).",
    "- إن خرج السؤال عن التغذية: اعتذر بلطف وأعِد التوجيه.",
    "- إن تجاهل المستخدم السؤال السابق: كرّر نفس السؤال."
  ];
  if(energy){
    summary.push(
      `- BMR≈ ${energy.BMR} kcal`,
      `- TDEE≈ ${energy.TDEE} kcal (عامل نشاط ${energy.activity_factor})`,
      `- هدف سعرات≈ ${energy.kcal_target} kcal`
    );
  }
  if(extraUserDirective) summary.push(`- ملاحظة: ${extraUserDirective}`);

  const contents = toGeminiContents(messages);
  contents.push({ role:"user", parts:[{ text: summary.join("\n") }] });

  return { systemInstruction: { role:"system", parts:[{ text: systemText }] }, contents, safetySettings: [] };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  try{
    const gate = await ensureActiveSubscription(event);
    if(!gate.ok) return bad(gate.code, gate.msg);
  }catch(_){ return bad(500, "subscription_gate_error"); }

  let body = {};
  try{ body = JSON.parse(event.body || "{}"); }
  catch{ return bad(400, "invalid_json_body"); }

  const messages = Array.isArray(body.messages) ? body.messages.map(m=>({ role:String(m.role||"").toLowerCase(), content:String(m.content||"") })) : [];

  // 🔒 التغيير الحاسم: لا ردّ إطلاقًا إن لم يصل نص من المستخدم
  if (!messages.length) return ok({ reply: "", model: "no-op", diagnostics:{ reason:"no_messages_provided" } });

  const lastUser = lastUserMessage(messages);
  const lastAssistant = lastOfRole(messages, "assistant");
  const hasUserUtterance = typeof lastUser === "string" && lastUser.trim().length > 0;

  // تحية فقط الآن تُفعّل فقط إن وُجدت رسالة مستخدم وتطابق التحية
  const isGreetingOnly = hasUserUtterance && GREET_RE.test(String(lastUser||"").trim());

  let pack;
  try{ pack = await loadPack(false); }
  catch(e){ pack = {}; }

  const offscopeQuick = hasUserUtterance && !GREET_RE.test(lastUser) && !SCOPE_ALLOW_RE.test(lastUser);
  const intent = isGreetingOnly ? "greet" : (hasUserUtterance ? detectIntent(lastUser, pack) : "chat");

  const state = buildState(messages, pack);
  const energy = computeEnergy(state, pack);

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

  if(isGreetingOnly){
    const greetingText = String(pack?.prompts?.greeting || "وعليكم السلام ورحمة الله، أهلًا بك! ما هدفك الآن؟ ثم أرسل: وزنك/طولك/عمرك/جنسك/نشاطك.");
    const bodyModel = {
      systemInstruction: { role:"system", parts:[{ text: systemPromptFromPack(pack) }] },
      contents: [{ role:"user", parts:[{ text: greetingText }] }],
      safetySettings: []
    };
    const attempt = await tryModelsSequential(bodyModel);
    if(attempt.ok) return ok({ reply: attempt.reply, model: attempt.model });
    return ok({ reply: greetingText, model: "server-fallback", diagnostics:{ reason:"all_models_failed_on_greeting" } });
  }

  if(offscopeQuick){
    const offScopeDirective = String(pack?.prompts?.off_scope || "أعتذر بلطف، اختصاصي تغذية فقط. أعد صياغة سؤالك ضمن التغذية (أنظمة، سعرات/ماكروز، وجبات، بدائل، حساسيات…). ما هدفك الغذائي الآن؟");
    const bodyModel = {
      systemInstruction: { role:"system", parts:[{ text: systemPromptFromPack(pack) }] },
      contents: [{ role:"user", parts:[{ text: offScopeDirective }] }],
      safetySettings: []
    };
    const attempt = await tryModelsSequential(bodyModel);
    if(attempt.ok) return ok({ reply: attempt.reply, model: attempt.model });
    return ok({ reply: offScopeDirective, model: "server-fallback", diagnostics:{ reason:"all_models_failed_offscope" } });
  }

  if(repeatPreviousQuestion && previousQuestionText){
    const text = (pack?.prompts?.repeat_unanswered || "يبدو أن سؤالي السابق لم يُجب بعد. للمتابعة بدقة: {{question}}")
      .replace("{{question}}", previousQuestionText.trim());
    return ok({ reply: text, model: "server-guard" });
  }

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

  const bodyModel = buildModelBody(pack, messages, state, intent, energy, null);
  const attempt = await tryModelsSequential(bodyModel);
  if (attempt.ok) return ok({ reply: attempt.reply, model: attempt.model });

  const safeFallback = "حدث تعذّر مؤقّت في توليد الرد. أعد المحاولة لاحقًا أو أرسل: وزنك/طولك/عمرك/جنسك/نشاطك وهدفك وسأحسبها لك فورًا.";
  return ok({ reply: safeFallback, model: "server-fallback", diagnostics:{ reason:"all_models_failed_main" } });
};
