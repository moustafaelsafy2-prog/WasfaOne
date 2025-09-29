const OWNER   = process.env.GITHUB_REPO_OWNER;
const REPO    = process.env.GITHUB_REPO_NAME;
const REF     = process.env.GITHUB_REF || "main";
const GH_TOKEN= process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GH_API  = "https://api.github.com";
const { createHash, randomUUID, webcrypto } = require("crypto");

function sanitizeEmail(email){ return (email||"").toLowerCase().replace(/[^a-z0-9]+/g,"_"); }

async function ghGetJson(path, allow404=false){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(allow404 && r.status===404) return { json:null, sha:null, notFound:true };
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

async function auth(headers, email){
  const token = headers["x-auth-token"] || headers["X-Auth-Token"];
  const nonce = headers["x-session-nonce"] || headers["X-Session-Nonce"];
  if(!token || !nonce) return false;
  const { json: users } = await ghGetJson("data/users.json");
  const user = (users||[]).find(u => (u.email||"").toLowerCase() === (email||"").toLowerCase());
  if(!user) return false;
  return user.auth_token === token && user.session_nonce === nonce;
}

async function sha256Hex(text){
  const buf = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

function validateSchema(obj){
  if(!obj || typeof obj !== "object") return false;
  const must = ["title","time","servings","macros","ingredients","preparation"];
  for(const k of must){ if(!(k in obj)) return false; }
  if(typeof obj.title !== "string") return false;
  if(typeof obj.time !== "number") return false;
  if(typeof obj.servings !== "number") return false;
  const m = obj.macros || {};
  if(["calories","protein","carbs","fats"].some(k => typeof m[k] !== "number")) return false;
  if(!Array.isArray(obj.ingredients)) return false;
  if(!obj.ingredients.every(x => typeof x.name==="string" && typeof x.quantity==="string")) return false;
  if(!Array.isArray(obj.preparation)) return false;
  if(!obj.preparation.every(s => typeof s.title==="string" && typeof s.instruction==="string")) return false;
  return true;
}

function promptFor(lang, payload){
  const { diet, servings, time, macros, ingredients } = payload;
  const schema = `Return ONLY JSON with keys:
{
  "title": string,
  "time": number,
  "servings": number,
  "macros": { "calories": number, "protein": number, "carbs": number, "fats": number },
  "ingredients": [ { "name": string, "quantity": string } ],
  "preparation": [ { "title": string, "instruction": string } ]
}`;
  if(lang === "ar"){
    return `أنت مولد وصفات حتمي. أعطني وصفة ${diet} لعدد حصص ${servings} خلال ${time} دقيقة، مستهدف الماكروز: ${macros}. مراعاة القيود/المكونات: ${ingredients}. ${schema} فقط بدون أي نص آخر. استخدم العربية الفصحى.`;
  }else{
    return `You are a deterministic recipe generator. Create a ${diet} recipe for ${servings} servings in ${time} minutes targeting macros: ${macros}. Consider ingredients/constraints: ${ingredients}. Respond with ${schema} ONLY, no extra text. Language: English.`;
  }
}

async function callGemini(prompt){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: { temperature: 0, topP: 1, topK: 1, maxOutputTokens: 1024 }
  };
  const r = await fetch(url, {
    method:"POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error("gemini_error_"+r.status);
  const data = await r.json();
  const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return txt;
}

module.exports.handler = async (event) => {
  if(event.httpMethod !== "POST"){
    return { statusCode: 405, body: JSON.stringify({ ok:false }) };
  }
  try{
    const payload = JSON.parse(event.body||"{}");
    const { lang="ar", email="" } = payload;

    const authed = await auth(event.headers, email);
    if(!authed) return { statusCode: 401, body: JSON.stringify({ ok:false }) };

    const emailSan = sanitizeEmail(email);
    const historyPath = `data/history/${emailSan}.json`;
    const { json: history, sha } = await ghGetJson(historyPath, true);
    const cur = history || { last:null, cache:{} };

    const hashInput = JSON.stringify({
      lang: payload.lang, diet: payload.diet, servings: payload.servings, time: payload.time,
      macros: payload.macros, ingredients: payload.ingredients
    });
    const key = await sha256Hex(hashInput);

    if(cur.cache && cur.cache[key]){
      return { statusCode: 200, body: JSON.stringify({ ok:true, recipe: cur.cache[key] }) };
    }

    let recipe;
    try{
      const text = await callGemini(promptFor(lang, payload));
      const firstBrace = text.indexOf("{");
      const lastBrace  = text.lastIndexOf("}");
      const jsonStr = (firstBrace>=0 && lastBrace>=0) ? text.slice(firstBrace, lastBrace+1) : text;
      recipe = JSON.parse(jsonStr);
    }catch(err){
      const msg = lang==="ar"
        ? "تعذر توليد الوصفة حاليًا، يرجى المحاولة لاحقًا أو التواصل عبر 00971502061209."
        : "Unable to generate a recipe right now. Please try again later or contact us at 00971502061209.";
      return { statusCode: 503, body: JSON.stringify({ ok:false, message: msg }) };
    }

    if(!validateSchema(recipe)){
      const msg = lang==="ar"
        ? "حدث خطأ في هيكل الاستجابة. برجاء المحاولة لاحقًا."
        : "Invalid response schema. Please try again later.";
      return { statusCode: 500, body: JSON.stringify({ ok:false, message: msg }) };
    }

    const updated = { ...cur, last: recipe, cache: { ...(cur.cache||{}), [key]: recipe } };
    await ghPutJson(historyPath, updated, sha || undefined, `history:add ${emailSan} ${key}`);

    return { statusCode: 200, body: JSON.stringify({ ok:true, recipe }) };
  }catch(err){
    const lang = (JSON.parse(event.body||"{}").lang) || "ar";
    const msg = lang==="ar"
      ? "تعذر توليد الوصفة حاليًا، يرجى المحاولة لاحقًا أو التواصل عبر 00971502061209."
      : "Unable to generate a recipe right now. Please try again later or contact us at 00971502061209.";
    return { statusCode: 500, body: JSON.stringify({ ok:false, message: msg, error: err.message }) };
  }
};
