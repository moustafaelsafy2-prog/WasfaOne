// Netlify Function: adminUsers (CRUD + relink)
// Methods:
//  - GET: list users
//  - POST { action:"create", user } or { action:"relink", email }
//  - PUT  { user } (update by email)
//  - DELETE { email }
// Header: x-admin-key === ADMIN_PASSWORD
// Storage: data/users.json
const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GH_API = "https://api.github.com";

function forbidden(){ return { statusCode: 401, body: JSON.stringify({ ok:false, error:"unauthorized" })}; }

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

export async function handler(event){
  if((event.headers["x-admin-key"] || event.headers["X-Admin-Key"]) !== ADMIN_PASSWORD){
    return forbidden();
  }
  try{
    const { json: users, sha } = await ghGetJson("data/users.json");
    const method = event.httpMethod;

    if(method === "GET"){
      return { statusCode: 200, body: JSON.stringify({ ok:true, users }) };
    }

    const body = JSON.parse(event.body || "{}");

    if(method === "POST"){
      if(body.action === "create" && body.user){
        const u = body.user;
        // prevent dup
        if(users.find(x => x.email.toLowerCase() === (u.email||"").toLowerCase())){
          return { statusCode: 409, body: JSON.stringify({ ok:false, error:"exists" }) };
        }
        users.push({
          email: u.email, password: u.password || "123456", name: u.name || "",
          status: u.status || "active",
          start_date: u.start_date || "", end_date: u.end_date || "",
          device_fingerprint: null, session_nonce: null, lock_reason: null, auth_token: null
        });
        await ghPutJson("data/users.json", users, sha, `admin:create ${u.email}`);
        return { statusCode: 200, body: JSON.stringify({ ok:true }) };
      }
      if(body.action === "relink" && body.email){
        const u = users.find(x => x.email.toLowerCase() === body.email.toLowerCase());
        if(!u) return { statusCode: 404, body: JSON.stringify({ ok:false }) };
        u.device_fingerprint = null;
        u.session_nonce = null;
        u.auth_token = null;
        u.lock_reason = null;
        await ghPutJson("data/users.json", users, sha, `admin:relink ${u.email}`);
        return { statusCode: 200, body: JSON.stringify({ ok:true }) };
      }
      return { statusCode: 400, body: JSON.stringify({ ok:false }) };
    }

    if(method === "PUT" && body.user){
      const u = body.user;
      const idx = users.findIndex(x => x.email.toLowerCase() === (u.email||"").toLowerCase());
      if(idx === -1) return { statusCode: 404, body: JSON.stringify({ ok:false }) };
      // Only update editable fields (email immutable here to keep keying)
      users[idx].name = u.name ?? users[idx].name;
      users[idx].status = u.status ?? users[idx].status;
      users[idx].start_date = u.start_date ?? users[idx].start_date;
      users[idx].end_date = u.end_date ?? users[idx].end_date;
      await ghPutJson("data/users.json", users, sha, `admin:update ${users[idx].email}`);
      return { statusCode: 200, body: JSON.stringify({ ok:true }) };
    }

    if(method === "DELETE" && body.email){
      const idx = users.findIndex(x => x.email.toLowerCase() === body.email.toLowerCase());
      if(idx === -1) return { statusCode: 404, body: JSON.stringify({ ok:false }) };
      const removed = users.splice(idx,1)[0];
      await ghPutJson("data/users.json", users, sha, `admin:delete ${removed.email}`);
      return { statusCode: 200, body: JSON.stringify({ ok:true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ ok:false }) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
}
