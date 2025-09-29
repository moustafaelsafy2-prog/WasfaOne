const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GH_API = "https://api.github.com";

function forbidden(){ return { statusCode: 401, body: JSON.stringify({ ok:false, error:"unauthorized" })}; }
function isHttpUrl(u){ try{ const x=new URL(u); return x.protocol==="http:"||x.protocol==="https:"; }catch{ return false; } }

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
    method:"PUT",
    headers:{ Authorization:`token ${GH_TOKEN}`, "User-Agent":"WasfaOne","Content-Type":"application/json" },
    body: JSON.stringify({ message, content, sha, branch: REF })
  });
  if(!r.ok) throw new Error(`GitHub PUT ${path} ${r.status}`);
  return r.json();
}

module.exports.handler = async (event) => {
  if((event.headers["x-admin-key"] || event.headers["X-Admin-Key"]) !== ADMIN_PASSWORD){
    return forbidden();
  }
  try{
    if(event.httpMethod === "GET"){
      const { json: settings } = await ghGetJson("data/settings.json");
      return { statusCode: 200, body: JSON.stringify({ ok:true, settings }) };
    }

    if(event.httpMethod === "PUT"){
      const body = JSON.parse(event.body || "{}");
      const input = body.settings;
      if(!input) return { statusCode: 400, body: JSON.stringify({ ok:false }) };

      const candidates = [
        input?.branding?.logo_url,
        input?.contact?.whatsapp_link,
        ...Object.values(input?.images || {})
      ].filter(Boolean);

      if(!candidates.every(isHttpUrl)){
        return { statusCode: 400, body: JSON.stringify({ ok:false, error:"invalid_url" }) };
      }

      const { sha } = await ghGetJson("data/settings.json");
      await ghPutJson("data/settings.json", input, sha, "admin:update settings");
      return { statusCode: 200, body: JSON.stringify({ ok:true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ ok:false }) };
  }catch(err){
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};
