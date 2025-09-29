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
      { title: "قفل جهاز واحد", desc: "منع مشاركة الحساب وربطه بجهاز واحد." },
      { title: "واجهة سهلة", desc: "تصميم واضح ومتجاوب لجميع الأجهزة." },
      { title: "بدون تثبيت", desc: "يعمل عبر المتصفح فورًا." },
    ],
    dietTitle: "الأنظمة الغذائية المخصصة",
    contactWhats: "واتساب",
    home: "الرئيسية",
    app: {
      title: "توليد وصفة ذكية",
      sub: "أدخل تفضيلاتك واحتياجاتك الغذائية، وسنولّد وصفة متسقة بالماكروز وبنفس البنية دائمًا.",
      lblDiet: "النظام الغذائي",
      lblServings: "عدد الحصص",
      lblTime: "الوقت المتاح (دقائق)",
      lblMacros: "الماكروز المستهدفة (سعرات/بروتين/كربس/دهون)",
      lblIngr: "مكونات متاحة/تحفظات",
      btnGenerate: "توليد الوصفة",
      btnLoadLast: "تحميل آخر نتيجة",
      btnLogout: "خروج",
      macrosTitle: "الماكروز",
      ingTitle: "المكونات",
      stepsTitle: "التحضير",
      copyJson: "نسخ JSON",
      timeServ: (t,s)=>`الوقت: ${t} دقيقة · الحصص: ${s}`,
      loginRequired: "الرجاء تسجيل الدخول أولاً.",
      errorSchema: "حدث خطأ في هيكل الاستجابة. برجاء المحاولة لاحقًا.",
      unableNow: "تعذر توليد الوصفة حاليًا، يرجى المحاولة لاحقًا أو التواصل عبر 00971502061209.",
    },
    login: {
      title: "تسجيل الدخول",
      placeholderEmail: "البريد الإلكتروني",
      placeholderPass: "كلمة المرور",
      errorInvalid: "بيانات الدخول غير صحيحة.",
      errorInactive: "الحساب غير نشط أو خارج مدة الاشتراك.",
      errorDevice: "حسابك مرتبط بجهاز آخر. لإعادة الربط: 00971502061209",
      button: "دخول",
    },
    admin: {
      gateTitle: "لوحة التحكم",
      gateSub: "أدخل كلمة مرور الأدمن مرة واحدة للوصول للإدارة (تحفظ محليًا أثناء الجلسة).",
      users: "المستخدمون",
      settings: "الإعدادات العامة",
      images: "الصور",
      add: "إضافة",
      save: "حفظ",
      relink: "إعادة ربط الجهاز",
      delete: "حذف",
      status: "الحالة",
      active: "active",
      start: "البداية",
      end: "النهاية",
      device: "الجهاز",
      actions: "إجراءات",
      saved: "تم الحفظ",
      invalidUrl: "رابط غير صالح. يُقبل http/https فقط.",
    },
    privacy: {
      title: "سياسة الخصوصية",
      backHome: "العودة للرئيسية",
      content: "لا نجمع بيانات شخصية؛ لا نستخدم قواعد بيانات؛ يتم التخزين عبر GitHub فقط للملفات العامة المطلوبة لتشغيل الخدمة (users.json, settings.json, history). استخدام التطبيق يعني موافقتك على هذه السياسة."
    },
    notfound: {
      text: "عذرًا، الصفحة غير موجودة.",
      home: "العودة للرئيسية",
    }
  },
  en: {
    langName: "English",
    toggle: "AR",
    startNow: "Start Now",
    features: [
      { title: "Precise recipes", desc: "Deterministic results with consistent macros & schema." },
      { title: "Single-device lock", desc: "Account bound to one device to prevent sharing." },
      { title: "Easy interface", desc: "Clean, responsive UI for all devices." },
      { title: "No install", desc: "Runs instantly in your browser." },
    ],
    dietTitle: "Custom Diet Systems",
    contactWhats: "WhatsApp",
    home: "Home",
    app: {
      title: "Smart Recipe Generator",
      sub: "Enter your preferences & nutrition targets. We output a consistent, schema-validated recipe.",
      lblDiet: "Diet system",
      lblServings: "Servings",
      lblTime: "Time (minutes)",
      lblMacros: "Target macros (kcal/protein/carbs/fats)",
      lblIngr: "Available ingredients / restrictions",
      btnGenerate: "Generate Recipe",
      btnLoadLast: "Load Last",
      btnLogout: "Logout",
      macrosTitle: "Macros",
      ingTitle: "Ingredients",
      stepsTitle: "Preparation",
      copyJson: "Copy JSON",
      timeServ: (t,s)=>`Time: ${t} min · Servings: ${s}`,
      loginRequired: "Please login first.",
      errorSchema: "Invalid response schema. Please try again later.",
      unableNow: "Unable to generate a recipe right now. Please try again later or contact us at 00971502061209.",
    },
    login: {
      title: "Login",
      placeholderEmail: "Email",
      placeholderPass: "Password",
      errorInvalid: "Invalid credentials.",
      errorInactive: "Inactive account or outside subscription window.",
      errorDevice: "Your account is linked to another device. To relink: 00971502061209",
      button: "Login",
    },
    admin: {
      gateTitle: "Admin Panel",
      gateSub: "Enter the admin password once to access (kept locally during the session).",
      users: "Users",
      settings: "Settings",
      images: "Images",
      add: "Add",
      save: "Save",
      relink: "Relink Device",
      delete: "Delete",
      status: "Status",
      active: "active",
      start: "Start",
      end: "End",
      device: "Device",
      actions: "Actions",
      saved: "Saved",
      invalidUrl: "Invalid URL. Only http/https allowed.",
    },
    privacy: {
      title: "Privacy Policy",
      backHome: "Back to Home",
      content: "We do not collect personal data. No databases are used. Storage is via GitHub for the public files required to run the service (users.json, settings.json, history). Using the app implies your consent."
    },
    notfound: {
      text: "Sorry, the page was not found.",
      home: "Back to Home",
    }
  }
};

/* ------------------------- Language Helpers ------------------------- */
function getLang(){ return localStorage.getItem("lang") || "ar"; }
function setLang(lang){ localStorage.setItem("lang", lang); applyLangToDocument(lang); }
function applyLangToDocument(lang){
  const isAr = lang === "ar";
  document.documentElement.lang = lang;
  document.documentElement.dir  = isAr ? "rtl" : "ltr";
  document.body.classList.toggle("font-ar", isAr);
  document.body.classList.toggle("font-en", !isAr);
  document.body.classList.toggle("rtl", isAr);
  document.body.classList.toggle("ltr", !isAr);
  const toggleBtn = document.getElementById("lang-toggle");
  if (toggleBtn) toggleBtn.textContent = I18N[lang].toggle;
}
function bindLangToggle(pageInitFn){
  const btn = document.getElementById("lang-toggle");
  if(!btn) return;
  btn.addEventListener("click", ()=>{
    const newLang = getLang()==="ar" ? "en" : "ar";
    setLang(newLang);
    pageInitFn && pageInitFn();
  });
}

/* ------------------------- Settings Loader ------------------------- */
async function loadSettings(){
  // النسخة العامة داخل public
  const res = await fetch("/data/settings.json", { cache: "no-store" });
  if(!res.ok) throw new Error("settings");
  return res.json();
}

/* ------------------------- Common Helpers ------------------------- */
function setLogo(elId, settings, lang){
  const el = document.getElementById(elId);
  if(!el) return;
  const url = (settings?.branding?.logo_url) || (settings?.images?.logo_fallback);
  const img = document.createElement("img");
  img.src = url;
  const alt = settings?.images_meta?.logo_fallback?.[`alt_${lang}`] || "Logo";
  img.alt = alt;
  img.className = "h-8 object-contain";
  el.innerHTML = "";
  el.appendChild(img);
}
function setSimpleLogoImg(imgId, settings, lang){
  const el = document.getElementById(imgId);
  if(!el) return;
  const url = (settings?.branding?.logo_url) || (settings?.images?.logo_fallback);
  el.src = url;
  el.alt = settings?.images_meta?.logo_fallback?.[`alt_${lang}`] || "Logo";
}
function byId(id){ return document.getElementById(id); }
function isValidHttpUrl(u){ try{ const x=new URL(u); return x.protocol==="http:"||x.protocol==="https:"; }catch{ return false; } }

/* ------------------------- Index Page ------------------------- */
async function loadIndexPage(){ /* … كما سابقًا … */ }

/* ------------------------- Device Fingerprint ------------------------- */
function getOrCreateDeviceId(){ let id = localStorage.getItem("device_id"); if(!id){ id = crypto.randomUUID(); localStorage.setItem("device_id", id);} return id; }
async function sha256Hex(str){ const enc = new TextEncoder(); const buf = await crypto.subtle.digest("SHA-256", enc.encode(str)); return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join(""); }
async function computeDeviceFingerprintHash(){
  const id = getOrCreateDeviceId();
  const nav = window.navigator, scr = window.screen, tz = new Date().getTimezoneOffset();
  const parts = [ id, nav.userAgent, nav.language, scr.width, scr.height, scr.colorDepth, tz, nav.platform, nav.hardwareConcurrency ].join("|");
  return sha256Hex(parts);
}

/* ------------------------- Login Page ------------------------- */
async function initLoginPage(){
  const lang = getLang(); applyLangToDocument(lang);
  const t = I18N[lang];
  byId("login-title").textContent = t.login.title;
  byId("email").placeholder = t.login.placeholderEmail;
  byId("password").placeholder = t.login.placeholderPass;
  bindLangToggle(initLoginPage);

  const form = byId("login-form");
  const errorEl = byId("login-error");
  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    errorEl.classList.add("hidden");
    const email = byId("email").value.trim();
    const password = byId("password").value;
    const device_fingerprint_hash = await computeDeviceFingerprintHash();

    try{
      const res = await fetch("/.netlify/functions/login", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ email, password, device_fingerprint_hash })
      });
      const data = await res.json();

      if(!res.ok || !data?.ok){
        const msg = (data?.reason==="inactive") ? t.login.errorInactive
                  : (data?.reason==="device") ? t.login.errorDevice
                  : t.login.errorInvalid;
        errorEl.textContent = msg;
        errorEl.classList.remove("hidden");
        return;
      }

      localStorage.setItem("auth_token", data.token);
      localStorage.setItem("session_nonce", data.session_nonce);
      localStorage.setItem("user_email", data.email);
      localStorage.setItem("user_name", data.name || "");
      location.href = "app.html";
    }catch(err){
      errorEl.textContent = t.login.errorInvalid;
      errorEl.classList.remove("hidden");
    }
  });
}

/* ------------------------- Auth Helpers ------------------------- */
function isLoggedIn(){ return !!localStorage.getItem("auth_token") && !!localStorage.getItem("session_nonce"); }
function logout(){ localStorage.removeItem("auth_token"); localStorage.removeItem("session_nonce"); localStorage.removeItem("user_email"); localStorage.removeItem("user_name"); location.href = "login.html"; }

/* ------------------------- App Page ------------------------- */
async function initAppPage(){ /* … نفس السابق … */ }
async function withAuthFetch(url, options={}){ const headers = new Headers(options.headers||{}); headers.set("Content-Type","application/json"); headers.set("x-auth-token", localStorage.getItem("auth_token")||""); headers.set("x-session-nonce", localStorage.getItem("session_nonce")||""); return fetch(url, { ...options, headers }); }
async function loadLastStateAndRender(){ /* … */ }
async function generateRecipeAndRender(){ /* … */ }
function showAppError(msg){ /* … */ }
function renderRecipe(recipe, lang){ /* … */ }
async function copyResultJson(){ /* … */ }

/* ------------------------- Admin Page ------------------------- */
async function initAdminPage(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initAdminPage);
  const t = I18N[lang];
  const settings = await loadSettings();

  setSimpleLogoImg("admin-logo", settings, lang);
  byId("admin-site-name").textContent = settings?.branding?.[`site_name_${lang}`] || "WasfaOne";
  byId("admin-home-link").textContent = t.home;

  byId("admin-gate-title").textContent = t.admin.gateTitle;
  byId("admin-gate-sub").textContent = t.admin.gateSub;

  const keyInput = byId("admin-key-input");
  const gateError = byId("admin-gate-error");
  const panels = byId("admin-panels");
  const gate = byId("admin-gate");
  const savedKey = sessionStorage.getItem("admin_key");
  if(savedKey){ await openAdmin(savedKey); }
  byId("admin-key-save").addEventListener("click", async ()=>{ const k = keyInput.value.trim(); await openAdmin(k); });

  async function openAdmin(k){
    const ok = await fetch("/.netlify/functions/adminSettings", { headers: { "x-admin-key": k }}).then(r=>r.ok).catch(()=>false);
    if(!ok){ gateError.textContent = lang==="ar"?"مفتاح أدمن غير صحيح.":"Invalid admin key."; gateError.classList.remove("hidden"); return; }
    sessionStorage.setItem("admin_key", k);
    gate.classList.add("hidden"); panels.classList.remove("hidden");
    initTabs(); await loadUsers(); await loadSettingsEditor(); await loadImagesEditor();
  }

  function initTabs(){
    const btns = document.querySelectorAll(".tab-btn");
    btns.forEach(b=>{
      b.textContent = (b.dataset.tab==="users")? t.admin.users : (b.dataset.tab==="settings")? "Settings" : "Images";
      b.addEventListener("click", ()=>{
        btns.forEach(x=>x.classList.remove("active"));
        b.classList.add("active");
        document.querySelectorAll(".tab-pane").forEach(p=>p.classList.add("hidden"));
        byId(`tab-${b.dataset.tab}`).classList.remove("hidden");
      });
    });
    byId("users-title").textContent = t.admin.users;
    byId("settings-title").textContent = t.admin.settings;
    byId("images-title").textContent = t.admin.images;
    byId("btn-add-user").textContent = t.admin.add;
    byId("btn-save-settings").textContent = t.admin.save;
    byId("btn-save-images").textContent = t.admin.save;
  }

  /* Users CRUD */
  async function loadUsers(){
    const key = sessionStorage.getItem("admin_key");
    const res = await fetch("/.netlify/functions/adminUsers", { headers: { "x-admin-key": key } });
    const data = await res.json();
    const tbody = byId("users-tbody");
    tbody.innerHTML = "";
    (data?.users || []).forEach((u, idx)=>{
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input class="inp" data-f="email" value="${u.email}"></td>
        <td><input class="inp" data-f="name" value="${u.name||""}"></td>
        <td><input class="inp" data-f="password" type="password" placeholder="••••••" value="${u.password||""}"></td>
        <td><input class="inp" data-f="status" value="${u.status||"active"}"></td>
        <td><input class="inp" data-f="start_date" value="${u.start_date||""}"></td>
        <td><input class="inp" data-f="end_date" value="${u.end_date||""}"></td>
        <td><span class="badge">${u.device_fingerprint? "bound":"—"}</span></td>
        <td class="space-x-2">
           <button class="btn bg-primary text-white px-3 py-1 rounded save">${t.admin.save}</button>
           <button class="btn bg-slate-200 px-3 py-1 rounded relink">${t.admin.relink}</button>
           <button class="btn bg-red-500 text-white px-3 py-1 rounded del">${t.admin.delete}</button>
        </td>
      `;
      tr.querySelector(".save").addEventListener("click", async ()=>{
        const payload = rowToUser(tr);
        await fetch("/.netlify/functions/adminUsers", {
          method: "PUT",
          headers: { "Content-Type":"application/json", "x-admin-key": key },
          body: JSON.stringify({ user: payload })
        });
        await loadUsers();
      });
      tr.querySelector(".relink").addEventListener("click", async ()=>{
        const email = tr.querySelector('[data-f="email"]').value.trim();
        await fetch("/.netlify/functions/adminUsers", {
          method: "POST",
          headers: { "Content-Type":"application/json", "x-admin-key": key },
          body: JSON.stringify({ action:"relink", email })
        });
        await loadUsers();
      });
      tr.querySelector(".del").addEventListener("click", async ()=>{
        const email = tr.querySelector('[data-f="email"]').value.trim();
        await fetch("/.netlify/functions/adminUsers", {
          method: "DELETE",
          headers: { "Content-Type":"application/json", "x-admin-key": key },
          body: JSON.stringify({ email })
        });
        await loadUsers();
      });
      tbody.appendChild(tr);
    });

    byId("btn-add-user").onclick = async ()=>{
      const key = sessionStorage.getItem("admin_key");
      await fetch("/.netlify/functions/adminUsers", {
        method: "POST",
        headers: { "Content-Type":"application/json", "x-admin-key": key },
        body: JSON.stringify({ action:"create", user: {
          email:"new@example.com", password:"123456", name:"New User",
          status:"active", start_date:"2025-09-01", end_date:"2026-09-01",
          device_fingerprint:null, session_nonce:null, lock_reason:null
        }})
      });
      await loadUsers();
    };

    function rowToUser(tr){
      const g = f => tr.querySelector(`[data-f="${f}"]`).value.trim();
      return {
        email: g("email"),
        name: g("name"),
        password: g("password"), // ← مهم
        status: g("status"),
        start_date: g("start_date"),
        end_date: g("end_date")
      };
    }
  }

  /* Settings Editor */
  async function loadSettingsEditor(){ /* … كما سابقًا … */ }

  /* Images Editor */
  async function loadImagesEditor(){ /* … كما سابقًا … */ }
}

/* ------------------------- Privacy & 404 ------------------------- */
async function initPrivacyPage(){ /* … */ }
function init404Page(){ /* … */ }

/* ------------------------- Expose to window ------------------------- */
window.loadIndexPage   = loadIndexPage;
window.initLoginPage   = initLoginPage;
window.initAppPage     = initAppPage;
window.initAdminPage   = initAdminPage;
window.initPrivacyPage = initPrivacyPage;
window.init404Page     = init404Page;
