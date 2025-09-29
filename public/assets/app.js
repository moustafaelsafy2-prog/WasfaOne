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
      choose: "اختر"
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
      choose: "Select"
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
  // نقرأ النسخة العامة داخل public
  const res = await fetch("/data/settings.json", { cache: "no-store" });
  if(!res.ok) throw new Error("settings");
  return res.json();
}

/* ------------------------- Common Helpers ------------------------- */
function byId(id){ return document.getElementById(id); }
function isValidHttpUrl(u){ try{ const x=new URL(u); return x.protocol==="http:"||x.protocol==="https:"; }catch{ return false; } }
function setLogo(elId, settings, lang){
  const el = byId(elId);
  if(!el) return;
  const url = (settings?.branding?.logo_url) || (settings?.images?.logo_fallback) || "";
  const img = document.createElement("img");
  img.src = url;
  const alt = settings?.images_meta?.logo_fallback?.[`alt_${lang}`] || "Logo";
  img.alt = alt;
  img.className = "h-8 object-contain";
  el.innerHTML = "";
  el.appendChild(img);
}
function setSimpleLogoImg(imgId, settings, lang){
  const el = byId(imgId);
  if(!el) return;
  const url = (settings?.branding?.logo_url) || (settings?.images?.logo_fallback) || "";
  el.src = url;
  el.alt = settings?.images_meta?.logo_fallback?.[`alt_${lang}`] || "Logo";
}

/* ------------------------- Index Page ------------------------- */
async function loadIndexPage(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(loadIndexPage);
  const t = I18N[lang];
  let settings = {};
  try{ settings = await loadSettings(); }catch{}

  // شعار ونصوص
  setLogo("nav-logo", settings, lang);
  const titleEl  = byId("hero-title");
  const subEl    = byId("hero-sub");
  if(titleEl) titleEl.textContent = (lang==="ar") ? "وصفة ون" : "WasfaOne";
  if(subEl)   subEl.textContent   = (lang==="ar")
    ? "أذكى طريقة للحصول على وصفات متسقة بالماكروز وبنية موثوقة."
    : "The smartest way to get macro-consistent, schema-validated recipes.";

  // زر ابدأ الآن
  const startBtn = byId("start-btn");
  if(startBtn){
    startBtn.textContent = t.startNow;
    startBtn.onclick = ()=> location.href = "login.html";
  }

  // الميزات
  (byId("features")||{innerHTML:null}).innerHTML = (t.features||[]).map(f=>`
    <div class="p-4 rounded-2xl bg-white shadow">
      <div class="font-semibold mb-1">${f.title}</div>
      <div class="text-sm text-slate-600">${f.desc}</div>
    </div>
  `).join("");

  // أنظمة الحمية من الإعدادات (إن وُجدت)
  const dietsWrap = byId("diet-list");
  if(dietsWrap && settings?.diets?.length){
    dietsWrap.innerHTML = settings.diets.map(d=>`
      <div class="p-3 rounded-xl bg-slate-100">${(lang==="ar"?d.name_ar:d.name_en)||d.id}</div>
    `).join("");
  }

  // روابط تواصل
  const whatsLink = byId("contact-whats");
  if(whatsLink && settings?.contact?.whatsapp_link){
    whatsLink.href = settings.contact.whatsapp_link;
    whatsLink.textContent = (lang==="ar"? "واتساب/اتصال: " : "WhatsApp: ")
      + (settings.contact.phone_display || "");
  }
}

/* ------------------------- Device Fingerprint ------------------------- */
function getOrCreateDeviceId(){
  let id = localStorage.getItem("device_id");
  if(!id){ id = crypto.randomUUID(); localStorage.setItem("device_id", id); }
  return id;
}
async function sha256Hex(str){
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
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
  bindLangToggle(initLoginPage);

  // نصوص
  byId("login-title") && (byId("login-title").textContent = t.login.title);
  byId("email") && (byId("email").placeholder = t.login.placeholderEmail);
  byId("password") && (byId("password").placeholder = t.login.placeholderPass);

  // شعار
  try{ const settings = await loadSettings(); setSimpleLogoImg("login-logo", settings, lang); }catch{}

  const form = byId("login-form");
  const errorEl = byId("login-error");
  if(!form) return;

  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    errorEl && errorEl.classList.add("hidden");

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
        if(errorEl){ errorEl.textContent = msg; errorEl.classList.remove("hidden"); }
        return;
      }

      localStorage.setItem("auth_token", data.token);
      localStorage.setItem("session_nonce", data.session_nonce);
      localStorage.setItem("user_email", data.email);
      localStorage.setItem("user_name", data.name || "");
      location.href = "app.html";
    }catch(err){
      if(errorEl){ errorEl.textContent = t.login.errorInvalid; errorEl.classList.remove("hidden"); }
    }
  });
}

/* ------------------------- Auth Helpers ------------------------- */
function isLoggedIn(){
  return !!localStorage.getItem("auth_token") && !!localStorage.getItem("session_nonce");
}
function logout(){
  localStorage.removeItem("auth_token");
  localStorage.removeItem("session_nonce");
  localStorage.removeItem("user_email");
  localStorage.removeItem("user_name");
  location.href = "login.html";
}
function requireAuthOrRedirect(){
  if(!isLoggedIn()){ alert(I18N[getLang()].app.loginRequired); location.href="login.html"; return false; }
  return true;
}

/* ------------------------- App Page ------------------------- */
async function withAuthFetch(url, options={}){
  const headers = new Headers(options.headers||{});
  headers.set("Content-Type","application/json");
  headers.set("x-auth-token", localStorage.getItem("auth_token")||"");
  headers.set("x-session-nonce", localStorage.getItem("session_nonce")||"");
  return fetch(url, { ...options, headers });
}

async function loadLastStateAndRender(){
  const email = localStorage.getItem("user_email") || "";
  if(!email) return;
  const res = await withAuthFetch(`/.netlify/functions/userState?email=${encodeURIComponent(email)}`);
  if(!res.ok) return;
  const data = await res.json();
  if(data?.last) renderRecipe(data.last, getLang());
}

function readAppInputs(lang){
  const dietSel = byId("diet");
  const diet = (dietSel && dietSel.value) || "balanced";
  const servings = parseInt(byId("servings").value || "2", 10);
  const time = parseInt(byId("time").value || "25", 10);
  const macros = byId("macros").value.trim() || (lang==="ar" ? "500/30/40/20" : "500/30/40/20");
  const ingredients = byId("ingredients").value.trim();
  return { diet, servings, time, macros, ingredients };
}

function renderRecipe(recipe, lang){
  const t = I18N[lang];
  const box = byId("recipe-box");
  if(!box) return;
  box.innerHTML = `
    <div class="p-4 rounded-2xl bg-white shadow">
      <div class="flex items-center justify-between mb-2">
        <h3 class="font-bold text-xl">${recipe.title}</h3>
        <div class="text-sm text-slate-600">${t.app.timeServ(recipe.time, recipe.servings)}</div>
      </div>
      <div class="grid md:grid-cols-3 gap-4">
        <div class="p-3 rounded-xl bg-slate-50">
          <div class="font-semibold mb-1">${t.app.macrosTitle}</div>
          <div class="text-sm">kcal: ${recipe.macros.calories}</div>
          <div class="text-sm">P: ${recipe.macros.protein} · C: ${recipe.macros.carbs} · F: ${recipe.macros.fats}</div>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 md:col-span-1">
          <div class="font-semibold mb-1">${t.app.ingTitle}</div>
          <ul class="list-disc pl-5 text-sm">
            ${recipe.ingredients.map(i=>`<li>${i.name} — ${i.quantity}</li>`).join("")}
          </ul>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 md:col-span-1 md:col-start-3">
          <div class="font-semibold mb-1">${t.app.stepsTitle}</div>
          <ol class="list-decimal pl-5 text-sm space-y-1">
            ${recipe.preparation.map(s=>`<li><strong>${s.title}:</strong> ${s.instruction}</li>`).join("")}
          </ol>
        </div>
      </div>
      <div class="mt-3 flex gap-2">
        <button id="btn-copy-json" class="px-3 py-2 rounded bg-slate-200">${t.app.copyJson}</button>
      </div>
    </div>
  `;
  byId("btn-copy-json").onclick = ()=> {
    const json = JSON.stringify(recipe, null, 2);
    navigator.clipboard.writeText(json).then(()=> {
      byId("btn-copy-json").textContent = (lang==="ar"?"تم النسخ!":"Copied!");
      setTimeout(()=> byId("btn-copy-json").textContent = t.app.copyJson, 1500);
    });
  };
}

function showAppError(msg){
  const alertEl = byId("app-alert");
  if(!alertEl) return;
  alertEl.textContent = msg;
  alertEl.classList.remove("hidden");
}

async function generateRecipeAndRender(){
  const lang = getLang();
  const email = localStorage.getItem("user_email") || "";
  const payload = { lang, email, ...readAppInputs(lang) };

  try{
    const res = await withAuthFetch("/.netlify/functions/generateRecipe", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(!res.ok || !data?.ok){
      showAppError(data?.message || I18N[lang].app.unableNow);
      return;
    }

    renderRecipe(data.recipe, lang);

    // حفظ "آخر نتيجة"
    await withAuthFetch("/.netlify/functions/userState", {
      method: "PUT",
      body: JSON.stringify({ email, last: data.recipe })
    });
  }catch(err){
    showAppError(I18N[lang].app.unableNow);
  }
}

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

  // حقول النموذج
  if(byId("lbl-diet")) byId("lbl-diet").textContent = t.app.lblDiet;
  if(byId("lbl-servings")) byId("lbl-servings").textContent = t.app.lblServings;
  if(byId("lbl-time")) byId("lbl-time").textContent = t.app.lblTime;
  if(byId("lbl-macros")) byId("lbl-macros").textContent = t.app.lblMacros;
  if(byId("lbl-ingredients")) byId("lbl-ingredients").textContent = t.app.lblIngr;

  // تعبئة قائمة الأنظمة من settings
  try{
    const settings = await loadSettings();
    const dietSel = byId("diet");
    if(dietSel && settings?.diets?.length){
      dietSel.innerHTML = settings.diets.map(d=>{
        const label = (lang==="ar"?d.name_ar:d.name_en)||d.id;
        return `<option value="${d.id}">${label}</option>`;
      }).join("");
    }
  }catch{}

  // أزرار
  if(byId("btn-generate")){
    byId("btn-generate").textContent = t.app.btnGenerate;
    byId("btn-generate").onclick = generateRecipeAndRender;
  }
  if(byId("btn-load-last")){
    byId("btn-load-last").textContent = t.app.btnLoadLast;
    byId("btn-load-last").onclick = loadLastStateAndRender;
  }
  if(byId("btn-logout")){
    byId("btn-logout").textContent = t.app.btnLogout;
    byId("btn-logout").onclick = logout;
  }

  // تحميل آخر حالة (إن وُجدت)
  await loadLastStateAndRender();
}

/* ------------------------- Admin Page ------------------------- */
async function initAdminPage(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initAdminPage);
  const t = I18N[lang];

  // شعار ونص
  try{
    const settings = await loadSettings();
    setSimpleLogoImg("admin-logo", settings, lang);
    byId("admin-site-name") && (byId("admin-site-name").textContent = settings?.branding?.[`site_name_${lang}`] || "WasfaOne");
  }catch{}

  byId("admin-home-link") && (byId("admin-home-link").textContent = t.home);
  byId("admin-gate-title") && (byId("admin-gate-title").textContent = t.admin.gateTitle);
  byId("admin-gate-sub") && (byId("admin-gate-sub").textContent = t.admin.gateSub);

  const keyInput = byId("admin-key-input");
  const gateError = byId("admin-gate-error");
  const panels = byId("admin-panels");
  const gate = byId("admin-gate");

  const savedKey = sessionStorage.getItem("admin_key");
  if(savedKey){ await openAdmin(savedKey); }

  byId("admin-key-save")?.addEventListener("click", async ()=>{
    const k = keyInput.value.trim();
    await openAdmin(k);
  });

  async function openAdmin(k){
    const ok = await fetch("/.netlify/functions/adminSettings", { headers: { "x-admin-key": k }}).then(r=>r.ok).catch(()=>false);
    if(!ok){
      if(gateError){ gateError.textContent = (lang==="ar"?"مفتاح أدمن غير صحيح.":"Invalid admin key."); gateError.classList.remove("hidden"); }
      return;
    }
    sessionStorage.setItem("admin_key", k);
    gate?.classList.add("hidden");
    panels?.classList.remove("hidden");
    initTabs();
    await loadUsers();
    await loadSettingsEditor();
    await loadImagesEditor();
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
    byId("users-title")      && (byId("users-title").textContent = t.admin.users);
    byId("settings-title")   && (byId("settings-title").textContent = t.admin.settings);
    byId("images-title")     && (byId("images-title").textContent = t.admin.images);
    byId("btn-add-user")     && (byId("btn-add-user").textContent = t.admin.add);
    byId("btn-save-settings")&& (byId("btn-save-settings").textContent = t.admin.save);
    byId("btn-save-images")  && (byId("btn-save-images").textContent = t.admin.save);
  }

  /* -------- Users CRUD -------- */
  async function loadUsers(){
    const key = sessionStorage.getItem("admin_key");
    const res = await fetch("/.netlify/functions/adminUsers", { headers: { "x-admin-key": key } });
    const data = await res.json();
    const tbody = byId("users-tbody");
    if(!tbody) return;
    tbody.innerHTML = "";
    (data?.users || []).forEach((u, idx)=>{
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input class="inp border rounded px-2 py-1" data-f="email" value="${u.email}"></td>
        <td><input class="inp border rounded px-2 py-1" data-f="name" value="${u.name||""}"></td>
        <td><input class="inp border rounded px-2 py-1" data-f="password" type="password" placeholder="••••••" value="${u.password||""}"></td>
        <td><input class="inp border rounded px-2 py-1" data-f="status" value="${u.status||"active"}"></td>
        <td><input class="inp border rounded px-2 py-1" data-f="start_date" value="${u.start_date||""}"></td>
        <td><input class="inp border rounded px-2 py-1" data-f="end_date" value="${u.end_date||""}"></td>
        <td><span class="px-2 py-1 rounded bg-slate-200 text-xs">${u.device_fingerprint? "bound":"—"}</span></td>
        <td class="space-x-2">
           <button class="btn bg-red-500 text-white px-3 py-1 rounded save">${t.admin.save}</button>
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

    byId("btn-add-user")?.addEventListener("click", async ()=>{
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
    });

    function rowToUser(tr){
      const g = f => tr.querySelector(`[data-f="${f}"]`).value.trim();
      return {
        email: g("email"),
        name: g("name"),
        password: g("password"), // مهم: يسمح بتعديل كلمة المرور
        status: g("status"),
        start_date: g("start_date"),
        end_date: g("end_date")
      };
    }
  }

  /* -------- Settings Editor -------- */
  async function loadSettingsEditor(){
    const key = sessionStorage.getItem("admin_key");
    const res = await fetch("/.netlify/functions/adminSettings", { headers: { "x-admin-key": key } });
    const data = await res.json();
    const s = data?.settings || {};

    const get = id => byId(id);
    get("site_name_ar") && (get("site_name_ar").value = s?.branding?.site_name_ar || "");
    get("site_name_en") && (get("site_name_en").value = s?.branding?.site_name_en || "");
    get("logo_url")     && (get("logo_url").value     = s?.branding?.logo_url || "");
    get("phone_display")&& (get("phone_display").value= s?.contact?.phone_display || "");
    get("whatsapp_link")&& (get("whatsapp_link").value= s?.contact?.whatsapp_link || "");
    get("email_contact")&& (get("email_contact").value= s?.contact?.email_contact || s?.contact?.email || "");

    const dietWrap = byId("diet-list-editor");
    if(dietWrap){
      dietWrap.innerHTML = (s?.diets||[]).map((d,i)=>`
        <div class="grid md:grid-cols-4 gap-2">
          <input class="inp border rounded px-2 py-1" data-k="id"       value="${d.id||""}" placeholder="id">
          <input class="inp border rounded px-2 py-1" data-k="name_ar"  value="${d.name_ar||""}" placeholder="name_ar">
          <input class="inp border rounded px-2 py-1" data-k="name_en"  value="${d.name_en||""}" placeholder="name_en">
          <button class="btn bg-slate-200 px-3 py-1 rounded" data-act="del" data-i="${i}">Delete</button>
        </div>
      `).join("");

      dietWrap.querySelectorAll('[data-act="del"]').forEach(btn=>{
        btn.addEventListener("click", ()=>{
          const idx = parseInt(btn.dataset.i,10);
          const arr = s.diets || [];
          arr.splice(idx,1);
          s.diets = arr;
          loadSettingsEditor(); // إعادة رسم
        });
      });

      byId("btn-add-diet")?.addEventListener("click", ()=>{
        s.diets = s.diets || [];
        s.diets.push({ id:"balanced", name_ar:"نظام متوازن", name_en:"Balanced" });
        loadSettingsEditor();
      });
    }

    byId("settings-form")?.addEventListener("submit", async (e)=>{
      e.preventDefault();
      // تحديث s من المدخلات
      s.branding = s.branding || {};
      s.contact  = s.contact || {};
      s.branding.site_name_ar = get("site_name_ar")?.value || "";
      s.branding.site_name_en = get("site_name_en")?.value || "";
      s.branding.logo_url     = get("logo_url")?.value || "";
      s.contact.phone_display = get("phone_display")?.value || "";
      s.contact.whatsapp_link = get("whatsapp_link")?.value || "";
      s.contact.email_contact = get("email_contact")?.value || "";

      // تحقق روابط
      const urls = [s.branding.logo_url, s.contact.whatsapp_link, ...Object.values(s.images||{})].filter(Boolean);
      if(!urls.every(isValidHttpUrl)){
        const el = byId("settings-status");
        if(el){ el.textContent = I18N[getLang()].admin.invalidUrl; el.className="text-red-600"; }
        return;
      }

      const saveRes = await fetch("/.netlify/functions/adminSettings", {
        method: "PUT",
        headers: { "Content-Type":"application/json", "x-admin-key": key },
        body: JSON.stringify({ settings: s })
      });
      const ok = saveRes.ok;
      const el = byId("settings-status");
      if(el){
        el.textContent = ok ? (getLang()==="ar"?"تم الحفظ":"Saved") : "Failed";
        el.className = ok ? "text-green-600" : "text-red-600";
      }
    });
  }

  /* -------- Images Editor -------- */
  async function loadImagesEditor(){
    // حمل الإعدادات الحالية لعرض صور/Alt
    const key = sessionStorage.getItem("admin_key");
    const res = await fetch("/.netlify/functions/adminSettings", { headers: { "x-admin-key": key } });
    const data = await res.json();
    const s = data?.settings || {};
    s.images = s.images || {};
    s.images_meta = s.images_meta || {};

    const grid = byId("images-grid");
    if(!grid) return;

    const entries = Object.keys(s.images).length ? Object.keys(s.images) : ["hero_primary","hero_secondary","logo_fallback"];
    grid.innerHTML = entries.map(k=>{
      const url = s.images[k] || "";
      const meta = s.images_meta[k] || {};
      const altAr = meta.alt_ar || "";
      const altEn = meta.alt_en || "";
      const vUrl = url ? `${url}${url.includes("?")?"&":"?"}v=${Date.now()}` : "";
      return `
        <div class="p-3 rounded-xl bg-white shadow space-y-2">
          <div class="text-sm font-semibold">${k}</div>
          <img class="w-full h-32 object-cover rounded" src="${vUrl}" alt="${altEn||altAr||k}">
          <input class="inp border rounded px-2 py-1" data-k="${k}" data-field="url" placeholder="https://..." value="${url}">
          <input class="inp border rounded px-2 py-1" data-k="${k}" data-field="alt_ar" placeholder="alt_ar" value="${altAr}">
          <input class="inp border rounded px-2 py-1" data-k="${k}" data-field="alt_en" placeholder="alt_en" value="${altEn}">
        </div>
      `;
    }).join("");

    byId("images-form")?.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const inputs = grid.querySelectorAll("input[data-k]");
      inputs.forEach(inp=>{
        const key = inp.getAttribute("data-k");
        const f   = inp.getAttribute("data-field");
        if(f==="url"){ s.images[key] = inp.value.trim(); }
        else {
          s.images_meta[key] = s.images_meta[key] || {};
          s.images_meta[key][f] = inp.value.trim();
        }
      });

      // تحقق روابط
      const urls = Object.values(s.images||{}).filter(Boolean);
      if(!urls.every(isValidHttpUrl)){
        const el = byId("images-status");
        if(el){ el.textContent = I18N[getLang()].admin.invalidUrl; el.className="text-red-600"; }
        return;
      }

      const saveRes = await fetch("/.netlify/functions/adminSettings", {
        method: "PUT",
        headers: { "Content-Type":"application/json", "x-admin-key": key },
        body: JSON.stringify({ settings: s })
      });
      const ok = saveRes.ok;
      const el = byId("images-status");
      if(el){
        el.textContent = ok ? (getLang()==="ar"?"تم الحفظ":"Saved") : "Failed";
        el.className = ok ? "text-green-600" : "text-red-600";
      }
    });
  }
}

/* ------------------------- Privacy & 404 ------------------------- */
async function initPrivacyPage(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initPrivacyPage);
  const t = I18N[lang].privacy;
  byId("privacy-title") && (byId("privacy-title").textContent = t.title);
  byId("privacy-content") && (byId("privacy-content").textContent = t.content);
  byId("privacy-home") && (byId("privacy-home").textContent = t.backHome);
}
function init404Page(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(init404Page);
  const t = I18N[lang].notfound;
  byId("nf-text") && (byId("nf-text").textContent = t.text);
  byId("nf-home") && (byId("nf-home").textContent = t.home);
}

/* ------------------------- Expose to window ------------------------- */
window.loadIndexPage   = loadIndexPage;
window.initLoginPage   = initLoginPage;
window.initAppPage     = initAppPage;
window.initAdminPage   = initAdminPage;
window.initPrivacyPage = initPrivacyPage;
window.init404Page     = init404Page;
