// /netlify/functions/aiDietAssistant.js
// Arabic Diet Assistant — Conversational, human-like, memory-aware
// — يستعمل نفس أسلوب استدعاء Gemini العامل لديك (v1beta generateContent):
//    systemInstruction + contents + generationConfig + safetySettings[]
// — تسلسل عبر MODEL_POOL + مهلة مع AbortController + فحص أخطاء واضح
// — ذاكرة خفيفة تُمرَّر وتُعاد للعميل ليحتفظ بها
// — حارس نطاق: تغذية فقط (لا تشخيص/أدوية)
// — تصحيح عربي مبسّط + تحويل أرقام هندية

/* ───────────────────────── إعدادات عامة ───────────────────────── */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// نفس التجميعة المستخدمة في generateRecipe لضمان أعلى توافر
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

// أقصى حجم للذاكرة النصية
const MAX_MEMORY_CHARS = 14000;

/* ───────────────────────── HTTP ───────────────────────── */
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });

/* ───────────────────────── أدوات & تطبيع عربي ───────────────────────── */
function normalizeArabic(s){
  return String(s||"")
    .replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g,"") // تشكيل
    .replace(/\u0640/g,"") // تطويل
    .replace(/[إأآ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه")
    .replace(/ؤ/g,"و").replace(/ئ/g,"ي")
    .replace(/\s{2,}/g," ")
    .trim();
}
function normalizeDigits(s=""){
  const ar = "٠١٢٣٤٥٦٧٨٩", fa = "۰۱۲۳۴۵۶۷۸۹";
  return String(s).replace(/[٠-٩]/g, d => ar.indexOf(d)).replace(/[۰-۹]/g, d => fa.indexOf(d));
}
function cleanUserText(s=""){ return normalizeDigits(normalizeArabic(s)).trim(); }
function trimMemory(s){ return String(s||"").slice(-MAX_MEMORY_CHARS); }
function approxTokens(chars){ return Math.round((chars||0)/4); }

function isOutOfDomain(text){
  const t = cleanUserText(text).toLowerCase();
  return [
    "دواء","ادويه","جرعه","تشخيص","تحاليل","اشعه","سرطان",
    "سياسه","استثمار","برمجه خبيثه","اختراق","سلاح"
  ].some(k=>t.includes(k));
}

/* ───────────────────────── شخصية المساعد ───────────────────────── */
function systemInstruction(){
  return `
أنت خبير تغذية بشري السلوك: لبق، مرن، يفهم اللهجات ويصحّح الأخطاء بلطف، ويتذكر سياق المحادثة ولا يكرر الأسئلة.
[المسموح]
- كل ما يخص التغذية فقط: حساب السعرات/الماكروز، تحليل وجبات، تنظيم أوقات الأكل، اقتراح بدائل، حساسيّات غذائية، نصائح سلوك غذائي وماء/ألياف/إلكترولايت.
[المحظور]
- تشخيصات طبية أو أدوية أو جرعات أو وعود علاجية. عند الطلب الطبي: اعتذر وحافظ على النطاق الغذائي.
[أسلوب الرد]
- العربية الفصحى المختصرة. هيكل واضح قابل للتنفيذ:
1) الهدف الحالي
2) السعرات والماكروز (أرقام)
3) خطة أو خيارات عملية (3–4 نقاط)
4) بدائل سريعة/نصائح
5) سؤال توضيحي واحد فقط عند الحاجة
6) تنبيه: الإرشادات ليست بديلاً عن الاستشارة الطبية.
- لا تكرر ما قاله المستخدم حرفيًا. لا تسهب. صحّح الكلمات الشائعة ثم تجاوب.
`.trim();
}

/* ───────────────────────── بناء مُدخل المستخدم للنموذج ───────────────────────── */
function buildUserCard(u={}, locale="ar"){
  const lines = [];
  if(u.name) lines.push(`الاسم: ${u.name}`);
  if(u.sex) lines.push(`الجنس: ${u.sex}`);
  if(Number.isFinite(u.age)) lines.push(`العمر: ${u.age}`);
  if(Number.isFinite(u.height_cm)) lines.push(`الطول: ${u.height_cm} سم`);
  if(Number.isFinite(u.weight_kg)) lines.push(`الوزن: ${u.weight_kg} كجم`);
  if(u.activity_level) lines.push(`النشاط: ${u.activity_level}`);
  if(u.goal) lines.push(`الهدف: ${u.goal}`);
  if(u.preferences) lines.push(`تفضيلات: ${Array.isArray(u.preferences)?u.preferences.join(", "):u.preferences}`);
  if(u.allergies) lines.push(`حساسيات: ${Array.isArray(u.allergies)?u.allergies.join(", "):u.allergies}`);
  lines.push(`اللغة: ${locale||"ar"}`);
  return lines.join(" | ");
}

function userPrompt({ message, memoryBlob, userCard }){
  const msg = cleanUserText(message||"");
  const mem = memoryBlob ? `\n[سياق مختصر من الحديث السابق]\n${trimMemory(memoryBlob)}` : "";
  const card = userCard ? `\n[بطاقة تعريف المستخدم]\n${userCard}` : "";
  return `${card}${mem}\n\n[الطلب]\n${msg}\n\nأجب وفق أسلوب النظام أعلاه، وكن عمليًا ومباشرًا.`;
}

/* ───────────────────────── استدعاء Gemini (مطابق لطريقة generateRecipe) ───────────────────────── */
async function callOnce(model, input, timeoutMs = 28000){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    systemInstruction: { role:"system", parts:[{ text: systemInstruction() }] },
    contents: [{ role:"user", parts:[{ text: userPrompt(input) }]}],
    generationConfig: { temperature: 0.25, topP: 0.95, maxOutputTokens: 1500 },
    safetySettings: [] // لا نريد حظرًا غير ضروري في سياق غذائي
  };

  const abort = new AbortController();
  const t = setTimeout(()=>abort.abort(), Math.max(1000, Math.min(29000, timeoutMs)));

  try{
    const resp = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body),
      signal: abort.signal
    });
    const text = await resp.text();

    let data = null;
    try{ data = JSON.parse(text); } catch{ /* قد تكون رسالة نصية عند الأخطاء */ }

    if(!resp.ok){
      const msg = data?.error?.message || `HTTP_${resp.status}`;
      return { ok:false, error: msg };
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const reply = parts.map(p=>p?.text||"").filter(Boolean).join("").trim();
    if(!reply) return { ok:false, error:"empty_reply" };

    return { ok:true, reply };
  }catch(e){
    return { ok:false, error: String(e && e.message || e) };
  }finally{
    clearTimeout(t);
  }
}

async function tryModelsSequential(input){
  const errors = {};
  for(const model of MODEL_POOL){
    const r = await callOnce(model, input);
    if(r.ok) return { ok:true, model, reply:r.reply };
    errors[model] = r.error;
  }
  return { ok:false, errors, tried: MODEL_POOL };
}

/* ───────────────────────── Handler ───────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");

  let req = {};
  try{ req = JSON.parse(event.body || "{}"); }
  catch{ return bad(400, "invalid_json_body"); }

  const {
    messages = [],                 // [{role:'user'|'assistant', content:string}, ...]
    memory = "",                   // blob تعيده الواجهة معنا
    user = {},                     // بطاقة تعريف اختيارية
    locale = "ar"
  } = req;

  const lastUserMsg = (messages.slice().reverse().find(m=>m.role==="user")?.content || "").trim();
  if(!lastUserMsg) return bad(400, "missing_last_user_message");

  // نطاق التغذية فقط
  if (isOutOfDomain(lastUserMsg)){
    const reply = "اختصاصي تغذية فقط. أرسل: الجنس/العمر/الطول/الوزن/النشاط/الهدف لأحسب السعرات والماكروز وخطة يومية عملية.";
    const mem = `${trimMemory(memory)}\nuser:${lastUserMsg}\nassistant:${reply}`.slice(-MAX_MEMORY_CHARS);
    return ok({ reply, memory: mem, meta:{ model:null, guard:"out_of_domain" } });
  }

  // تهيئة إدخال النماذج بنفس أسلوب generateRecipe
  const input = {
    message: lastUserMsg,
    memoryBlob: memory || "",
    userCard: buildUserCard(user || {}, locale)
  };

  const attempt = await tryModelsSequential(input);
  if (!attempt.ok){
    // Fallback آمن وغير صاخب
    const reply = "تعذّر مؤقت في التوليد. أعد الإرسال بصياغة مختصرة أو أرسل بياناتك (الجنس، العمر، الطول، الوزن، النشاط، الهدف) لأعطيك حسابات دقيقة وخطة عملية.";
    const mem = `${trimMemory(memory)}\nuser:${lastUserMsg}\nassistant:${reply}`.slice(-MAX_MEMORY_CHARS);
    return ok({ reply, memory: mem, meta:{ model:"server-fallback", diagnostics: attempt.errors, tried: attempt.tried } });
  }

  // ما بعد المعالجة الخفيفة
  let text = String(attempt.reply||"").replace(/\n{3,}/g,"\n\n").trim();
  if (!/ليست بديلًا? عن الاستشارة الطبية/i.test(text)) {
    text += "\n\n**تنبيه:** الإرشادات ليست بديلاً عن الاستشارة الطبية.";
  }

  // تحديث الذاكرة
  const newMemory = `${trimMemory(memory)}\nuser:${lastUserMsg}\nassistant:${text}`.slice(-MAX_MEMORY_CHARS);

  return ok({
    reply: text,
    memory: newMemory,
    meta: { model: attempt.model, tokens_hint: approxTokens((event.body||"").length + text.length) }
  });
};
