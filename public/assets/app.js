/* WasfaOne Frontend — Single-file vanilla JS
   Pages: index.html, login.html, app.html, admin.html, privacy.html, 404.html
   - Bilingual (AR/EN) full swap: dir, fonts, texts, UI
   - Loads /data/settings.json
   - Talks to Netlify Functions:
     /.netlify/functions/login
     /.netlify/functions/generateRecipe
     /.netlify/functions/userState (GET/PUT)
     /.netlify/functions/adminUsers (CRUD)
     /.netlify/functions/adminSettings (GET/PUT)
*/

/* ------------------------- i18n ------------------------- */
const I18N = {
  ar: {
    langName: "العربية",
    toggle: "EN",
    startNow: "ابدأ الآن",
    features: [
      { title: "وصفات دقيقة", desc: "نتائج ثابتة بنفس البنية والماكروز." },
      { title: "قفل جهاز واحد", desc: "حساب مرتبط بجهاز واحد لمنع المشاركة." },
      { title: "واجهة سهلة", desc: "تصميم واضح ومتجاوب لجميع الأجهزة." },
      { title: "بدون تثبيت", desc: "يعمل عبر المتصفح فورًا." },
    ],
    dietTitle: "الأنظمة الغذائية المخصصة",
    contactWhats: "واتساب",
    contactCall: "اتصل الآن",
    contactEmail: "البريد",
    form: {
      diet: "النظام الغذائي",
      servings: "عدد الحصص",
      time: "الوقت (د)",
      macros: "الماكروز المستهدفة",
      ingredients: "مكونات متاحة (اختياري)",
      genNow: "توليد الوصفة الآن",
      last: "آخر وصفة",
      copyJson: "نسخ JSON"
    },
    logout: "خروج",
    loading: "جاري التنفيذ...",
    needLogin: "الرجاء تسجيل الدخول",
    invalid: "مدخلات غير صالحة",
    copied: "تم النسخ",
  },
  en: {
    langName: "English",
    toggle: "ع",
    startNow: "Start Now",
    features: [
      { title: "Accurate recipes", desc: "Stable, schema-consistent results." },
      { title: "Single-device lock", desc: "Account bound to one device." },
      { title: "Simple UI", desc: "Clean, responsive layout." },
      { title: "No install", desc: "Runs in the browser." },
    ],
    dietTitle: "Custom Diets",
    contactWhats: "WhatsApp",
    contactCall: "Call now",
    contactEmail: "Email",
    form: {
      diet: "Diet",
      servings: "Servings",
      time: "Time (min)",
      macros: "Target macros",
      ingredients: "Available ingredients (optional)",
      genNow: "Generate Now",
      last: "Load Last",
      copyJson: "Copy JSON"
    },
    logout: "Logout",
    loading: "Loading...",
    needLogin: "Please login",
    invalid: "Invalid input",
    copied: "Copied",
  }
};

/* ------------------------- helpers ------------------------- */
function byId(id){ return document.getElementById(id); }
function qs(sel, root=document){ return root.querySelector(sel); }
function setText(id, t){ const el = byId(id); if(el) el.textContent = t; }
function setHtml(id, h){ const el = byId(id); if(el) el.innerHTML = h; }
function show(el){ if(typeof el==="string") el = byId(el); if(el) el.classList.remove("hidden"); }
function hide(el){ if(typeof el==="string") el = byId(el); if(el) el.classList.add("hidden"); }
function safeJSON(o){ return JSON.stringify(o, null, 2); }
function getLang(){ return localStorage.getItem("lang") || "ar"; }
function setLang(lang){ localStorage.setItem("lang", lang); applyLangToDocument(lang); }
function applyLangToDocument(lang){
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang==="ar"?"rtl":"ltr");
}
function bindLangToggle(refresher){
  const el = byId("lang-toggle");
  if(!el) return;
  el.onclick = () => {
    const cur = getLang();
    const next = cur==="ar" ? "en" : "ar";
    setLang(next);
    if(typeof refresher==="function") refresher();
  };
  el.textContent = I18N[getLang()].toggle;
}
function setSimpleLogoImg(id, settings, lang){
  const el = byId(id);
  if(el && settings?.branding?.logo_url){
    el.src = settings.branding.logo_url;
    el.alt = (lang==="ar"? settings.branding.site_name_ar : settings.branding.site_name_en) || "logo";
  }
}
function alertBox(text){
  const el = byId("app-alert"); if(!el) return;
  el.textContent = text || "";
  if(text) show(el); else hide(el);
}

async function loadSettings(){
  const r = await fetch("/data/settings.json", { cache: "no-store" });
  if(!r.ok) throw new Error("settings_failed");
  return r.json();
}

/* ------------------------- auth ------------------------- */
function requireAuthOrRedirect(){
  const token = localStorage.getItem("auth_token");
  const nonce = localStorage.getItem("session_nonce");
  if(!token || !nonce){
    window.location.href = "/login.html";
    return false;
  }
  return true;
}

/* ------------------------- app page ------------------------- */
async function initAppPage(){
  if(!requireAuthOrRedirect()) return;
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initAppPage);
  const t = I18N[lang];

  // شعار واسم المستخدم
  try{
    const settings = await loadSettings();
    setSimpleLogoImg("app-logo", settings, lang);
  }catch{}
  const name = localStorage.getItem("user_name") || (lang==="ar"?"مستخدم":"User");
  if(byId("user-name")) byId("user-name").textContent = name;
  if(byId("btn-logout")) byId("btn-logout").onclick = () => { localStorage.clear(); window.location.href = "/login.html"; };

  // حقول الإدخال
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

  // تهيئة قائمة الأنظمة من settings
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
  }catch(e){}

  function renderRecipe(json){
    const r = json;
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
        headers: {
          "x-auth-token": localStorage.getItem("auth_token")||"",
          "x-session-nonce": localStorage.getItem("session_nonce")||""
        }
      });
      const jr = await r.json();
      alertBox("");
      if(jr?.ok && jr?.last){ renderRecipe(jr.last); }
    }catch(e){ alertBox(""); }
  }

  if(btnLast) btnLast.onclick = loadLast;

  if(btnCopy) btnCopy.onclick = () => {
    const pre = qs("#recipe-box pre");
    if(pre){
      navigator.clipboard.writeText(pre.textContent||"");
      alertBox(t.copied);
      setTimeout(()=>alertBox(""), 1200);
    }
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
        alertBox(jr?.error || t.invalid);
      }
    }catch(e){
      alertBox(t.invalid);
    }
  };

  // حمّل آخر وصفة افتراضيًا
  loadLast();
}

/* ------------------------- router ------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  const path = location.pathname;
  if(path.endsWith("/app.html")) return initAppPage();
  // (صفحات أخرى إن وُجدت)
});
