// /netlify/functions/aiDietAssistant.js
// WhatsApp-like diet assistant (Arabic)
// - Deterministic generation (temperature: 0, topP: 1, topK: 1)
// - Auth headers required (x-auth-token, x-session-nonce)
// - Grounds on public/data/assistant_replies.json (GitHub-backed)

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_ASSISTANT_MODEL || "gemini-1.5-flash";

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = "https://api.github.com";

const REPLIES_PATH = "public/data/assistant_replies.json";
const USERS_PATH   = "data/users.json";

function ok(obj){ return new Response(JSON.stringify({ ok:true, ...obj }, null, 2), { status: 200, headers: { "Content-Type":"application/json" }}); }
function bad(status, msg, extra={}){ return new Response(JSON.stringify({ ok:false, error: msg, ...extra }, null, 2), { status, headers: { "Content-Type":"application/json" }}); }

async function ghGetJson(path){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content), sha: data.sha };
}

function todayDubaiISO(){
  // UTC+4 (no DST). We just need date boundary checks, not exact hours.
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const dubai = new Date(utc + (4 * 60 * 60000));
  const y = dubai.getFullYear();
  const m = String(dubai.getMonth()+1).padStart(2,"0");
  const d = String(dubai.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}

function joinMessages(messages){
  // Convert to WhatsApp-like transcript
  // We keep it deterministic; no tool calls
  return messages.map(m => {
    const role = m.role === "user" ? "👤" : "🤖";
    const t = String(m.content || "").trim().replace(/\s+/g, " ");
    return `${role} ${t}`;
  }).join("\n");
}

async function callGemini(prompt){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role:"user", parts:[{ text: prompt }]}],
    generationConfig: { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 256 }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error(`gemini_failed ${r.status}`);
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return text.trim();
}

export default async (req) => {
  try{
    if(req.method !== "POST") return bad(405, "method_not_allowed");
    // Auth headers (presence check only; we keep parity with other FNs style)
    const auth = req.headers.get("x-auth-token");
    const nonce = req.headers.get("x-session-nonce");
    if(!auth || !nonce) return bad(200, "unauthorized_missing_headers");

    // Optionally enforce subscription window by reading users.json (soft-check)
    try{
      const { json: users } = await ghGetJson(USERS_PATH);
      // If needed, you can validate 'auth' exists in users; kept minimal to avoid state divergence.
      void users;
    }catch(_){ /* tolerate read failure to avoid blocking */ }

    const input = await req.json().catch(()=> ({}));
    const messages = Array.isArray(input?.messages) ? input.messages : [];
    const lang = (input?.lang === "ar") ? "ar" : "ar";
    if(messages.length === 0) return bad(200, "empty_messages");

    const { json: replies } = await ghGetJson(REPLIES_PATH);

    const system = String(replies?.system_instructions_ar || "").trim();
    const canned  = Array.isArray(replies?.canned_blocks) ? replies.canned_blocks.join("\n\n") : "";
    const rules   = String(replies?.diet_mapping_rules_ar || "").trim();

    const transcript = joinMessages(messages);

    const prompt = [
      // System style
      "أنت مساعد غذائي عربي يشبه محادثة واتساب. التزم بالإيجاز والوضوح واللطف.",
      "أجب برسالة قصيرة من سطرين إلى أربعة فقط، بدون مقدّمات تقنية.",
      "لا تُخرج إيموجي عشوائي. استخدم لغة عربية واضحة ومحترفة وبسيطة.",
      "اطلب معلوماتك خطوة بخطوة (الهدف، العمر، الطول، الوزن، النشاط، تفضيلات/حساسيات).",
      "اقترح في النهاية نظامًا غذائيًا واحدًا من القائمة فقط إن اكتملت البيانات.",
      "إن لم تكتمل البيانات، اسأل سؤالًا واحدًا محددًا فقط.",
      "الرد يكون بالعربية فقط.",
      "",
      // From repository file (grounding)
      `تعليمات الأسلوب:\n${system}`,
      "",
      `مقاطع جاهزة للاقتباس:\n${canned}`,
      "",
      `قواعد ربط الإجابات بأنظمة الغذاء:\n${rules}`,
      "",
      "نص المحادثة حتى الآن (واتساب):",
      transcript,
      "",
      "الآن أعطِ رسالة المساعد التالية فقط."
    ].join("\n");

    const reply = await callGemini(prompt);
    return ok({ reply, model: MODEL, date: todayDubaiISO() });
  }catch(e){
    return bad(200, String(e && e.message || e));
  }
};
