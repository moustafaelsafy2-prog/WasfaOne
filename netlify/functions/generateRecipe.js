// netlify/functions/generateRecipe.js
// WasfaOne — Netlify Function (FULL, NON-ABBREVIATED)
//
// ───────────────────────────────────────────────────────────────────────────────
// 📜 "توجيه رسمي للذكاء الاصطناعي: معايير ودليل تنفيذ دقيق لحساب السعرات والماكروز"
// (مضمّن كمرجع إلزامي وأساس توليد الوصفات — ويُحقن أيضًا داخل systemInstruction)
//
// 🎯 الهدف
// ضمان أن جميع حسابات السعرات الحرارية والماكروز دقيقة بنسبة ±2%، وقابلة للاعتماد
// في البروتوكولات العلاجية وخطط التغذية المتقدمة. لا يُسمح بأي تقريب أو تقدير غير علمي.
//
// 🧠 قواعد الدقة الأساسية (إلزامية):
// 1) الحساب بناءً على الوزن النيء الفعلي لكل مكون (بالجرام)، مع منع استعمال "ملعقة" أو "حبة"
//    أو "كوب" دون تحويل إلى جرامات دقيقة.
// 2) الوزن بالمليجرام/جرام بدقة ميزان (±0.1 جم). أي اختلاف في الوزن ينعكس مباشرة على السعرات والماكروز.
// 3) التمييز الدقيق لنوع المكوّن (زيت زيتون بكر ممتاز ≠ زيت زيتون عادي، طماطم طازجة ≠ مجففة، اللحم النيء ≠ المطبوخ).
// 4) المصادر المعتمدة فقط للقيم الغذائية (لا بيانات عامة أو تطبيقات غير علمية):
//    - USDA FoodData Central
//    - CIQUAL
//    - McCance and Widdowson
// 5) الحساب بالمعادلات القياسية: بروتين 4 kcal/g، كربوهيدرات 4 kcal/g، دهون 9 kcal/g.
// 6) تجميع النتائج بدقة: حساب السعرات لكل مكوّن ثم جمعها. لا تُستخدم القيم "المتوسطة" أو "التقديرية".
//
// ⚙️ خطوات التنفيذ المطلوبة:
// 1) تحليل كل مكوّن على حدة: تحديد الكمية بالجرام واستخراج P/C/F لكل مكوّن بدقة من قواعد البيانات المعتمدة.
// 2) حساب الطاقة لكل مكوّن: (Protein×4) + (Carbs×4) + (Fat×9).
// 3) تجميع النتائج النهائية (السعرات، البروتين، الكربوهيدرات، الدهون).
// 4) مراجعة الاتساق: رفض النتائج غير المنطقية، وطلب توضيح عند الشك في النوع/الوزن.
//
// 📏 تعليمات صارمة:
// - ❌ ممنوع القيم التقريبية أو بيانات التطبيقات العامة.
// - ✅ اعتماد القيم العلمية فقط.
// - ❌ ممنوع جمع السعرات مباشرة دون المرور بحساب الماكروز.
// - ✅ التأكد من منطقية النتائج واتساقها مع أوزان المكونات.
// - ✅ أي انحراف يتجاوز ±2% يُعد خطأ ويُصحّح.
//
// 📌 النتيجة المتوقعة:
// حسابات دقيقة للسعرات والماكروز يمكن اعتمادها في الخطط العلاجية والرياضية، قابلة للاستخدام
// في الأبحاث وبرامج التغذية المتقدمة.
//
// ───────────────────────────────────────────────────────────────────────────────
// ✅ هذا الملف يلتزم بخطة المشروع الأصلية (جلسة واحدة، GitHub Content API للتخزين/الكاش،
//   مخرجات حتمية، مخطط نهائي موحّد) ويجعل التوجيه أعلاه أساس توليد كل وصفة.
// ✅ المخرجات النهائية دائمًا وفق مخطط WasfaOne النهائي:
//   { title, time, servings, macros{calories,protein,carbs,fats}, ingredients[{name,quantity}], preparation[{title,instruction}] }
// ✅ التوليد يعتمد وسطيًا على JSON عربي داخلي (intermediate AR JSON) ثم يُحوَّل للمخطط النهائي
//   مع ضبط السعرات لتساوي 4P+4C+9F إن لزم (±2%).
// ✅ إدراج قواعد "د. محمد سعيد" (خفض كارب ≤ 5 جم/حصة + ممنوعات) بمحاولة إصلاح واحدة ثم تحذير ناعم.
//
// ───────────────────────────────────────────────────────────────────────────────

/* -------------------- ENV -------------------- */
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY || "";
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO_OWNER    = process.env.GITHUB_REPO_OWNER || "";
const GITHUB_REPO_NAME     = process.env.GITHUB_REPO_NAME || "";
const GITHUB_REF           = process.env.GITHUB_REF || "main";

/* -------------------- Constants -------------------- */
const BASE_GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";

// MODEL_POOL كما هو مطلوب (Pro أولاً ثم Flash)
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

// CORS
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-auth-token, x-session-nonce",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const jsonRes = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });
const bad = (code, error, extra = {}) => jsonRes(code, { ok: false, error, ...extra });
const ok  = (payload) => jsonRes(200, { ok: true, ...payload });

/* -------------------- GitHub Content API -------------------- */
const GH_BASE = "https://api.github.com";

async function ghGetContent(path) {
  const url = `${GH_BASE}/repos/${encodeURIComponent(GITHUB_REPO_OWNER)}/${encodeURIComponent(GITHUB_REPO_NAME)}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_REF)}`;
  const resp = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}`, "User-Agent": "WasfaOne" } });
  if (!resp.ok) throw new Error(`GH_GET_${resp.status}`);
  const data = await resp.json();
  const content = Buffer.from(data.content || "", data.encoding || "base64").toString("utf-8");
  return { sha: data.sha, json: JSON.parse(content) };
}

async function ghPutContent(path, message, obj, prevSha) {
  const url = `${GH_BASE}/repos/${encodeURIComponent(GITHUB_REPO_OWNER)}/${encodeURIComponent(GITHUB_REPO_NAME)}/contents/${encodeURIComponent(path)}`;
  const content = Buffer.from(JSON.stringify(obj, null, 2), "utf-8").toString("base64");
  const body = { message, content, branch: GITHUB_REF, ...(prevSha ? { sha: prevSha } : {}) };
  const resp = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, "User-Agent": "WasfaOne", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`GH_PUT_${resp.status}`);
  return await resp.json();
}

/* -------------------- Crypto / Hash -------------------- */
function stableStringify(o) {
  return JSON.stringify(o, Object.keys(o).sort());
}
async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* -------------------- Session/Auth (per project plan) -------------------- */
// كل طلب: يتطلب x-auth-token (email) + x-session-nonce المطابقين لما في data/users.json
async function assertSession(event) {
  const email = (event.headers["x-auth-token"] || event.headers["X-Auth-Token"] || "").trim().toLowerCase();
  const nonce = (event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"] || "").trim();
  if (!email || !nonce) throw new Error("missing_auth_headers");

  const { json: users } = await ghGetContent("data/users.json");
  const u = users.find(x => (x.email || "").toLowerCase() === email);
  if (!u) throw new Error("user_not_found");
  if (String(u.session_nonce || "") !== nonce) throw new Error("invalid_session_nonce");
  if (String(u.status || "") !== "active") throw new Error("user_not_active");

  const today = new Date().toISOString().slice(0,10);
  if (u.start_date && today < u.start_date) throw new Error("subscription_not_started");
  if (u.end_date && today > u.end_date) throw new Error("subscription_expired");

  return { email, user: u };
}

/* -------------------- History (Determinism & Memory) -------------------- */
async function readUserHistory(email) {
  const path = `data/history/${email.replace(/[^a-z0-9_\-\.@]/gi, "_")}.json`;
  try {
    const { sha, json } = await ghGetContent(path);
    return { sha, json, path };
  } catch (e) {
    return { sha: null, json: {}, path };
  }
}
async function writeUserHistory(path, prevSha, historyObj, email, hashKey) {
  const message = `history: cache recipe for ${email} @ ${hashKey}`;
  return ghPutContent(path, message, historyObj, prevSha || undefined);
}

/* -------------------- FINAL SCHEMA (WasfaOne) -------------------- */
// يجب أن يكون الناتج النهائي وفق هذا المخطط:
function validateFinalSchema(obj, lang) {
  const must = ["title","time","servings","macros","ingredients","preparation"];
  for (const k of must) if (!(k in obj)) return { ok:false, error:`missing_${k}` };
  if (typeof obj.title !== "string" || !obj.title.trim()) return { ok:false, error:"title_type" };
  if (typeof obj.time !== "string" || !obj.time.trim()) return { ok:false, error:"time_type" };
  if (!Number.isFinite(obj.servings)) return { ok:false, error:"servings_type" };

  const m = obj.macros;
  if (!m || typeof m !== "object") return { ok:false, error:"macros_type" };
  for (const k of ["calories","protein","carbs","fats"]) {
    if (!Number.isFinite(m[k])) return { ok:false, error:`macro_${k}_type` };
  }

  if (!Array.isArray(obj.ingredients) || obj.ingredients.some(x => typeof x !== "object" || typeof x.name !== "string" || typeof x.quantity !== "string")) {
    return { ok:false, error:"ingredients_type" };
  }
  if (!Array.isArray(obj.preparation) || obj.preparation.some(x => typeof x !== "object" || typeof x.title !== "string" || typeof x.instruction !== "string")) {
    return { ok:false, error:"preparation_type" };
  }
  return { ok:true };
}

/* -------------------- Dr. Mohamed Rules -------------------- */
const DR_MOH = /محمد\s*سعيد/;
function violatesDrMoh_intermediate(arJson) {
  const carbs = Number(arJson?.macros?.carbs_g || 0);
  const ing = (arJson?.ingredients || []).join(" ").toLowerCase();
  const banned = [
    "سكر","sugar","عسل","honey","دبس","شراب","سيرب","glucose","fructose","corn syrup","hfcs",
    "لانشون","نقانق","سلامي","بسطرمة","مرتديلا","مصنع","معلبات","مرق","مكعبات",
    "msg","جلوتامات","glutamate","نتريت","نترات","ملون","نكهات صناعية","مواد حافظة","مستحلب",
    "مهدرج","مارجرين","زيت كانولا","زيت ذرة","زيت صويا","بذر العنب","vegetable oil",
    "دقيق أبيض","طحين أبيض","نشا الذرة","cornstarch","خبز","مكرونة","رز أبيض","سكر بني"
  ];
  const hasBanned = banned.some(k => ing.includes(k));
  const carbsOk = carbs <= 5;
  return (!carbsOk || hasBanned);
}

/* -------------------- INTERMEDIATE (AR) SCHEMA & PROMPTS -------------------- */
// وسيط عربي يُنتج من Gemini كـ JSON فقط:
function sysDirectiveText(maxSteps = 6) {
  // يتضمن "التوجيه الرسمي" + المصادر + إلزام القياس بالجرام + منع التقدير + معادلات الطاقة + ±2%
  return `
أنت خبير تغذية وشيف محترف. التزم حرفيًا بالتالي — JSON فقط ولا تضف أي نص خارجه:

[المعيار المرجعي للحساب الدقيق — أساس التوليد]
- الحساب يعتمد على الوزن النيء بالجرام لكل مكون (تحويل أي وحدات مثل ملعقة/كوب إلى جرام).
- دقة الوزن: ميزان رقمي (±0.1 جم).
- التمييز الدقيق لنوع المكوّن (مثل زيت زيتون بكر ممتاز ≠ عادي).
- استخدم حصريًا قواعد البيانات العلمية التالية لاشتقاق القيم الغذائية (Protein/Carbs/Fat لكل 100جم ثم طبق الوزن الفعلي):
  • USDA FoodData Central
  • CIQUAL
  • McCance and Widdowson
- معادلات الطاقة: بروتين 4، كربوهيدرات 4، دهون 9 (kcal لكل جرام).
- احسب طاقة كل مكوّن ثم اجمع للحصول على المجاميع النهائية.
- تأكد أن "calories" ضمن ±2% من (4P + 4C + 9F). عند الانحراف، عدّل "calories" لتطابق المعادلة.

[المخطط المطلوب كإخراج وسيط عربي، JSON فقط]
{
  "title": string,
  "servings": number,
  "total_time_min": number,
  "macros": { "protein_g": number, "carbs_g": number, "fat_g": number, "calories": number },
  "ingredients": string[],   // عناصر مثل: "200 جم صدر دجاج نيء"
  "steps": string[],         // بحد أقصى ${maxSteps} خطوات قصيرة ومباشرة
  "lang": "ar"
}
- لا وحدات نصية داخل أرقام الماكروز.
- ingredients بالجرام النيء لكل مكون.
- steps تعليمات مختصرة عملية.
- اللغة العربية فقط.
`.trim();
}

function userPrompt(input) {
  const {
    mealType = "وجبة",
    cuisine = "متنوع",
    dietType = "متوازن",
    caloriesTarget = 500,
    allergies = [],
    focus = "",
    __repair = false
  } = input || {};

  const avoid = (Array.isArray(allergies) && allergies.length) ? allergies.join(", ") : "لا شيء";
  const focusLine = focus ? `تركيز خاص: ${focus}.` : "";
  const isDrMoh = /محمد\\s*سعيد/.test(String(dietType));

  const drRules = isDrMoh ? `
قواعد صارمة لنظام د. محمد سعيد:
- الكربوهيدرات الصافية لكل حصة ≤ 5 جم.
- ممنوع السكريات والمُحلّيات (سكر أبيض/بني، عسل، شراب الذرة/الجلوكوز/الفركتوز، المحليات الصناعية).
- ممنوع المصنّعات: لانشون/نقانق/سلامي/بسطرمة، المرق البودرة/المكعبات، الصلصات التجارية إن لم تكن منزلية.
- ممنوع الإضافات المسببة للالتهاب: MSG/جلوتامات، نيتريت/نترات، ألوان/نكهات صناعية، مستحلبات.
- ممنوع الزيوت النباتية المكررة/المهدرجة (كانولا/صويا/ذرة/بذر العنب). يُسمح بزيت زيتون بكر وزبدة/سمن طبيعي وأفوكادو ومكسرات نيئة.
`.trim() : "";

  const repairLine = __repair && isDrMoh
    ? "الإخراج السابق خالف القيود. أعد توليد وصفة تلتزم حرفيًا بالبنود أعلاه، مع ضبط المقادير لضمان ≤ 5 جم كربوهيدرات/حصة."
    : "";

  return `
أنشئ وصفة ${mealType} من مطبخ ${cuisine} لنظام ${dietType}.
السعرات المستهدفة للحصة: ${Number(caloriesTarget)}.
حساسيات يجب تجنبها: ${avoid}.
${focusLine}
${drRules}
${repairLine}
أعد النتيجة كـ JSON فقط حسب المخطط الوسيط المذكور وبالعربية.
`.trim();
}

function extractJsonFromCandidates(jr) {
  const text =
    jr?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("") ||
    jr?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) return null;

  let s = String(text).trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const first = s.indexOf("{");
  const last  = s.lastIndexOf("}");
  if (first === -1 || last === -1) return null;

  try { return JSON.parse(s.slice(first, last + 1)); }
  catch { return null; }
}

async function callOnce(model, input, timeoutMs = 28000) {
  const url = `${BASE_GEMINI}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    // حتمية الإخراج حسب الخطة: temperature:0, topP:1, topK:1, maxOutputTokens:1024
    systemInstruction: { role: "system", parts: [{ text: sysDirectiveText(6) }] },
    contents: [{ role: "user", parts: [{ text: userPrompt(input) }] }],
    generationConfig: { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 1024 },
    safetySettings: []
  };

  const abort = new AbortController();
  const t = setTimeout(() => abort.abort(), Math.max(1000, Math.min(29000, timeoutMs)));

  let resp, data;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal
    });
    const text = await resp.text();
    try { data = JSON.parse(text); } catch { data = null; }

    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP_${resp.status}`;
      return { ok:false, error: msg };
    }

    let json = data && typeof data === "object" && data.title ? data : extractJsonFromCandidates(data);
    if (!json) return { ok:false, error:"gemini_returned_non_json" };

    // تطبيع: تأمين اللغة + تقصير الخطوات إلى 6 كحد أقصى (دمج لطيف)
    if (!json.lang) json.lang = "ar";
    if (Array.isArray(json.steps) && json.steps.length > 6) {
      const chunk = Math.ceil(json.steps.length / 6);
      const merged = [];
      for (let i=0;i<json.steps.length;i+=chunk) merged.push(json.steps.slice(i,i+chunk).join(" ثم "));
      json.steps = merged.slice(0,6);
    }

    // لا نُجري هنا فحص المخطط الوسيط بدقّة — نكمل ونحوّل ونفحص النهائي.
    return { ok:true, recipe: json };
  } catch (e) {
    return { ok:false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* -------------------- Calorie Consistency (±2%) -------------------- */
function energyFromMacros(p, c, f) {
  // kcal = 4*P + 4*C + 9*F
  return (p * 4) + (c * 4) + (f * 9);
}
function within2Percent(a, b) {
  if (b === 0) return a === 0;
  const diff = Math.abs(a - b);
  return (diff / b) <= 0.02;
}

/* -------------------- Transform to Final Schema -------------------- */
// تحويل الإخراج الوسيط العربي إلى المخطط النهائي WasfaOne (AR/EN)
function toFinalSchemaFromArabicIntermediate(arJson, lang) {
  // arJson: {title, servings, total_time_min, macros{protein_g,carbs_g,fat_g,calories}, ingredients:string[], steps:string[]}
  const servings = Number(arJson.servings || 1);
  const timeMin  = Number(arJson.total_time_min || 15);

  // مكونات: "200 جم صدر دجاج نيء" → {quantity, name}
  const ingredients = (Array.isArray(arJson.ingredients) ? arJson.ingredients : []).map(line => {
    const s = String(line || "").trim();
    // محاولة فصل أول جزء كـ quantity والباقي اسم
    const m = s.match(/^(.{0,40}?\d[\d\.\,]*\s*[^\s]+)\s+(.+)$/);
    if (m) return { quantity: m[1].trim(), name: m[2].trim() };
    return { name: s, quantity: "" };
  });

  // خطوات → preparation معنونة
  const preparation = (Array.isArray(arJson.steps) ? arJson.steps : []).map((t, i) => ({
    title: lang === "en" ? `Step ${i+1}` : `الخطوة ${i+1}`,
    instruction: String(t || "").trim()
  }));

  // إعادة تسمية الماكروز + ضبط السعرات بدقة
  const P = Number(arJson?.macros?.protein_g || 0);
  const C = Number(arJson?.macros?.carbs_g || 0);
  const F = Number(arJson?.macros?.fat_g || 0);
  let K = Number(arJson?.macros?.calories || 0);
  const computed = energyFromMacros(P, C, F);

  // اتساق ±2%: إن لم تكن calories ضمن ±2% من المعادلة، نعدّلها لتساوي المعادلة
  if (!within2Percent(K, computed)) {
    K = Math.round(computed * 100) / 100; // دقة منزلتيْن عشريتيْن
  }

  const finalObj = {
    title: String(arJson.title || (lang === "en" ? "Recipe" : "وصفة")).trim(),
    time: lang === "en" ? `${timeMin} min` : `${timeMin} دقيقة`,
    servings: servings,
    macros: {
      calories: Number(K),
      protein: Number(P),
      carbs: Number(C),
      fats: Number(F)
    },
    ingredients,
    preparation
  };

  return finalObj;
}

/* -------------------- Handler -------------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonRes(204, {});
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  // مفاتيح البيئة
  if (!GEMINI_API_KEY) return bad(500, "GEMINI_API_KEY is missing on the server");
  if (!GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
    return bad(500, "GitHub environment is missing on the server");
  }

  // تحقق الجلسة حسب الخطة
  let email, user;
  try {
    const s = await assertSession(event);
    email = s.email; user = s.user;
  } catch (e) {
    return bad(401, String(e.message || e));
  }

  // مدخلات الطلب (من الواجهة)
  let input = {};
  try { input = JSON.parse(event.body || "{}"); }
  catch { return bad(400, "invalid_json_body"); }

  // اللغة المطلوبة في الواجهة
  const lang = (input.lang === "en" ? "en" : "ar");

  // حتمية النتائج: هاش للمدخلات (يشمل lang)
  const hashKey = await sha256Hex(stableStringify({ lang, ...input }));
  const history = await readUserHistory(email);
  if (history.json && history.json[hashKey] && history.json[hashKey].final) {
    return ok({ recipe: history.json[hashKey].final, model: history.json[hashKey].model, cached: true });
  }

  // قواعد د. محمد سعيد (إصلاح مرة واحدة ثم تحذير)
  const wantDrMoh = DR_MOH.test(String(input?.dietType || ""));
  const errors = {};

  for (const model of MODEL_POOL) {
    // المحاولة الأولى (وسيط عربي)
    const r1 = await callOnce(model, input);
    if (!r1.ok) { errors[model] = r1.error; continue; }

    let arMid = r1.recipe;

    // فحص قواعد د. محمد
    if (wantDrMoh && violatesDrMoh_intermediate(arMid)) {
      // إصلاح مرة واحدة
      const r2 = await callOnce(model, { ...input, __repair: true });
      if (r2.ok && !violatesDrMoh_intermediate(r2.recipe)) {
        arMid = r2.recipe;
        const finalRecipe = toFinalSchemaFromArabicIntermediate(arMid, lang);
        const vFinal = validateFinalSchema(finalRecipe, lang);
        if (!vFinal.ok) {
          const msg = lang === "ar"
            ? `تعذر التحقق من مخطط الوصفة: ${vFinal.error}`
            : `Recipe schema validation failed: ${vFinal.error}`;
          return bad(422, msg);
        }
        const newHist = { ...(history.json || {}) };
        newHist[hashKey] = { final: finalRecipe, model, note: "repaired_to_meet_dr_moh_rules" };
        await writeUserHistory(history.path, history.sha, newHist, email, hashKey);
        return ok({ recipe: finalRecipe, model, note: "repaired_to_meet_dr_moh_rules" });
      }

      // قبول مع تحذير ناعم
      const fallback = (r2.ok ? r2.recipe : r1.recipe);
      const finalWarn = toFinalSchemaFromArabicIntermediate(fallback, lang);
      const vWarn = validateFinalSchema(finalWarn, lang);
      if (!vWarn.ok) {
        const msg = lang === "ar"
          ? `تعذر التحقق من مخطط الوصفة: ${vWarn.error}`
          : `Recipe schema validation failed: ${vWarn.error}`;
        return bad(422, msg);
      }
      const newHist = { ...(history.json || {}) };
      newHist[hashKey] = { final: finalWarn, model, warning: "dr_moh_rules_not_strictly_met" };
      await writeUserHistory(history.path, history.sha, newHist, email, hashKey);
      return ok({ recipe: finalWarn, model, warning: "dr_moh_rules_not_strictly_met" });
    }

    // التحويل للمخطط النهائي ثم التحقق والحفظ
    const finalRecipe = toFinalSchemaFromArabicIntermediate(arMid, lang);
    const vFinal = validateFinalSchema(finalRecipe, lang);
    if (!vFinal.ok) {
      const msg = lang === "ar"
        ? `تعذر التحقق من مخطط الوصفة: ${vFinal.error}`
        : `Recipe schema validation failed: ${vFinal.error}`;
      return bad(422, msg);
    }

    const newHist = { ...(history.json || {}) };
    newHist[hashKey] = { final: finalRecipe, model };
    await writeUserHistory(history.path, history.sha, newHist, email, hashKey);
    return ok({ recipe: finalRecipe, model });
  }

  // فشل الاتصال بجميع النماذج
  const fallbackMsg = lang === "ar"
    ? "تعذر توليد الوصفة حاليًا، يرجى المحاولة لاحقًا أو التواصل عبر 00971502061209."
    : "Unable to generate a recipe right now. Please try again later or contact us at 00971502061209.";
  return bad(502, fallbackMsg, { errors, tried: MODEL_POOL });
};
