// Netlify Function: userState (GET/PUT)
// Auth headers required for both: x-auth-token, x-session-nonce must match users.json
// Storage per-user: data/history/{email_sanitized}.json
// + NEW: enforce subscription window; auto-suspend if end_date < today and persist to users.json

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = "https://api.github.com";

function sanitizeEmail(email){
  return (email||"").toLowerCase().replace(/[^a-z0-9]+/g,"_");
}
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

async function auth(event){
  const token = event.headers["x-auth-token"] || event.headers["X-Auth-Token"];
  const nonce = event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"];
  const email = (new URLSearchParams(event.queryStringParameters||{}).get("email")) || JSON.parse(event.body||"{}").email;

  if(!token || !nonce || !email) return { ok:false, statusCode: 401 };

  const { json: users, sha } = await ghGetJson("data/users.json");
  const idx = (users||[]).findIndex(u => (u.email||"").toLowerCase() === email.toLowerCase());
  if(idx === -1) return { ok:false, statusCode: 401 };

  const user = users[idx];
  if(user.auth_token !== token || user.session_nonce !== nonce) return { ok:false, statusCode: 401 };

  // NEW: enforce subscription; auto-suspend on expiry; also normalize when out of window
  const today = todayDubai();
  let mutated = false;
  if (user.end_date && today > user.end_date) {
    user.status = "suspended";
    user.lock_reason = "expired";
    mutated = true;
  } else if ((user.status||"").toLowerCase() === "active" && !withinWindow(user.start_date, user.end_date)) {
    // outside window but not expired yet (e.g., before start)
    user.status = "inactive";
    user.lock_reason = null;
    mutated = true;
  }

  if (mutated) {
    users[idx] = user;
    await ghPutJson("data/users.json", users, sha, `userState: normalize ${user.email}`);
  }

  return { ok:true, email, user };
}

export async function handler(event){
  try{
    const a = await auth(event);
    if(!a.ok) return { statusCode: a.statusCode, body: JSON.stringify({ ok:false }) };

    const emailSan = sanitizeEmail(a.email);
    const path = `data/history/${emailSan}.json`;

    if(event.httpMethod === "GET"){
      const { json } = await ghGetJson(path, true);
      return { statusCode: 200, body: JSON.stringify(json || { last:null, cache:{} }) };
    }

    if(event.httpMethod === "PUT"){
      const { json: cur, sha } = await ghGetJson(path, true);
      const body = JSON.parse(event.body||"{}");
      const updated = { ...(cur || { last:null, cache:{} }), last: body.last || null };
      await ghPutJson(path, updated, sha || undefined, `userState:update ${a.email}`);
      return { statusCode: 200, body: JSON.stringify({ ok:true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ ok:false }) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
}
