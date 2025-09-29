/* WasfaOne Frontend — app.js (diagnostics enabled) */

const I18N = {
  ar: {
    toggle: "EN",
    loading: "جاري التنفيذ...",
    needLogin: "الرجاء تسجيل الدخول",
    invalid: "مدخلات غير صالحة",
    copied: "تم النسخ",
    friendlyErr: "تعذر توليد الوصفة حاليًا.",
    details: "التفاصيل"
  },
  en: {
    toggle: "ع",
    loading: "Loading...",
    needLogin: "Please login",
    invalid: "Invalid input",
    copied: "Copied",
    friendlyErr: "Unable to generate a recipe right now.",
    details: "Details"
  }
};

function byId(id){ return document.getElementById(id); }
function qs(sel, root=document){ return root.querySelector(sel); }
function setHtml(id, h){ const el = byId(id); if(el) el.innerHTML = h; }
function show(el){ if(typeof el==="string") el = byId(el); if(el) el.classList.remove("hidden"); }
function hide(el){ if(typeof el==="string") el = byId(el); if(el) el.classList.add("hidden"); }
function safeJSON(o){ try{ return JSON.stringify(o, null, 2); }catch{return String(o)} }
function getLang(){ return localStorage.getItem("lang") || "ar"; }
function applyLangToDocument(lang){ document.documentElement.lang = lang; document.documentElement.dir = (lang==="ar"?"rtl":"ltr"); }
function bindLangToggle(refresher){
  const el = byId("lang-toggle");
  if(!el) return;
  el.onclick = () => {
    const cur = getLang();
    const next = cur==="ar" ? "en" : "ar";
    localStorage.setItem("lang", next);
    applyLangToDocument(next);
    if(typeof refresher==="function") refresher();
  };
  el.textContent = I18N[getLang()].toggle;
}
function alertBox(text, details){
  const el = byId("app-alert"); if(!el) return;
  if(!text){ el.textContent = ""; hide(el); return; }
  if(details){
    el.innerHTML = `
      <div>${text}</div>
      <details class="mt-2">
        <summary class="cursor-pointer underline">${I18N[getLang()].details}</summary>
        <pre class="mt-2 whitespace-pre-wrap text-xs bg-gray-50 border rounded p-2">${typeof details==="string"? details : safeJSON(details)}</pre>
      </details>`;
  }else{
    el.textContent = text;
  }
  show(el);
}

async function loadSettings(){
  const r = await fetch("/data/settings.json", { cache: "no-store" });
  if(!r.ok) throw new Error("settings_failed");
  return r.json();
}

function requireAuthOrRedirect(){
  const token = localStorage.getItem("auth_token");
  const nonce = localStorage.getItem("session_nonce");
  if(!token || !nonce){ window.location.href = "/login.html"; return false; }
  return true;
}

async function initAppPage(){
  if(!requireAuthOrRedirect()) return;
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initAppPage);
  const t = I18N[lang];

  try{ const settings = await loadSettings(); const logo = byId("app-logo"); if(logo && settings?.branding?.logo_url){ logo.src = settings.branding.logo_url; } }catch{}

  const name = localStorage.getItem("user_name") || (lang==="ar"?"مستخدم":"User");
  if(byId("user-name")) byId("user-name").textContent = name;
  if(byId("btn-logout")) byId("btn-logout").onclick = () => { localStorage.clear(); window.location.href = "/login.html"; };

  const dietSel = byId("diet");
  const servings = byId("servings");
  const time = byId("time");
  const macros = byId("macros");
  const ing = byId("ingredients");
  const btnGen = byId("btn-generate");
  const btnCopy = byId("btn-copy-json");
  const btnLast = byId("btn-load-last");
  const recipeBox = byId("recipe-box");
  const langToggle = byId("lang-toggle");
  if(langToggle) langToggle.textContent = t.toggle;

  try{
    const settings = await loadSettings();
    if(dietSel){
      dietSel.innerHTML = "";
      (settings?.diets||[]).forEach(d => {
        const opt = document.createElement("option");
        opt.value = d.id; opt.textContent = (lang==="ar"? d.name_ar : d.name_en);
        dietSel.appendChild(opt);
      });
    }
  }catch{}

  function renderRecipe(r){
    setHtml("recipe-box", `
      <h2 class="text-xl font-bold mb-3">${r.title}</h2>
      <div class="text-sm text-gray-600 mb-4">${(lang==="ar"?"حصص":"Servings")}: ${r.servings} • ${(lang==="ar"?"الوقت":"Time")}: ${r.total_time_min} min</div>
      <div class="mb-3">
        <div class="font-semibold mb-1">${(lang==="ar"?"المكونات":"Ingredients")}</div>
        <ul class="list-disc pr-6">${r.ingredients.map(i=>`<li>${i}</li>`).join("")}</ul>
      </div>
      <div class="mb-3">
        <div class="font-semibold mb-1">${(lang==="ar"?"الخطوات":"Steps")}</div>
        <ol class="list-decimal pr-6">${r.steps.map(i=>`<li>${i}</li>`).join("")}</ol>
      </div>
      <pre class="bg-gray-50 border rounded-xl p-3 overflow-x-auto text-xs">${safeJSON(r)}</pre>
    `);
  }

  async function loadLast(){
    try{
      alertBox(t.loading);
      const email = localStorage.getItem("user_email");
      const r = await fetch(`/.netlify/functions/userState?email=${encodeURIComponent(email)}`, {
        headers: { "x-auth-token": localStorage.getItem("auth_token")||"", "x-session-nonce": localStorage.getItem("session_nonce")||"" }
      });
      const jr = await r.json();
      alertBox("");
      if(jr?.ok && jr?.last) renderRecipe(jr.last);
    }catch(e){ alertBox(""); }
  }
  if(btnLast) btnLast.onclick = loadLast;

  if(btnCopy) btnCopy.onclick = () => {
    const pre = qs("#recipe-box pre");
    if(pre){ navigator.clipboard.writeText(pre.textContent||""); alertBox(t.copied); setTimeout(()=>alertBox(""), 1200); }
  };

  if(btnGen) btnGen.onclick = async () => {
    try{
      alertBox(t.loading);
      const payload = {
        email: localStorage.getItem("user_email"),
        diet: dietSel?.value || "balanced",
        servings: Number(servings?.value || 1),
        time: Number(time?.value || 20),
        macros: macros?.value || "",
        ingredients: ing?.value || ""
      };
      if(!payload.email){ alertBox(t.needLogin); return; }

      const r = await fetch("/.netlify/functions/generateRecipe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-auth-token": localStorage.getItem("auth_token")||"",
          "x-session-nonce": localStorage.getItem("session_nonce")||""
        },
        body: JSON.stringify(payload)
      });

      const jr = await r.json();
      alertBox("");

      if(jr?.ok && jr?.recipe){
        renderRecipe(jr.recipe);
      }else{
        // NEW: show clear diagnostics from server
        const msg = jr?.error || t.friendlyErr;
        const diag = jr?.error_detail || jr?.diagnostics || jr;
        alertBox(msg, diag);
      }
    }catch(e){
      alertBox(t.friendlyErr, String(e?.message||e));
    }
  };

  loadLast();
}

document.addEventListener("DOMContentLoaded", () => {
  if(location.pathname.endsWith("/app.html")) return initAppPage();
});
