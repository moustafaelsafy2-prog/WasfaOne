// /netlify/functions/aiDietAssistant.js
// Arabic Diet Assistant — Human-like, flexible, memory-aware
// • نفس أسلوب استدعاء Gemini العامل لديك (v1beta generateContent):
//   systemInstruction + contents + tools(functionDeclarations) + generationConfig + safetySettings[]
// • تسلسل عبر MODEL_POOL + مهلة/إلغاء + تتبّع أخطاء واضح
// • أدوات محلية (calculateCalories/parseFoods/correctText) مع تنفيذ محلّي عبر function calling loop
// • ذاكرة خفيفة قابلة للإرجاع للعميل لتُرسل في الطلب التالي
// • حارس نطاق (تغذية فقط) + تحية افتراضية عند أول نداء بدون رسالة
// • استخراج مرن لرسالة المستخدم: messages[] | message | text | prompt | q

/* ───────────────────────── إعدادات عامة ───────────────────────── */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// تماثل تجميعة generateRecipe لضمان أعلى توافر/سرعة
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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });

/* ───────────────────────── أدوات محلية (Tooling) ───────────────────────── */
/** تعريف الأدوات كما يفهمها Gemini (function calling) **/
const Tools = {
  calculateCalories: {
    name: "calculateCalories",
    description:
      "احسب BMR وTDEE وتوزيع الماكروز حسب الهدف (cut|recomp|bulk) مع الجنس/العمر/الطول/الوزن/النشاط.",
    parameters: {
      type: "OBJECT",
      properties: {
        sex: { type: "STRING", description: "male|female" },
        age: { type: "NUMBER", description: "بالسنوات" },
        height_cm: { type: "NUMBER", description: "الطول بالسم" },
        weight_kg: { type: "NUMBER", description: "الوزن بالكجم" },
        activity_level: { type: "STRING", description: "sedentary|light|moderate|high|athlete" },
        goal: { type: "STRING", description: "cut|recomp|bulk" },
        macro_pref: {
          type: "OBJECT",
          description: "اختياري: نسب الماكروز",
          properties: {
            protein_ratio: { type: "NUMBER" },
            fat_ratio: { type: "NUMBER" },
            carb_ratio: { type: "NUMBER" }
          }
        },
        protein_per_kg: { type: "NUMBER", description: "جرام/كجم (يغلب على النسب إن وُجد)" },
        deficit_or_surplus_pct: { type: "NUMBER", description: "±% من TDEE (اختياري)" }
      },
      required: ["sex","age","height_cm","weight_kg","activity_level","goal"]
    }
  },

  parseFoods: {
    name: "parseFoods",
    description:
      "حلّل عناصر طعام نصية حرة وأعد تقديرًا للسعرات/البروتين/الدهون/الكارب لكل عنصر + الإجمالي.",
    parameters: {
      type: "OBJECT",
      properties: {
        items: { type: "ARRAY", items: { type: "STRING" }, description: "عناصر الطعام" },
        locale: { type: "STRING", description: "ar|en" }
      },
      required: ["items"]
    }
  },

  correctText: {
    name: "correctText",
    description:
      "تصحيح عربي بسيط للأخطاء الشائعة مع الحفاظ على المعنى. يعيد النص المصحح فقط.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING" } },
      required: ["text"]
    }
  }
};

/** تنفيذ الأدوات محليًا **/
const LocalToolExecutors = {
  calculateCalories: (args) => {
    const { sex, age, height_cm, weight_kg, activity_level, goal, macro_pref, protein_per_kg, deficit_or_surplus_pct } = args || {};
    // عوامل النشاط
    function activityFactor(level) {
      switch ((level || "").toLowerCase()) {
        case "sedentary": return 1.2;
        case "light":     return 1.375;
        case "moderate":  return 1.55;
        case "high":      return 1.725;
        case "athlete":   return 1.9;
        default:          return 1.4;
      }
    }
    const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
    const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;

    // معادلة Mifflin–St Jeor
    const s = sex && String(sex).toLowerCase() === "female" ? -161 : 5;
    const BMR = 10 * weight_kg + 6.25 * height_cm - 5 * age + s;

    const TDEE_base = BMR * activityFactor(activity_level);
    const adjPct = (typeof deficit_or_surplus_pct === "number")
      ? deficit_or_surplus_pct
      : (goal === "cut" ? -15 : goal === "bulk" ? 12 : 0);

    const TDEE = TDEE_base * (1 + adjPct / 100);

    // بروتين
    const protein = (typeof protein_per_kg === "number" && protein_per_kg > 0)
      ? protein_per_kg * weight_kg
      : clamp(1.6 * weight_kg, 1.4 * weight_kg, 2.2 * weight_kg);

    const protein_kcal = protein * 4;

    // نسب افتراضية حسب الهدف
    let fat_ratio = 0.35, carb_ratio = 0.35;
    if (goal === "cut")  { fat_ratio = 0.40; carb_ratio = 0.25; }
    if (goal === "bulk") { fat_ratio = 0.30; carb_ratio = 0.45; }
    if (macro_pref) {
      fat_ratio  = (macro_pref.fat_ratio  ?? fat_ratio);
      carb_ratio = (macro_pref.carb_ratio ?? carb_ratio);
    }

    const rem_kcal = Math.max(0, TDEE - protein_kcal);
    const fat  = (rem_kcal * fat_ratio)  / 9;
    const carbs= (rem_kcal * carb_ratio) / 4;

    return {
      BMR: round1(BMR),
      TDEE_base: round1(TDEE_base),
      TDEE: round1(TDEE),
      protein_g: round1(protein),
      fat_g: round1(fat),
      carbs_g: round1(carbs),
      notes: "تقديرات عملية لضبط البداية. راقب الوزن/المحيط أسبوعيًا وعدّل ±5–10%."
    };
  },

  parseFoods: (args) => {
    const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;
    const db = {
      "بيضة كبيرة":             { kcal:72,  p:6,   f:5,   c:0.4, unit:"حبة" },
      "100g صدر دجاج":          { kcal:165, p:31,  f:3.6, c:0,   unit:"100g" },
      "100g لحم بقري خالي":     { kcal:170, p:26,  f:7,   c:0,   unit:"100g" },
      "100g تونة مصفاة":        { kcal:132, p:29,  f:1,   c:0,   unit:"100g" },
      "100g ارز مطبوخ":         { kcal:130, p:2.7, f:0.3, c:28,  unit:"100g" },
      "100g شوفان":             { kcal:389, p:17,  f:7,   c:66,  unit:"100g" },
      "100g افوكادو":           { kcal:160, p:2,   f:15,  c:9,   unit:"100g" },
      "ملعقة زيت زيتون":       { kcal:119, p:0,   f:13.5,c:0,   unit:"ملعقة" },
      "100g جبنه قريش":         { kcal:98,  p:11,  f:4.3, c:3.4, unit:"100g" },
      "100g زبادي يوناني":      { kcal:59,  p:10,  f:0.4, c:3.6, unit:"100g" },
      "حبة موز":                { kcal:105, p:1.3, f:0.4, c:27,  unit:"حبة" },
      "تفاحة":                  { kcal:95,  p:0.5, f:0.3, c:25,  unit:"حبة" }
    };
    const norm = (s)=>String(s||"").trim().toLowerCase();
    const items = (args?.items||[]).map(s=>String(s||"").trim()).filter(Boolean);

    const mapped = items.map(raw=>{
      const key = norm(raw);
      const match = Object.keys(db).find(k=>key.includes(norm(k)));
      if(!match){
        return { item: raw, approx:true, kcal:0, protein_g:0, fat_g:0, carbs_g:0, note:"حدد الوزن/الكمية بدقة" };
      }
      const r = db[match];
      return { item: raw, approx:false, kcal:r.kcal, protein_g:r.p, fat_g:r.f, carbs_g:r.c, ref_unit:r.unit };
    });

    const totals = mapped.reduce((a,x)=>({ kcal:a.kcal+(x.kcal||0), p:a.p+(x.protein_g||0), f:a.f+(x.fat_g||0), c:a.c+(x.carbs_g||0)}), {kcal:0,p:0,f:0,c:0});
    return { items: mapped, totals: { kcal: round1(totals.kcal), protein_g: round1(totals.p), fat_g: round1(totals.f), carbs_g: round1(totals.c) } };
  },

  correctText: (args) => {
    const t = String(args?.text||"").trim();
    if(!t) return { corrected: "" };
    let x = normalizeArabic(t);
    x = x.replace(/\s{2,}/g," ").trim();
    // أمثلة سريعة شائعة:
    x = x.replace(/\bريجيم\b/gi,"نظام غذائي")
         .replace(/\bكالوري\b/gi,"سعرات")
         .replace(/\bكارب\b/gi,"كربوهيدرات");
    return { corrected: x };
  }
};

/* ───────────────────────── أدوات مساعدة للنص العربي/الذاكرة ───────────────────────── */
function normalizeDigits(s=""){
  const ar = "٠١٢٣٤٥٦٧٨٩", fa = "۰۱۲۳۴۵۶۷۸۹";
  return String(s).replace(/[٠-٩]/g, d => ar.indexOf(d)).replace(/[۰-۹]/g, d => fa.indexOf(d));
}
function normalizeArabic(s){
  return String(s||"")
    .replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g,"") // تشكيل
    .replace(/\u0640/g,"")                                    // تطويل
    .replace(/[إأآ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه")
    .replace(/ؤ/g,"و").replace(/ئ/g,"ي")
    .replace(/\s{2,}/g," ")
    .trim();
}
function cleanUserText(s=""){ return normalizeDigits(normalizeArabic(s)).trim(); }
function trimMemory(s){ return String(s||"").slice(-MAX_MEMORY_CHARS); }
function approxTokens(chars){ return Math.round((chars||0)/4); }

function isOutOfDomain(text){
  const t = cleanUserText(text).toLowerCase();
  return [
    "دواء","ادويه","جرعه","تشخيص","تحاليل","اشعه","سرطان",
    "سياسه","استثمار","سلاح","اختراق","برمجه خبيثه"
  ].some(k=>t.includes(k));
}

/* ───────────────────────── شخصية المساعد (System) ───────────────────────── */
function SYSTEM_PROMPT(){
  return `
أنت خبير تغذية بشري السلوك: مرن، لبق، يفهم اللهجات ويصحّح الأخطاء بلطف، ويتذكر سياق المحادثة ولا يكرر الأسئلة.
[المسموح] كل ما يخص التغذية فقط: حساب السعرات/الماكروز، تحليل وجبات، اقتراح وجبات، توقيت الأكل، حساسيّات غذائية، ماء/ألياف/إلكترولايت.
[المحظور] طب/أدوية/جرعات/تشخيص. عند الطلب الطبي: اعتذر وأعد توجيه الحديث للتغذية.
[أسلوب الرد] عربية موجزة عملية:
1) الهدف الحالي
2) الأرقام (سعرات/ماكروز) إن لزم
3) خطة/خيارات تنفيذية (3–5 نقاط)
4) بدائل ونصائح سريعة
5) سؤال توضيحي واحد فقط إذا لزم
6) تنبيه أن الإرشادات ليست بديلًا طبيًا.
لا تكرر سؤالًا سُئل سابقًا داخل نفس المحادثة. لا تنساق للحشو. صحّح الكلمات الشائعة ثم تابع الإجابة.
`.trim();
}

/* ───────────────────────── تهيئة تعريف الأدوات للنموذج ───────────────────────── */
function geminiToolsSpec(){
  return [
    {
      functionDeclarations: Object.values(Tools).map(t => ({
        name: t.name, description: t.description, parameters: t.parameters
      }))
    }
  ];
}

/* ───────────────────────── بناء بطاقة المستخدم والمُدخل ───────────────────────── */
function buildUserCard(u={}, locale="ar"){
  const L=[];
  if(u.name) L.push(`الاسم: ${u.name}`);
  if(u.sex) L.push(`الجنس: ${u.sex}`);
  if(Number.isFinite(u.age)) L.push(`العمر: ${u.age}`);
  if(Number.isFinite(u.height_cm)) L.push(`الطول: ${u.height_cm} سم`);
  if(Number.isFinite(u.weight_kg)) L.push(`الوزن: ${u.weight_kg} كجم`);
  if(u.activity_level) L.push(`النشاط: ${u.activity_level}`);
  if(u.goal) L.push(`الهدف: ${u.goal}`);
  if(u.preferences) L.push(`تفضيلات: ${Array.isArray(u.preferences)?u.preferences.join(", "):u.preferences}`);
  if(u.allergies) L.push(`حساسيات: ${Array.isArray(u.allergies)?u.allergies.join(", "):u.allergies}`);
  L.push(`اللغة: ${locale||"ar"}`);
  return L.join(" | ");
}

function userPrompt({ message, memoryBlob, userCard }){
  const msg  = cleanUserText(message||"");
  const mem  = memoryBlob ? `\n[سياق مختصر]\n${trimMemory(memoryBlob)}` : "";
  const card = userCard   ? `\n[بطاقة المستخدم]\n${userCard}` : "";
  return `${card}${mem}\n\n[الطلب]\n${msg}\n\nأجب وفق أسلوب النظام أعلاه: عملي، موجز، بلا حشو.`;
}

/* ───────────────────────── استدعاء Gemini مع function calling loop ───────────────────────── */
async function callGeminiWithTools({ model, messages, memoryBlob }){
  // تحويل الرسائل لصيغة Gemini
  const contents = [];
  if(memoryBlob){
    contents.push({ role:"user", parts:[{ text:`سياق سابق مختصر:\n${trimMemory(memoryBlob)}` }] });
  }
  for(const m of (messages||[])){
    const role = m.role === "assistant" ? "model" : m.role; // user|model
    if(role === "system") continue; // سنستخدم systemInstruction
    contents.push({ role, parts:[{ text: String(m.content||"") }] });
  }

  // حلقة تنفيذ الأدوات (حتى 4 دورات)
  let loop = 0;
  let lastResponse = null;
  let toolInvocations = [];
  let currentContents = contents.slice();

  while(loop < 4){
    loop++;

    const body = {
      contents: currentContents,
      tools: geminiToolsSpec(),
      systemInstruction: { role:"system", parts:[{ text: SYSTEM_PROMPT() }] },
      generationConfig: { temperature: 0.25, topP: 0.95, maxOutputTokens: 1500 },
      safetySettings: []
    };

    const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const abort = new AbortController();
    const t = setTimeout(()=>abort.abort(), 28000);
    let data;

    try{
      const resp = await fetch(url, {
        method:"POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(body),
        signal: abort.signal
      });

      const raw = await resp.text();
      try{ data = JSON.parse(raw); }catch{ data = null; }
      if(!resp.ok){
        const msg = data?.error?.message || `HTTP_${resp.status}`;
        throw new Error(msg);
      }
    }finally{ clearTimeout(t); }

    lastResponse = data;
    const candidate = data?.candidates?.[0];
    if(!candidate) break;

    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.map(p=>p?.functionCall).filter(Boolean);

    if(!functionCalls?.length){
      // لا يوجد نداء أداة -> إجابة نهائية
      break;
    }

    // نفذ جميع النداءات محليًا وارجع بردّ الأداة
    for(const fc of functionCalls){
      const name = fc?.name;
      let args = {};
      try{ args = fc?.args ? JSON.parse(fc.args) : {}; }catch{ args = {}; }

      const exec = LocalToolExecutors[name];
      let result;
      if(exec){
        try{ result = exec(args); }catch(e){ result = { error:`tool-exec-failed:${e.message}` }; }
      }else{
        result = { error:`tool-not-found:${name}` };
      }

      toolInvocations.push({ name, args, result });

      currentContents.push({
        role: "tool",
        parts: [
          { functionResponse: { name, response: { name, content: result } } }
        ]
      });
    }
    // سيعيد الدور لتوليد ردّ نهائي بعد تغذية نتائج الأدوات
  }

  return { lastResponse, toolInvocations };
}

/* ───────────────────────── اختيار نموذج مع السقوط الاحتياطي ───────────────────────── */
async function generateWithFallback(payload){
  const errors = {};
  for(const model of MODEL_POOL){
    try{
      const out = await callGeminiWithTools({ model, ...payload });
      const text =
        out?.lastResponse?.candidates?.[0]?.content?.parts
          ?.map(p => p?.text || "")
          ?.filter(Boolean)
          ?.join("\n")
          ?.trim() || "";

      if(text){
        return { ok:true, model, text, toolInvocations: out.toolInvocations };
      }else{
        errors[model] = "empty-response";
      }
    }catch(e){
      errors[model] = String(e && e.message || e);
    }
  }
  return { ok:false, errors, tried: MODEL_POOL };
}

/* ───────────────────────── استخراج رسالة المستخدم بمرونة ───────────────────────── */
function extractLastUserMessage(req){
  // 1) messages[]
  if (Array.isArray(req?.messages) && req.messages.length){
    const lastU = [...req.messages].reverse().find(m=>m && m.role==="user" && m.content);
    if(lastU?.content) return String(lastU.content);
  }
  // 2) مفاتيح شائعة
  for(const k of ["message","text","prompt","q"]){
    if(typeof req?.[k] === "string" && req[k].trim()) return req[k];
  }
  return "";
}

/* ───────────────────────── Handler ───────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST")   return bad(405, "Method Not Allowed");
  if (!GEMINI_API_KEY)               return bad(500, "GEMINI_API_KEY is missing on the server");

  let req = {};
  try{ req = JSON.parse(event.body || "{}"); }catch{ req = {}; }

  const { messages = [], memory = "", user = {}, locale = "ar" } = req;

  // رسالة المستخدم (مرنة)
  const lastUserMsg = extractLastUserMessage(req);

  // تحية تلقائية عند النداء الأول بدون رسالة
  if(!lastUserMsg){
    const greeting = "مرحبًا بك 👋 أنا مساعد التغذية. أرسل: الجنس/العمر/الطول/الوزن/النشاط/الهدف وسأحسب لك السعرات والماكروز مع خطة يومية عملية.";
    const mem = `${trimMemory(memory)}\nassistant:${greeting}`.slice(-MAX_MEMORY_CHARS);
    return ok({ reply: greeting, memory: mem, meta:{ model:null, guard:"empty_init" } });
  }

  // نطاق التغذية فقط
  if(isOutOfDomain(lastUserMsg)){
    const reply = "اختصاصي تغذية فقط. أخبرني بهدفك وبياناتك (الجنس، العمر، الطول، الوزن، النشاط) لأضبط لك السعرات والماكروز وخيارات وجبات مناسبة.";
    const mem = `${trimMemory(memory)}\nuser:${lastUserMsg}\nassistant:${reply}`.slice(-MAX_MEMORY_CHARS);
    return ok({ reply, memory: mem, meta:{ model:null, guard:"out_of_domain" } });
  }

  // رسائل مزخرفة إلى النموذج (نحافظ على systemInstruction + tools + contents)
  const userCard = buildUserCard(user || {}, locale);
  const decoratedMessages = [
    { role:"user", content: `بطاقة المستخدم للتخصيص فقط (لا للعرض):\n${userCard}\n—\nتعليمات: كن مرنًا، صحّح لغويًا بلطف، لا تكرر الأسئلة، تذكّر السياق، واسأل سؤالًا واحدًا فقط عند الحاجة.` },
    ...messages
  ];

  const attempt = await generateWithFallback({
    messages: decoratedMessages,
    memoryBlob: memory || ""
  });

  if(!attempt.ok){
    const reply = "تعذّر مؤقت في التوليد. أعد الإرسال بصياغة مختصرة أو أرسل بياناتك (الجنس، العمر، الطول، الوزن، النشاط، الهدف) لحسابات دقيقة وخطة عملية.";
    const mem = `${trimMemory(memory)}\nuser:${lastUserMsg}\nassistant:${reply}`.slice(-MAX_MEMORY_CHARS);
    return ok({ reply, memory: mem, meta:{ model:"server-fallback", diagnostics: attempt.errors, tried: attempt.tried } });
  }

  // ما بعد المعالجة الخفيفة + تنبيه طبي
  let text = String(attempt.text||"").replace(/\n{3,}/g,"\n\n").trim();
  if (!/ليست بديل/i.test(text)) {
    text += "\n\n**تنبيه:** الإرشادات ليست بديلاً عن الاستشارة الطبية.";
  }

  // تحديث الذاكرة
  const newMemory = `${trimMemory(memory)}\nuser:${lastUserMsg}\nassistant:${text}`.slice(-MAX_MEMORY_CHARS);

  return ok({
    reply: text,
    memory: newMemory,
    meta: {
      model: attempt.model,
      tools: attempt.toolInvocations || [],
      tokens_hint: approxTokens((event.body||"").length + text.length)
    }
  });
};
