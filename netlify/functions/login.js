// /netlify/functions/login.js
// Netlify Function: login
// POST: { email, password, device_fingerprint_hash }
// Updates users.json: bind device if empty, enforce single-device, set session_nonce (refresh only), keep auth_token stable
// + NEW: enforce subscription window & auto-suspend if expired (status -> "suspended")

import crypto from "crypto";

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;

const GH_API = "https://api.github.com";
const USERS_PATH = "data/users.json";

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

function todayDubai(){
  const now = new Date();
  const s = now.toLocaleDateString("en-CA", {
    timeZone: "Asia/Dubai", year:"numeric", month:"2-digit", day:"2-digit"
  });
  return s; // YYYY-MM-DD
}

function withinWindow(start, end){
  const d = todayDubai();
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

    if(!email || !password || !device_fingerprint_hash){
      return { statusCode: 400, body: JSON.stringify({ ok:false, reason:"missing_fields" }) };
    }

    const { json: users, sha } = await ghGetJson(USERS_PATH);

    const idx = users.findIndex(
      u => (u.email||"").toLowerCase() === (email||"").toLowerCase()
    );
    if(idx === -1){
      return { statusCode: 401, body: JSON.stringify({ ok:false, reason:"invalid" }) };
    }

    const user = users[idx];
    if(user.password !== password){
      return { statusCode: 401, body: JSON.stringify({ ok:false, reason:"invalid" }) };
    }

    // NEW: auto-suspend if expired, then block
    const today = todayDubai();
    if (user.end_date && today > user.end_date) {
      user.status = "suspended";
      user.lock_reason = "expired";
      users[idx] = user;
      await ghPutJson(USERS_PATH, users, sha, `login: auto-suspend expired ${user.email}`);
      return { statusCode: 403, body: JSON.stringify({
        ok:false,
        reason:"subscription_expired",
        message:"انتهت صلاحية الاشتراك وتم تعليق الحساب"
      }) };
    }

    if((user.status||"").toLowerCase() !== "active" || !withinWindow(user.start_date, user.end_date)){
      return { statusCode: 403, body: JSON.stringify({ ok:false, reason:"inactive" }) };
    }

    // enforce single-device
    if(!user.device_fingerprint){
      user.device_fingerprint = device_fingerprint_hash;
    } else if(user.device_fingerprint !== device_fingerprint_hash){
      return { statusCode: 423, body: JSON.stringify({
        ok:false,
        reason:"device_locked",
        message:"الحساب مرتبط بجهاز آخر. لإعادة الربط: 00971502061209"
      }) };
    }

    // Refresh session_nonce only
    user.session_nonce = crypto.randomUUID();
    if(!user.auth_token){
      user.auth_token = crypto.randomUUID(); // assign once
    }

    users[idx] = user;
    await ghPutJson(USERS_PATH, users, sha, `login: refresh session for ${user.email}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        name: user.name || "",
        email: user.email,
        token: user.auth_token,
        session_nonce: user.session_nonce
      })
    };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
}
