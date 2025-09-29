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

function todayISO(){ return new Date().toISOString().slice(0,10); }
function withinWindow(start, end){
  const d = todayISO();
  if(start && d < start) return false;
  if(end && d > end) return false;
  return true;
}

module.exports.handler = async (event) => {
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

    if(!user.device_fingerprint){
      user.device_fingerprint = device_fingerprint_hash || null;
    }else if(user.device_fingerprint !== device_fingerprint_hash){
      return { statusCode: 403, body: JSON.stringify({ ok:false, reason:"device" }) };
    }

    const { randomUUID } = require("crypto");
    const session_nonce = randomUUID();
    const auth_token = randomUUID();
    user.session_nonce = session_nonce;
    user.auth_token = auth_token;

    await ghPutJson("data/users.json", users, sha, `login: set session for ${user.email}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok:true, name: user.name||"", email: user.email, token: auth_token, session_nonce })
    };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};
