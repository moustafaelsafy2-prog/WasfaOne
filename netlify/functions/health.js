const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO  = process.env.GITHUB_REPO_NAME;
const REF   = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = "https://api.github.com";

module.exports.handler = async () => {
  try{
    const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/data/users.json?ref=${REF}`, {
      headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
    });
    if(!r.ok) throw new Error("gh_unavailable");
    await r.json();
    return { statusCode: 200, body: JSON.stringify({ ok:true }) };
  }catch{
    return { statusCode: 500, body: JSON.stringify({ ok:false }) };
  }
};
