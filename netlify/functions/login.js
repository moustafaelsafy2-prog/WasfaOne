// Netlify Function: login
// POST: { email, password, device_fingerprint_hash }
// Env: GITHUB_TOKEN, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_REF, ADMIN_PASSWORD
// Updates users.json: set device_fingerprint if empty, enforce single-device, set session_nonce + auth_token
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;

const GH_API = "https://api.github.com";

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

function todayISO(){
  // Compare by date-only (UTC-safe for simple windows)
  return new Date().toISOString().slice(0,10);
}
function withinWindow(start, end){
  const d = todayISO();
  if(start && d < start) return false;
  if(end && d > end) return false;
  return true;
}

export async function handler(event){
  if(event.httpMethod !== "POST"){
    return { statusCode: 405, body: JSON.stringify({ ok:false }) };
  }

  try{
    const body = JSON.parse(event.body||"{}");
    const { email, password, device_fingerprint_hash } = body;

    const { json: users, sha } = await ghGetJson("data/users.json");

    const user = (users || []).find(u => (u.email||"").toLowerCase() === (email||"").toLowerCase());
    if(!user || user.password !== password){
      return { statusCode: 401, body: JSON.stringify({ ok:false, reason:"invalid" }) };
    }

    if((user.status||"").toLowerCase() !== "active" || !withinWindow(user.start_date, user.end_date)){
      return { statusCode: 403, body: JSON.stringify({ ok:false, reason:"inactive" }) };
    }

    // Single device logic
    if(!user.device_fingerprint){
      user.device_fingerprint = device_fingerprint_hash || null;
    }else if(user.device_fingerprint !== device_fingerprint_hash){
      return { statusCode: 403, body: JSON.stringify({ ok:false, reason:"device", message:"Account bound to another device." }) };
    }

    // Create session
    const session_nonce = crypto.randomUUID();
    const auth_token = crypto.randomUUID();
    user.session_nonce = session_nonce;
    user.auth_token = auth_token;

    // Commit users.json
    await ghPutJson("data/users.json", users, sha, `login: set session for ${user.email}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        name: user.name || "",
        email: user.email,
        token: auth_token,
        session_nonce
      })
    };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
}
