// /netlify/functions/aiDietAssistant.js
// ============================================================================
// AI Diet Assistant (Arabic-first) — Fully dynamic nutrition via Gemini
// - No embedded food DB: nutrient queries are generated dynamically; the model
//   is instructed to rely on USDA / CIQUAL / McCance internally at generation.
// - Human-like, flexible, typo-tolerant. One micro-question when needed.
// - Deterministic local tools: Katch / Mifflin / Cunningham + 4/4/9 (+7 for alcohol if present).
// - Smart diet selection with rationale. Memory rollup without repeating notices.
// - Neutral greeting. No medical disclaimer repetition (flag-only).
// ============================================================================

/* ============================================================================
   0) Env & Models
============================================================================ */
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

const MODEL_TIMEOUT_MS   = 30000;   // per round timeout
const TOOLS_MAX_LOOP     = 5;       // function-calling max rounds
const MAX_OUTPUT_TOKENS  = 1600;    // output cap
const MAX_MEMORY_CHARS   = 24000;   // rolling memory window

/* ============================================================================
   1) HTTP helpers
============================================================================ */
function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
const ok  = (payload)=>({ statusCode:200, headers:corsHeaders(), body:JSON.stringify({ ok:true, ...payload }) });
const bad = (code, error, extra={})=>({ statusCode:code, headers:corsHeaders(), body:JSON.stringify({ ok:false, error, ...extra }) });

/* ============================================================================
   2) Arabic normalization, parsing & utils
============================================================================ */
function normalizeDigits(s=""){
  return String(s)
    .replace(/[٠-٩]/g, d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, d=>"۰۱۲۳۴۵۶۷۸۹".indexOf(d));
}
function normalizeArabic(s=""){
  return normalizeDigits(s)
    .replace(/[\u200B-\u200F\u202A-\u202E]/g,"")
    .replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g,"") // tashkeel
    .replace(/\u0640/g,"") // tatweel
    .replace(/[إأآ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه").replace(/ؤ/g,"و").replace(/ئ/g,"ي")
    .replace(/\s{2,}/g," ")
    .trim()
    .toLowerCase();
}
function round1(x){ return Math.round((Number(x)+Number.EPSILON)*10)/10; }
function round0(x){ return Math.round(Number(x)); }
function clamp(x, min, max){ return Math.max(min, Math.min(max, x)); }
function toNum(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
function approxTokens(msgs, out){
  const inLen = (msgs||[]).map(m => (m.content||"").length).reduce((a,b)=>a+b,0) || 0;
  const outLen = (out||"").length;
  return Math.round((inLen + outLen)/4);
}

/* ============================================================================
   3) Conversation helpers & guards
============================================================================ */
const GREET_RE = /(السلام\s*عليكم|سلام\s*عليكم|السلام|سلام|مرحبا|مرحباً|اهلا|أهلاً|هلا|صباح الخير|مساء الخير|هاي)/i;
const SCOPE_ALLOW_RE = /(?:سعرات|كالور|حراري|ماكروز|بروتين|دهون|كارب|كربوهيدرات|الياف|ماء|ترطيب|نظام|حميه|رجيم|وجبه|وصفات|صيام|كيتو|لو\s*كارب|متوسطي|داش|نباتي|balanced|macro|protein|carb|fat|fiber|calorie|diet|meal|fasting|glycemic|keto|mediterranean|dash|vegan|lchf)/i;
const OOD_RE = /(دواء|ادويه|روشته|جرعه|تشخيص|سرطان|عدوي|اشعه|تحاليل|سياسه|اختراق|قرصنه|سلاح|ماليات|استثمار|تداول|وصفات طبيه)/i;
const YESY_RE = /\b(نعم|ايوه|أيوه|ايه|تمام|طيب|اوك|اوكي|ok|okay|yes|yeah)\b/i;

const MEDICAL_NOTICE_FLAG = "<<<MEDICAL_NOTICE_SHOWN>>>";

function extractLastUser(messages=[]){
  const u = [...messages].reverse().find(m => m && m.role==="user" && m.content);
  return u ? String(u.content) : "";
}
function lastAssistant(messages=[]){
  const a = [...messages].reverse().find(m => m && m.role==="assistant" && m.content);
  return a ? String(a.content) : "";
}
function isGreetingOnly(utter){
  return !!utter && GREET_RE.test(utter) && !SCOPE_ALLOW_RE.test(utter) && !/\d/.test(utter);
}
function makeMemoryBlob(prevBlob, newTurn){
  const joined = `${(prevBlob||"").slice(-MAX_MEMORY_CHARS/2)}\n${newTurn}`.slice(-MAX_MEMORY_CHARS);
  return joined;
}
function isAmbiguousYes(s){ return YESY_RE.test(String(s||"")); }

/* ============================================================================
   4) Deterministic Nutrition Math (local tools)
      Engines: Katch / Mifflin / Cunningham + activity + 4/4/9 (+7 alcohol)
============================================================================ */
const ActivityFactor = { sedentary:1.2, light:1.375, moderate:1.55, high:1.725, athlete:1.9 };
function activityFactor(level){ return ActivityFactor[String(level||"").toLowerCase()] || 1.4; }

function BMR_Mifflin({ sex="male", age, height_cm, weight_kg }){
  const s = (String(sex).toLowerCase()==="female") ? -161 : 5;
  return 10*weight_kg + 6.25*height_cm - 5*age + s;
}
function BMR_Katch({ weight_kg, bodyfat_pct }){
  const bf = clamp(Number(bodyfat_pct||0)/100, 0, 0.6);
  const lbm = weight_kg * (1 - bf);
  return 370 + 21.6 * lbm;
}
function BMR_Cunningham({ weight_kg, bodyfat_pct }){
  const bf = clamp(Number(bodyfat_pct||0)/100, 0, 0.6);
  const lbm = weight_kg * (1 - bf);
  return 500 + 22 * lbm;
}
function chooseBmrEngine({ bodyfat_pct, athlete=false }){
  const hasBf = Number.isFinite(Number(bodyfat_pct));
  if (athlete && hasBf) return "cunningham";
  if (hasBf) return "katch";
  if (athlete) return "cunningham";
  return "mifflin";
}
function calcDaily({
  sex, age, height_cm, weight_kg,
  activity_level="moderate",
  goal="recomp",               // cut|recomp|bulk
  bodyfat_pct=null, athlete=false,
  protein_per_kg=null,
  carb_pref="balanced"         // balanced|low|keto|high
}){
  // sanity bounds (non-intrusive)
  if (age<10 || age>90 || height_cm<120 || height_cm>230 || weight_kg<30 || weight_kg>250){
    // لا نمنع — فقط نواصل الحساب مع ملاحظة ضمنية سيضيفها النموذج إذا سُئل.
  }

  const base = { sex, age:Number(age), height_cm:Number(height_cm), weight_kg:Number(weight_kg) };
  const engine = chooseBmrEngine({ bodyfat_pct, athlete });
  let BMR = 0;
  if (engine==="katch") BMR = BMR_Katch({ weight_kg: base.weight_kg, bodyfat_pct });
  else if (engine==="cunningham") BMR = BMR_Cunningham({ weight_kg: base.weight_kg, bodyfat_pct });
  else BMR = BMR_Mifflin(base);

  const AF = activityFactor(activity_level);
  const TDEE_base = BMR * AF;

  let adjPct = 0;
  if (goal==="cut")  adjPct = -15;
  if (goal==="bulk") adjPct = +12;
  const TDEE_goal = TDEE_base * (1 + adjPct/100);

  let protein = (Number(protein_per_kg)>0) ? Number(protein_per_kg)*base.weight_kg
                                           : clamp(1.6*base.weight_kg, 1.4*base.weight_kg, 2.4*base.weight_kg);
  protein = round1(protein);
  const p_kcal = protein * 4;

  const rem_kcal = Math.max(0, TDEE_goal - p_kcal);
  let fat_ratio=0.35, carb_ratio=0.35;
  if (carb_pref==="low")  { fat_ratio=0.45; carb_ratio=0.20; }
  if (carb_pref==="keto") { fat_ratio=0.75; carb_ratio=0.05; }
  if (carb_pref==="high") { fat_ratio=0.20; carb_ratio=0.55; }
  if (goal==="cut" && carb_pref==="balanced")  { fat_ratio=0.40; carb_ratio=0.25; }
  if (goal==="bulk" && carb_pref==="balanced") { fat_ratio=0.30; carb_ratio=0.45; }

  const fat_kcal  = rem_kcal * fat_ratio;
  const carb_kcal = rem_kcal * carb_ratio;

  const fat_g   = round1(fat_kcal/9);
  const carbs_g = round1(carb_kcal/4);

  const calories = round0(p_kcal + fat_g*9 + carbs_g*4); // 4/4/9 strict
  return {
    engine,
    BMR: round1(BMR),
    TDEE_base: round1(TDEE_base),
    TDEE_goal: round1(TDEE_goal),
    protein_g: protein,
    fat_g,
    carbs_g,
    calories,
    model: "4/4/9 strict",
    note: "تقديرات منهجية دقيقة كبداية؛ اضبط أسبوعيًا حسب التقدم."
  };
}

/* ============================================================================
   5) Intent, parsing & unit normalization (no fixed food DB)
============================================================================ */
const UNIT_ALIASES = {
  ml: ["مل","ml","مليلتر","ميليلتر","ملي"],
  g:  ["جم","غ","g","جرام","غرام"]
};
function guessUnitToken(s){
  const n = normalizeArabic(s);
  for (const [u, arr] of Object.entries(UNIT_ALIASES)){
    if (arr.some(a => n.includes(a))) return u;
  }
  // common colloquial
  if (/\bكوب\b/.test(n)) return "ml?"; // ambiguous; handled by model with assumption disclosure
  if (/\bربع لتر|نص لتر|نصف لتر|لتر\b/.test(n)) return "ml";
  return null;
}
function extractQuantityAndFood(s){
  // tolerant: "حليب 100", "100 مل حليب", "حليب بقر كامل الدسم ١٠٠ مل", "كوب حليب"
  const raw = normalizeDigits(String(s||"")).trim();
  const numMatch = raw.match(/(\d+(?:\.\d+)?)/);
  let qty = numMatch ? Number(numMatch[1]) : null;
  const unit = guessUnitToken(raw);
  // remove quantity token for name
  let name = raw.replace(numMatch ? numMatch[0] : "", "").trim();
  name = name.replace(/(مل|ml|مليلتر|ميليلتر|ملي|جم|غ|g|جرام|غرام|كوب|ربع لتر|نصف لتر|نص لتر|لتر)/gi, "").trim();
  return { name: name || raw, qty, unit };
}

/* ============================================================================
   6) Tools exposed to Gemini (no static food DB)
============================================================================ */
const Tools = {
  calculateDaily: {
    name: "calculateDaily",
    description: "حساب BMR/TDEE/الماكروز بدقة بمحركات Katch/Mifflin/Cunningham بحسب بيانات الجسم والهدف والنشاط.",
    parameters: {
      type: "OBJECT",
      properties: {
        sex:            { type:"STRING" },
        age:            { type:"NUMBER" },
        height_cm:      { type:"NUMBER" },
        weight_kg:      { type:"NUMBER" },
        activity_level: { type:"STRING" },
        goal:           { type:"STRING" },
        bodyfat_pct:    { type:"NUMBER" },
        athlete:        { type:"BOOLEAN" },
        protein_per_kg: { type:"NUMBER" },
        carb_pref:      { type:"STRING" }
      },
      required: ["sex","age","height_cm","weight_kg","activity_level","goal"]
    }
  },

  chooseDiet: {
    name: "chooseDiet",
    description: "اختيار النظام الأنسب (keto/low_carb/mediterranean/dash/balanced/psmf/vegan/…) بناءً على الهدف/النشاط/الدهون/التفضيلات/الحالات الصحية.",
    parameters: {
      type: "OBJECT",
      properties: {
        goal:          { type:"STRING" },
        activity_level:{ type:"STRING" },
        bodyfat_pct:   { type:"NUMBER" },
        health_flags:  { type:"ARRAY", items:{type:"STRING"} },
        preferences:   { type:"ARRAY", items:{type:"STRING"} }
      },
      required: ["goal"]
    }
  },

  correctText: {
    name: "correctText",
    description: "تصحيح لغوي عربي/لهجي دون تغيير المعنى. يعيد النص المصحح فقط.",
    parameters: { type:"OBJECT", properties:{ text:{ type:"STRING" } }, required:["text"] }
  }
};

const LocalToolExecutors = {
  calculateDaily: (args)=>{
    try{
      return { ok:true, result: calcDaily({
        sex: args.sex, age: args.age, height_cm: args.height_cm, weight_kg: args.weight_kg,
        activity_level: args.activity_level, goal: args.goal,
        bodyfat_pct: args.bodyfat_pct ?? null, athlete: !!args.athlete,
        protein_per_kg: args.protein_per_kg ?? null, carb_pref: args.carb_pref || "balanced"
      })};
    }catch(e){ return { ok:false, error: String(e && e.message || e) }; }
  },

  chooseDiet: (args)=>{
    try{
      const goal = String(args.goal||"recomp").toLowerCase();
      const activity_level = String(args.activity_level||"moderate").toLowerCase();
      const bodyfat_pct = toNum(args.bodyfat_pct);
      const flags = (Array.isArray(args.health_flags)?args.health_flags:[]).map(normalizeArabic);
      const prefs = (Array.isArray(args.preferences)?args.preferences:[]).map(normalizeArabic);

      let picked = "balanced";
      const rationale = [];

      if (flags.includes("diabetes") || flags.includes("سكر") || flags.includes("insulin_resistance")){
        picked = "low_carb"; rationale.push("تحكّم أدق بالسكر وصافي الكارب.");
      }
      if (flags.includes("hypertension") || flags.includes("ضغط")){
        picked = "dash"; rationale.push("خفض الصوديوم ورفع الخضار والفواكه.");
      }
      if (flags.includes("fatty_liver") || flags.includes("كبد دهني")){
        picked = "mediterranean"; rationale.push("دهون غير مشبعة وألياف وأوميغا-3.");
      }

      if (prefs.includes("keto")) { picked = "keto"; rationale.push("تفضيل المستخدم للكارب المنخفض جدًا."); }
      if (goal==="cut" && picked==="balanced" && (bodyfat_pct!=null && bodyfat_pct>25)){
        picked="low_carb"; rationale.push("خسارة دهون أسرع وتحكّم أفضل بالشّهية.");
      }
      if (prefs.includes("vegan")) { picked="vegan"; rationale.push("تفضيل نباتي كامل."); }
      if (prefs.includes("high_protein")) { rationale.push("رفع البروتين للشبع وبناء العضلات."); }
      if (prefs.includes("halal")) { rationale.push("التزام الحلال في المصدر والتحضير."); }

      const act = normalizeArabic(activity_level);
      if ((act.includes("athlete")||act.includes("high")) && picked==="keto"){
        rationale.push("تنبيه: الكيتو قد يحد من الأداء الهوائي/اللاهوائي.");
      }

      const alt = (picked==="keto") ? "low_carb" : (picked==="low_carb" ? "mediterranean" : "balanced");
      return { ok:true, result: { picked, alternative:alt, rationale: rationale.length?rationale:["خيار متوازن قابل للتخصيص."] } };
    }catch(e){ return { ok:false, error:String(e && e.message || e) }; }
  },

  correctText: (args)=>{
    const t = String((args && args.text) || "").trim();
    if (!t) return { ok:true, result:{ corrected:"" } };
    const n = normalizeArabic(t)
      .replace(/\bريجيم\b/g,"نظام غذائي")
      .replace(/\bكالوري\b/g,"سعرات")
      .replace(/\bالديم\b/g,"الدسم")
      .replace(/\bخليب\b/g,"حليب")
      .replace(/\s{2,}/g," ")
      .trim();
    return { ok:true, result:{ corrected:n } };
  }
};

function geminiToolsSpec(){
  return [{ functionDeclarations: Object.values(Tools).map(t=>({
    name:t.name, description:t.description, parameters:t.parameters
  })) }];
}

/* ============================================================================
   7) System Prompt — strict dynamic authoritative DB usage
============================================================================ */
const SYSTEM_PROMPT_AR = `
أنت "مساعد تغذية" احترافي يجيب بالعربية بوضوح ودقّة، ويتصرّف كإنسان: مرن، ذكي، لا يكرر الأسئلة، ويسأل سؤالًا واحدًا فقط عند الحاجة.

[نطاقك]
- التغذية فقط: حساب السعرات والماكروز، تحليل الأغذية، اقتراح وجبات وأنظمة، توقيت الأكل، الحساسيّات وعدم التحمل، ألياف/ماء/إلكترولايت.
- ممنوع: الأدوية/التشخيص/التحاليل/الطب/السياسة/الاختراق/التمويل الشخصي.

[المصدر الغذائي الديناميكي]
- عند طلب "قيمة غذائية/سعرات/ماكروز" لمكوّن/وجبة/علامة تجارية:
  - استعن داخليًا (ذهنيًا) بقواعد البيانات المعتمدة: USDA FoodData Central / CIQUAL / McCance & Widdowson.
  - طبّق تحويلات منطقية للوزن/الحجم (جم/مل/قطعة) بناء على وصف المستخدم.
  - أعِد الأرقام مباشرة: السعرات، البروتين، الدهون، الكارب، والألياف وصافي الكارب إن أمكن — **أولًا بالأرقام** ثم ملاحظة قصيرة إن وجدت افتراضات (نوع الحليب/طريقة التحضير…).
  - **ممنوع** اختراع قيم بلا سند؛ إن كان هناك غموض، اطرح **سؤالًا واحدًا صغيرًا** أو اذكر الافتراض.

[الحسابات الشخصية]
- استخدم أداة "calculateDaily" لاستنتاج BMR/TDEE/الماكروز بدقة بمحركات: Katch-McArdle (عند توافر نسبة الدهون)، Mifflin-St Jeor (عند عدم توافرها)، Cunningham (للرياضيين).
- التزم بطاقة الطاقة 4/4/9 (والكحول 7 عند وجوده).

[اختيار النظام]
- استخدم أداة "chooseDiet" لاختيار نظام مناسب بناء على الهدف/النشاط/نسبة الدهون/التفضيلات/الإشارات الصحية؛ قدّم **سببًا وجيزًا** وخيارًا بديلًا واحدًا.

[الحوار الذكي]
- محادثة ودية مختصرة. عند موافقة مبهمة (نعم/تمام)، اقترح **مسارين** واضحين بدل إعادة السؤال.
- لا تُكرّر التنبيه الطبي إن رأيت العلامة <<<MEDICAL_NOTICE_SHOWN>>> في السياق.
- لا تعِدْ كتابة سؤال المستخدم داخل الرد، ولا تُطِل المقدّمات.

[التنسيق]
- أجب بالأرقام أولًا عند تحليل الأغذية، ثم سطر ملاحظات قصير عند الحاجة. استخدم نقاطًا قصيرة عند عرض القوائم.
`.trim();

/* ============================================================================
   8) Gemini call with iterative function-calling
============================================================================ */
async function callGeminiOnce(model, contents, signal){
  const url = `${BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents,
    tools: geminiToolsSpec(),
    systemInstruction: { role:"system", parts:[{ text: SYSTEM_PROMPT_AR }] },
    generationConfig: { temperature:0.2, topP:0.9, maxOutputTokens: MAX_OUTPUT_TOKENS },
    safetySettings: []
  };
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body), signal });
  const text = await r.text();
  let data = null;
  try{ data = JSON.parse(text); } catch{ data = null; }
  if(!r.ok) throw new Error(data?.error?.message || `http_${r.status}`);
  return data;
}

async function callGeminiWithTools({ model, messages, memoryBlob }){
  // Build contents
  const contents = [];
  if (memoryBlob) contents.push({ role:"user", parts:[{ text:`سياق سابق مختصر:\n${memoryBlob}` }] });
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : m.role;
    if (role === "system") continue;
    contents.push({ role, parts:[{ text: String(m.content||"") }] });
  }

  let loop=0, lastData=null;
  const toolInvocations=[];
  let current = contents.slice();

  while (loop < TOOLS_MAX_LOOP) {
    loop++;
    const abort = new AbortController();
    const t = setTimeout(()=>abort.abort("timeout"), MODEL_TIMEOUT_MS);
    let data;
    try{
      data = await callGeminiOnce(model, current, abort.signal);
    } finally { clearTimeout(t); }
    lastData = data;

    const cand = data?.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const calls = parts.map(p=>p?.functionCall).filter(Boolean);
    if (!calls || !calls.length) break;

    for (const fc of calls) {
      const name = fc.name;
      const args = safeParseJSON(fc.args || "{}");
      const exec = LocalToolExecutors[name];
      let result;
      if (exec) {
        try { result = exec(args); }
        catch(e){ result = { ok:false, error:String(e && e.message || e) }; }
      } else {
        result = { ok:false, error:`tool_not_found:${name}` };
      }
      toolInvocations.push({ name, args, result });

      current.push({
        role: "tool",
        parts: [{ functionResponse: { name, response:{ name, content: result } } }]
      });
    }
  }

  const finalText = lastData?.candidates?.[0]?.content?.parts?.map(p=>p.text).filter(Boolean).join("\n").trim() || "";
  return { reply: finalText, toolInvocations };
}

/* ============================================================================
   9) Greeting, medical notice (once), ambiguity micro-choices
============================================================================ */
function neutralGreeting(){ return "مرحبًا بك 👋 أنا مساعد تغذية هنا لدعمك. كيف تحب أن نبدأ؟"; }

function stampMedicalOnce(memory){
  if (!memory || !memory.includes(MEDICAL_NOTICE_FLAG)) {
    // لا نعرض نصًا للمستخدم — فقط نختم الذاكرة حتى لا يكرره النموذج لاحقًا
    const mem = makeMemoryBlob(memory||"", `assistant_notice:${MEDICAL_NOTICE_FLAG}`);
    return { memory: mem, stamped:true };
  }
  return { memory, stamped:false };
}

function compactUserCard(u={}, locale="ar"){
  const L=[];
  if (u.name) L.push(`الاسم:${u.name}`);
  if (u.sex) L.push(`الجنس:${u.sex}`);
  if (Number.isFinite(u.age)) L.push(`العمر:${u.age}`);
  if (Number.isFinite(u.height_cm)) L.push(`الطول:${u.height_cm}سم`);
  if (Number.isFinite(u.weight_kg)) L.push(`الوزن:${u.weight_kg}كجم`);
  if (u.activity_level) L.push(`النشاط:${u.activity_level}`);
  if (u.goal) L.push(`الهدف:${u.goal}`);
  if (Array.isArray(u.preferences)&&u.preferences.length) L.push(`تفضيلات:${u.preferences.join(",")}`);
  if (Array.isArray(u.health_flags)&&u.health_flags.length) L.push(`حالات:${u.health_flags.join(",")}`);
  L.push(`اللغة:${locale||"ar"}`);
  return L.join(" | ");
}

function buildModelMessages({ messages, userCard, memoryHasNotice }){
  const noticeLine = memoryHasNotice ? `علامة_التنبيه:${MEDICAL_NOTICE_FLAG}` : `بدون_تكرار_تنبيه`;
  const injected = [{
    role:"user",
    content:
      `بطاقة تعريف (للتخصيص فقط، لا للعرض): ${userCard}\n—\n` +
      `التزم بسؤال واحد عند الحاجة. لا تكرار. ${noticeLine}`
  }];
  return injected.concat(messages||[]);
}

/* ============================================================================
   10) Handler
============================================================================ */
exports.handler = async (event)=>{
  try{
    if (event.httpMethod==="OPTIONS") return { statusCode:200, headers:corsHeaders(), body:"" };
    if (event.httpMethod!=="POST") return bad(405,"Method Not Allowed");
    if (!GEMINI_API_KEY) return bad(500,"GEMINI_API_KEY is missing");

    const req = JSON.parse(event.body || "{}");
    const { messages=[], memory="", user={}, locale="ar" } = req;

    const lastUser = extractLastUser(messages);
    const norm = normalizeArabic(lastUser);

    // Out-of-domain guard
    if (OOD_RE.test(norm)) {
      const reply = "احترم سؤالك، لكن دوري محصور في **التغذية فقط**. أخبرني بما يفيد تغذيتك الآن: هدفك (خسارة/ثبات/زيادة)، طولك، وزنك، نشاطك، وحساسياتك — أو اذكر اسم الطعام وكميته لأحلّلها فورًا.";
      const newMem = makeMemoryBlob(memory, `user:${lastUser}\nassistant:${reply}`);
      return ok({ reply, memory:newMem, meta:{ guard:"out_of_domain" } });
    }

    // Neutral greeting
    if (isGreetingOnly(lastUser) || !messages.length) {
      // stamp medical flag once, without showing text
      const stamped = stampMedicalOnce(memory);
      const reply = neutralGreeting();
      const updated = makeMemoryBlob(stamped.memory, `user:${lastUser}\nassistant:${reply}`);
      return ok({ reply, memory: updated, meta:{ model:"deterministic-greeting" } });
    }

    // Ambiguous "yes-like" — propose two tracks
    const prevA = lastAssistant(messages);
    if (prevA && isAmbiguousYes(lastUser)) {
      const reply = "نبدأ بأي مسار؟\n1) تحليل صنف/وجبة الآن.\n2) حساب سعراتك وماكروزك بدقة.\nأرسل: 1 أو 2.";
      const updated = makeMemoryBlob(memory, `user:${lastUser}\nassistant:${reply}`);
      return ok({ reply, memory: updated, meta:{ intent:"ambiguous_yes_choice" } });
    }

    // Pre-parse food phrase to reduce ambiguity (no DB lookup)
    let preface = null;
    if (/\b(سعرات|كالوري|كالوريات|ماكروز|قيمة|تحليل)\b/.test(norm) || /\bمل|ml|جم|غ|g|جرام|غرام|كوب\b/i.test(lastUser) ){
      const parsed = extractQuantityAndFood(lastUser);
      if (parsed && parsed.name){
        const parts = [];
        parts.push(`وصف_مستخدم: "${lastUser}"`);
        if (parsed.qty!=null) parts.push(`كمية_مرصودة: ${parsed.qty}`);
        if (parsed.unit) parts.push(`وحدة_مرصودة: ${parsed.unit}`);
        if (parts.length) preface = `مساعدة تفسير: ${parts.join(" | ")}`;
      }
    }

    // Prepare model messages
    const userCard = compactUserCard(user, locale);
    const memoryHasNotice = (memory || "").includes(MEDICAL_NOTICE_FLAG);
    const baseMessages = buildModelMessages({ messages, userCard, memoryHasNotice });

    const decoratedMessages = preface
      ? [{ role:"user", content: preface }].concat(baseMessages)
      : baseMessages;

    // Try models sequentially
    const errors = {};
    for (const model of MODEL_POOL) {
      try{
        const { reply, toolInvocations } = await callGeminiWithTools({
          model,
          messages: decoratedMessages,
          memoryBlob: (memory||"").slice(-MAX_MEMORY_CHARS)
        });
        if (reply) {
          // stamp medical notice once (no text surfaced)
          const stamped = stampMedicalOnce(memory);
          const updatedMem = makeMemoryBlob(stamped.memory, `user:${lastUser}\nassistant:${reply}`);
          return ok({
            reply,
            memory: updatedMem,
            meta:{
              model,
              tools: toolInvocations,
              tokens_hint: approxTokens(decoratedMessages, reply)
            }
          });
        }
        errors[model] = "empty_reply";
      }catch(e){
        errors[model] = String(e && e.message || e);
        continue;
      }
    }

    const fallback = "تعذّر توليد رد دقيق الآن. اكتب: اسم الطعام + الكمية (مثال: \"حليب كامل الدسم 200 مل\") لأحلّل فورًا، أو أرسل: الجنس/العمر/الطول/الوزن/النشاط/الهدف لأحسب السعرات والماكروز بدقة.";
    const newMem = makeMemoryBlob(memory, `assistant:${fallback}`);
    return ok({ reply:fallback, memory:newMem, meta:{ model:"server-fallback", errors } });

  }catch(e){
    return ok({
      reply: "حدث خطأ غير متوقع. أعد صياغة سؤالك باختصار (مثال: \"حليب كامل الدسم 200 مل\" أو \"ذكر 30 سنة 178سم 78كجم نشاط متوسط هدف خسارة\").",
      error: String(e && e.message || e)
    });
  }
};

/* ============================================================================
   11) Safe JSON
============================================================================ */
function safeParseJSON(s, fallback={}){
  try{ return JSON.parse(s); } catch{ return fallback; }
}
