// /netlify/functions/aiDietAssistant.js
// Arabic-first • Human-like nutrition expert • Robust like generateRecipe.js
// Unified headers/CORS, strict error codes, no empty replies, timeout, safe JSON parsing

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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

/* ---------------- HTTP helpers ---------------- */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

/* ---------------- Utils ---------------- */
const MAX_MEMORY_CHARS = 14000;
const toStr = (x) => (typeof x === "string" ? x : JSON.stringify(x||""));
const clamp = (x,min,max)=>Math.min(max,Math.max(min,x));
function trimMemory(s){ return String(s||"").slice(-MAX_MEMORY_CHARS); }
function approxTokensIn(chars){ return Math.round(chars/4); }

function normalizeArabic(s){
  return String(s||"")
    .replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g,"")
    .replace(/\u0640/g,"")
    .replace(/[إأآ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه")
    .replace(/ؤ/g,"و").replace(/ئ/g,"ي")
    .replace(/\s{2,}/g," ").trim().toLowerCase();
}

/* ---------------- Nutrition calculators (as tools-like helpers) ---------------- */
const ACT = { sedentary:1.2, light:1.375, moderate:1.55, active:1.725, very_active:1.9 };
function mifflin({sex="male", weightKg, heightCm, age}){
  if(!weightKg||!heightCm||!age) return null;
  const male = /^(male|m|ذكر)$/i.test(String(sex));
  return 10*weightKg + 6.25*heightCm - 5*age + (male?5:-161);
}
function planCalories({sex,age,heightCm,weightKg,activityLevel="moderate",goal="fat_loss",targetRate="moderate",proteinPerKg=null,macroProfile="low_carb"}){
  const bmr = mifflin({sex,age,heightCm,weightKg});
  const tdee = bmr ? bmr * (ACT[activityLevel] || ACT.moderate) : null;
  let adj = 0;
  if (goal==="fat_loss") adj = targetRate==="aggressive"?-0.25:targetRate==="slow"?-0.10:-0.15;
  else if (goal==="muscle_gain") adj = targetRate==="aggressive"?0.18:targetRate==="slow"?0.08:0.12;

  const calories = tdee ? Math.round(tdee*(1+adj)) : null;
  const p = weightKg ? Math.round((proteinPerKg?clamp(proteinPerKg,1.6,2.4):(goal==="muscle_gain"?2.0:1.8))*weightKg) : null;

  let carbs=null,fat=null;
  if (calories && p!=null){
    if (macroProfile==="keto_strict"||macroProfile==="keto_soft"){
      const fixed = macroProfile==="keto_strict"?20:30;
      carbs = fixed;
      fat = Math.round((calories - p*4 - carbs*4)/9);
    } else {
      const presets = {
        balanced:{c:0.4,f:0.3}, low_carb:{c:0.25,f:0.4}, high_protein:{c:0.3,f:0.3}
      }[macroProfile] || {c:0.3,f:0.35};
      carbs = Math.round((calories*presets.c)/4);
      fat   = Math.round((calories*presets.f)/9);
    }
  }
  return { bmr:bmr?Math.round(bmr):null, tdee:tdee?Math.round(tdee):null, calories,
           macros:(p!=null&&carbs!=null&&fat!=null)?{protein_g:p,carbs_g:carbs,fat_g:fat}:null };
}

/* ---------------- System & Output contracts ---------------- */
function systemPrompt(){
  return `
أنت خبير تغذية مرن يتصرّف كبشري: يفهم صياغات المستخدم حتى لو كانت خاطئة، يصحّحها بلطف، لا يكرر الأسئلة، ويتذكّر سياق المحادثة.
المسموح: حساب السعرات/الماكروز، تحليل وجبات، اقتراح خطط/بدائل/تسوق/تحضير، نصائح تغذية ونمط حياة مرتبط بالتغذية.
المحظور: تشخيصات طبية/جرعات أدوية/وعود علاجية/أي موضوع خارج التغذية — اعتذر بلطف وأعد التوجيه.
الإخراج: عربي واضح بعناوين ونقاط مختصرة، أرقام دقيقة قابلة للتنفيذ، نموذج يوم (3–4 وجبات)، بدائل سريعة، تعليمات تنفيذية، وتنبيه سلامة سطر واحد.
`.trim();
}
function outputContract(){
  return `
**التزم بالشكل:**
1) الهدف الحالي.
2) السعرات والماكروز (أرقام).
3) نموذج يوم غذائي (كميات بالجرام/المل).
4) بدائل سريعة.
5) تعليمات تنفيذية مختصرة.
6) **تنبيه أمان:** هذه إرشادات غذائية عامة وليست بديلاً عن الاستشارة الطبية.
`.trim();
}

/* ---------------- Compose prompt ---------------- */
function buildContext(payload){
  const profile = payload?.profile||{};
  const preferences = payload?.preferences||{};
  const constraints = payload?.constraints||{};

  const plan = planCalories({
    sex: profile.sex, age: profile.age, heightCm: profile.heightCm, weightKg: profile.weightKg,
    activityLevel: profile.activityLevel, goal: profile.goal, targetRate: profile.targetRate,
    proteinPerKg: preferences.proteinPerKg,
    macroProfile: preferences.keto ? (preferences.keto==="strict"?"keto_strict":"keto_soft") : (preferences.macroProfile||"low_carb")
  });

  const lines = [];
  lines.push("بيانات (إن وُجدت):");
  if(profile.sex) lines.push(`- الجنس: ${profile.sex}`);
  if(profile.age) lines.push(`- العمر: ${profile.age}`);
  if(profile.heightCm) lines.push(`- الطول: ${profile.heightCm} سم`);
  if(profile.weightKg) lines.push(`- الوزن: ${profile.weightKg} كجم`);
  if(profile.activityLevel) lines.push(`- النشاط: ${profile.activityLevel}`);
  if(profile.goal) lines.push(`- الهدف: ${profile.goal}`);
  if(profile.targetRate) lines.push(`- سرعة الاستهداف: ${profile.targetRate}`);

  const prefs = [];
  if (preferences.keto) prefs.push(`- كيتو: ${preferences.keto}`);
  if (preferences.macroProfile) prefs.push(`- ملف ماكروز: ${preferences.macroProfile}`);
  if (preferences.allergies?.length) prefs.push(`- حساسية: ${preferences.allergies.join(", ")}`);
  if (preferences.avoids?.length) prefs.push(`- تجنب: ${preferences.avoids.join(", ")}`);
  if (preferences.cuisines?.length) prefs.push(`- مطابخ مفضلة: ${preferences.cuisines.join(", ")}`);
  if (prefs.length){ lines.push("تفضيلات:"); lines.push(...prefs); }

  const cons = [];
  if (constraints.budget) cons.push(`- ميزانية: ${constraints.budget}`);
  if (constraints.mealsPerDay) cons.push(`- عدد الوجبات: ${constraints.mealsPerDay}`);
  if (constraints.fastWindow) cons.push(`- نافذة صيام/أكل: ${constraints.fastWindow}`);
  if (constraints.maxPrepTime) cons.push(`- زمن التحضير/وجبة: ${constraints.maxPrepTime} دقيقة`);
  if (cons.length){ lines.push("قيود:"); lines.push(...cons); }

  if (plan){
    lines.push("حسابات مساعدة:");
    if (plan.bmr) lines.push(`- BMR ~ ${plan.bmr}`);
    if (plan.tdee) lines.push(`- TDEE ~ ${plan.tdee}`);
    if (plan.calories) lines.push(`- سعرات مستهدفة ~ ${plan.calories}`);
    if (plan.macros) lines.push(`- ماكروز: P ${plan.macros.protein_g}g • C ${plan.macros.carbs_g}g • F ${plan.macros.fat_g}g`);
  }
  return lines.join("\n");
}

function composeContents({ userMessage, contextBlock }){
  const sys = systemPrompt();
  const out = outputContract();
  const preface = `[تعليمات النظام]\n${sys}\n\n[سياق]\n${contextBlock}\n\n[عقد الإخراج]\n${out}`;
  return [
    { role: "user", parts: [{ text: preface }] },
    { role: "user", parts: [{ text: `طلب المستخدم:\n${userMessage || "ابدأ"}\n\nأجب وفق العقد أعلاه فقط.` }] }
  ];
}

/* ---------------- Gemini call (with timeout) ---------------- */
function extractTextFromCandidates(data){
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const t = parts.map(p=>p?.text||"").join("").trim();
  return t || "";
}

async function callModel(model, contents, timeoutMs = 28000){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents,
    systemInstruction: { role:"system", parts:[{ text: systemPrompt() }] },
    generationConfig: { temperature: 0.35, topP: 0.9, maxOutputTokens: 2048 },
    safetySettings: []
  };

  const abort = new AbortController();
  const timer = setTimeout(()=>abort.abort(), Math.max(1000, Math.min(29000, timeoutMs)));

  try{
    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body), signal: abort.signal });
    const raw = await r.text();
    let data = null; try{ data = JSON.parse(raw); } catch {}
    if(!r.ok) return { ok:false, error: data?.error?.message || `HTTP_${r.status}` };

    const text = data?.title ? toStr(data) : extractTextFromCandidates(data);
    if(!text) return { ok:false, error:"empty_model_response" };
    return { ok:true, text };
  } catch(e){
    return { ok:false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function generateWithFallback(contents){
  const errors = {};
  for (const model of MODEL_POOL){
    const r = await callModel(model, contents);
    if (r.ok && r.text) return { ok:true, model, text:r.text };
    errors[model] = r.error || "unknown";
  }
  return { ok:false, errors };
}

/* ---------------- Safety: scope guard ---------------- */
function outOfDomain(s){
  const t = normalizeArabic(s);
  return ["دواء","جرعه","تشخيص","تحاليل طبيه","اشعه","عمليه","سرطان"].some(k=>t.includes(k));
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  // Parse input
  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "invalid_json_body"); }

  // Expect API shape (aligned with your frontend)
  const {
    message,
    profile = {},
    preferences = {},
    constraints = {},
    memory = "",
    language = "ar"
  } = payload;

  const lastUserMsg = String(message||"").trim();
  if (!lastUserMsg) return bad(400, "missing_message");

  if (outOfDomain(lastUserMsg)){
    const reply = "أفهم سؤالك، لكن دوري محصور في **التغذية فقط**. اخبرني هدفك وطولك ووزنك ونشاطك لنحسب السعرات ونبني خطة عملية الآن.";
    const mem = (trimMemory(memory) + `\nuser:${lastUserMsg}\nassistant:${reply}`).slice(-MAX_MEMORY_CHARS);
    return ok({ reply, memory: mem, meta:{ model:null, guard:"out-of-domain" } });
  }

  const contextBlock = buildContext({ profile, preferences, constraints });
  const contents = composeContents({ userMessage:lastUserMsg, contextBlock });

  const r = await generateWithFallback(contents);
  if (!r.ok) return bad(502, "all_models_failed", { errors: r.errors });

  // Post-process answer: tidy + mandatory safety line
  let text = (r.text || "").replace(/\n{3,}/g,"\n\n").trim();
  if (!text) return bad(502, "empty_after_postprocess");

  // Append safety footer once
  if (!/ليست بديلًا? عن الاستشارة الطبية/i.test(text)) {
    text += "\n\n**تنبيه أمان:** هذه إرشادات غذائية عامة وليست بديلاً عن الاستشارة الطبية.";
  }

  // Update memory
  const newMemory = (trimMemory(memory) + `\nuser:${lastUserMsg}\nassistant:${text}`).slice(-MAX_MEMORY_CHARS);

  return ok({
    reply: text,
    memory: newMemory,
    meta: {
      model: r.model,
      tokens_hint: approxTokensIn((event.body||"").length + text.length)
    },
    language
  });
};
