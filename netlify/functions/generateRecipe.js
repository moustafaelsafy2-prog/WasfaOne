// Netlify Function: generateRecipe
// POST: { email, diet, servings, time, macros, ingredients }
// Requires headers: x-auth-token, x-session-nonce (must match users.json for email)
// Deterministic caching: data/history/{email_sanitized}.json -> { last, cache:{ [hash]: recipe } }

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const REF = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; // may be invalid/missing

const GH_API = "https://api.github.com";

function sanitizeEmail(email){ return (email||"").toLowerCase().replace(/[^a-z0-9]+/g,"_"); }

async function ghGetJson(path, allow404=false){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(allow404 && r.status===404) return { json:null, sha:null, notFound:true };
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  const decoded = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  return { json: decoded, sha: data.sha };
}
async function ghPutJson(path, obj, sha, message){
  const content = Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64');
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      "User-Agent":"WasfaOne",
      "Content-Type":"application/json"
    },
    body: JSON.stringify({ message, content, sha, branch: REF })
  });
  if(!r.ok) throw new Error(`GitHub PUT ${path} ${r.status}`);
  return r.json();
}

async function auth(event){
  const token = event.headers["x-auth-token"] || event.headers["X-Auth-Token"];
  const nonce = event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"];
  let email = null;
  try{ const body = JSON.parse(event.body||"{}"); email = body.email || null; }catch{}
  if(!token || !nonce || !email) return { ok:false, statusCode:401, error:"missing_auth" };

  const { json: users } = await ghGetJson("data/users.json");
  const user = (users||[]).find(u => (u.email||"").toLowerCase() === email.toLowerCase());
  if(!user) return { ok:false, statusCode:401, error:"no_user" };
  if(user.auth_token !== token || user.session_nonce !== nonce) return { ok:false, statusCode:401, error:"bad_token" };
  return { ok:true, email, user };
}

// Stable hash for caching (order-independent)
function stableHash(obj){
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 5381; for(let i=0;i<s.length;i++){ h=((h<<5)+h)+s.charCodeAt(i); h|=0; }
  return (h>>>0).toString(16);
}

// Schema validation (the UI expects this exact shape)
function validateRecipeSchema(rec){
  const baseKeys = ["title","servings","total_time_min","macros","ingredients","steps","lang"];
  if(typeof rec!=="object" || rec===null) return { ok:false, error:"not_object" };
  for(const k of baseKeys){ if(!(k in rec)) return { ok:false, error:`missing_${k}` }; }
  if(typeof rec.title!=="string") return { ok:false, error:"title_type" };
  if(typeof rec.servings!=="number") return { ok:false, error:"servings_type" };
  if(typeof rec.total_time_min!=="number") return { ok:false, error:"time_type" };
  if(!rec.macros || typeof rec.macros!=="object") return { ok:false, error:"macros_type" };
  for(const m of ["protein_g","carbs_g","fat_g","calories"]){ if(typeof rec.macros[m] !== "number") return { ok:false, error:`macro_${m}` }; }
  if(!Array.isArray(rec.ingredients) || rec.ingredients.some(x=>typeof x!=="string")) return { ok:false, error:"ingredients_type" };
  if(!Array.isArray(rec.steps) || rec.steps.some(x=>typeof x!=="string")) return { ok:false, error:"steps_type" };
  if(rec.lang!=="ar" && rec.lang!=="en") return { ok:false, error:"lang_invalid" };
  return { ok:true };
}

function buildPrompt(input){
  const { diet, servings, time, macros, ingredients } = input;
  return `أنت مساعد طاهٍ محترف. أعد وصفة طعام باللغة العربية فقط وبنية JSON STRICT دون أي شرح خارج JSON.
المتطلبات الحتمية:
- نفس البنية دائمًا بالمفاتيح: title, servings, total_time_min, macros:{protein_g,carbs_g,fat_g,calories}, ingredients[], steps[], lang
- القيَم أرقام صحيحة للحصص والوقت والماكروز والسعرات.
- lang="ar".
- التزم بالنظام الغذائي: ${diet}. عدد الحصص: ${servings}. الوقت الأقصى: ${time} دقيقة.
- إن وُجدت مكونات متاحة فاعتمد عليها: ${ingredients||"بدون"}.
- استهدف الماكروز: ${macros||"بدون"}.
أعِد JSON فقط بلا شروحات ولا Markdown.`;
}

async function callGeminiOnce(url, body){
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if(!r.ok) return { ok:false, code:r.status, text:null };
  const jr = await r.json();
  const text = (((jr.candidates||[])[0]||{}).content||{}).parts?.map(p=>p.text).join("") || "";
  return { ok:true, code:200, text };
}

async function callGemini(prompt){
  if(!GEMINI_API_KEY) return { ok:false, reason:"no_key" };

  const body = {
    contents: [{ role:"user", parts:[{ text: prompt }]}],
    generationConfig: { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 1024 },
    safetySettings: []
  };

  // Try primary (latest), then stable tag
  const primary = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const fallback = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  let res = await callGeminiOnce(primary, body);
  if(!res.ok && (res.code===404 || res.code===400 || res.code===403)) {
    res = await callGeminiOnce(fallback, body);
  }
  return res;
}

function tryParseJsonFromText(t){
  if(!t) return null;
  // remove fenced code if present
  let s = t.trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim();
  // quick bracket slice if extra text
  const first = s.indexOf("{"); const last = s.lastIndexOf("}");
  if(first !== -1 && last !== -1) s = s.slice(first, last+1);
  try{ return JSON.parse(s); }catch{ return null; }
}

function fallbackRecipe(input){
  const s = Number(input.servings)||1;
  const t = Number(input.time)||20;
  const baseIng = (input.ingredients? String(input.ingredients).split(/[،,]/).map(x=>x.trim()).filter(Boolean) : []);
  const ingredients = baseIng.length? baseIng : ["صدر دجاج","أرز أبيض","بروكلي","زيت زيتون","ملح","فلفل"];
  return {
    title: `وجبة ${input.diet||"متوازنة"} سريعة`,
    servings: s,
    total_time_min: t,
    macros: { protein_g: 30*s, carbs_g: 40*s, fat_g: 20*s, calories: 600*s },
    ingredients,
    steps: [
      "تبّل المكونات بالملح والفلفل.",
      "اطهِ البروتين حتى النضج.",
      "اسلق الأرز وقدّم مع الخضار.",
      "قسّم الوجبة إلى حصص متساوية."
    ],
    lang: "ar"
  };
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod === "OPTIONS") return { statusCode: 204 };
    if(event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ ok:false, error:"method_not_allowed" }) };
    if(!OWNER || !REPO || !GH_TOKEN) return { statusCode:500, body: JSON.stringify({ ok:false, error:"config_missing" }) };

    // Auth
    const a = await auth(event);
    if(!a.ok) return { statusCode: a.statusCode, body: JSON.stringify({ ok:false, error:a.error }) };

    // Input
    const body = JSON.parse(event.body||"{}");
    const input = {
      email: a.email,
      diet: String(body.diet||"balanced"),
      servings: Number(body.servings||1),
      time: Number(body.time||20),
      macros: String(body.macros||""),
      ingredients: String(body.ingredients||"")
    };

    // Cache
    const cacheKey = stableHash({ d:input.diet, s:input.servings, t:input.time, m:input.macros, i:input.ingredients });
    const emailSan = sanitizeEmail(a.email);
    const histPath = `data/history/${emailSan}.json`;
    const { json: curHist, sha } = await ghGetJson(histPath, true);
    const history = curHist || { last:null, cache:{} };

    if(history.cache && history.cache[cacheKey]){
      const rec = history.cache[cacheKey];
      return { statusCode:200, body: JSON.stringify({ ok:true, cached:true, recipe: rec }) };
    }

    // Generate via Gemini with robust fallback
    let recipe = null;
    let usedAI = false;

    const prompt = buildPrompt(input);
    const aiRes = await callGemini(prompt);

    if(aiRes.ok){
      const parsed = tryParseJsonFromText(aiRes.text);
      if(parsed) { recipe = parsed; usedAI = true; }
    }

    if(!recipe){
      // Either no key or failed HTTP/parse -> deterministic fallback
      recipe = fallbackRecipe(input);
    }

    // Validate schema
    const v = validateRecipeSchema(recipe);
    if(!v.ok){
      // As a last resort ensure we still return something valid
      recipe = fallbackRecipe(input);
    }

    // Save
    history.cache = history.cache || {};
    history.cache[cacheKey] = recipe;
    history.last = recipe;
    await ghPutJson(histPath, history, sha || undefined, `generateRecipe:${a.email}:${cacheKey}${usedAI?":ai":"::fallback"}`);

    return { statusCode:200, body: JSON.stringify({ ok:true, cached:false, recipe }) };
  }catch(err){
    // Never bubble internal errors to UI; return a friendly message
    const msg = "تعذر توليد الوصفة حاليًا، يرجى المحاولة لاحقًا أو التواصل عبر 00971502061209.";
    return { statusCode: 200, body: JSON.stringify({ ok:true, cached:false, recipe: fallbackRecipe({ servings:1, time:20, diet:"متوازنة" }) , note: msg }) };
  }
};
