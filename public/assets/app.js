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
function getLang(){
  return localStorage.getItem("lang") || "ar";
}
function setLang(lang){
  localStorage.setItem("lang", lang);
  applyLangToDocument(lang);
}

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

/* Bind a generic language toggle (exists on most pages) */
function bindLangToggle(pageInitFn){
  const btn = document.getElementById("lang-toggle");
  if(!btn) return;
  btn.addEventListener("click", ()=>{
    const newLang = getLang()==="ar" ? "en" : "ar";
    setLang(newLang);
    pageInitFn && pageInitFn(); // re-render page texts fully
  });
}

/* ------------------------- Settings Loader ------------------------- */
async function loadSettings(){
  const res = await fetch("/data/settings.json", { cache: "no-store" });
  if(!res.ok) throw new Error("settings");
  return res.json();
}

/* ------------------------- Common Elements Fillers ------------------------- */
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

/* URL validator: http/https only */
function isValidHttpUrl(u){
  try{
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:";
  }catch{ return false; }
}

/* ------------------------- Index Page ------------------------- */
async function loadIndexPage(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(loadIndexPage);
  const t = I18N[lang];

  const settings = await loadSettings();

  // Logo & site name
  setLogo("logo", settings, lang);

  // Hero
  const heroUrl = settings?.images?.hero_primary || "";
  const heroAlt = settings?.images_meta?.hero_primary?.[`alt_${lang}`] || "";
  const heroImg = byId("hero-img");
  if (heroImg){ heroImg.src = heroUrl; heroImg.alt = heroAlt; }

  byId("hero-title")?.append(settings?.branding?.[`site_name_${lang}`] || "WasfaOne");

  // Features (3 shown per spec; we’ll use first three & a 4th under)
  const featImgs = [
    settings?.images?.features_card_1,
    settings?.images?.features_card_2,
    settings?.images?.features_card_3
  ];
  const featAlts = [
    settings?.images_meta?.features_card_1?.[`alt_${lang}`],
    settings?.images_meta?.features_card_2?.[`alt_${lang}`],
    settings?.images_meta?.features_card_3?.[`alt_${lang}`],
  ];
  for(let i=1;i<=3;i++){
    const imgEl = byId(`feature-img-${i}`);
    const titleEl = byId(`feature-title-${i}`);
    const descEl = byId(`feature-desc-${i}`);
    if(imgEl){ imgEl.src = featImgs[i-1] || ""; imgEl.alt = featAlts[i-1] || ""; }
    if(titleEl) titleEl.textContent = t.features[i-1].title;
    if(descEl) descEl.textContent  = t.features[i-1].desc;
  }

  // Diet systems list
  byId("diet-title").textContent = t.dietTitle;
  const dietWrap = byId("diet-list");
  dietWrap.innerHTML = "";
  (settings?.diet_systems || []).forEach(d => {
    const el = document.createElement("div");
    el.className = "card";
    const name = d[`name_${lang}`] || d.name_en || d.name_ar;
    const desc = d[`description_${lang}`] || d.description_en || d.description_ar || "";
    el.innerHTML = `<div class="font-bold mb-1">${name}</div><div class="text-sm text-slate-600 dark:text-slate-300">${desc}</div>`;
    dietWrap.appendChild(el);
  });

  // Contact
  const phone = settings?.contact?.phone_display || "00971502061209";
  const wa = settings?.contact?.whatsapp_link || "https://wa.me/971502061209";
  const mail = settings?.contact?.email || "info@example.com";
  byId("contact-info").innerHTML = `${phone} · <a class="underline-offset" href="${wa}" target="_blank">${t.contactWhats}</a> · <a href="mailto:${mail}" class="underline-offset">${mail}</a>`;
  const waBtn = byId("whatsapp-btn"); if(waBtn) waBtn.href = wa;
}

/* ------------------------- Device Fingerprint ------------------------- */
function getOrCreateDeviceId(){
  let id = localStorage.getItem("device_id");
  if(!id){
    id = crypto.randomUUID();
    localStorage.setItem("device_id", id);
  }
  return id;
}
async function sha256Hex(str){
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  const bytes = Array.from(new Uint8Array(buf));
  return bytes.map(b => b.toString(16).padStart(2,"0")).join("");
}
async function computeDeviceFingerprintHash(){
  const id = getOrCreateDeviceId();
  const nav = window.navigator;
  const scr = window.screen;
  const tz = new Date().getTimezoneOffset();
  const parts = [
    id, nav.userAgent, nav.language, scr.width, scr.height, scr.colorDepth, tz, nav.platform, nav.hardwareConcurrency
  ].join("|");
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

      // success
      localStorage.setItem("auth_token", data.token);
      localStorage.setItem("session_nonce", data.session_nonce);
      localStorage.setItem("user_email", data.email);
      localStorage.setItem("user_name", data.name);
      // persist chosen lang
      location.href = "app.html";
    }catch(err){
      errorEl.textContent = t.login.errorInvalid;
      errorEl.classList.remove("hidden");
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

/* ------------------------- App Page ------------------------- */
async function initAppPage(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initAppPage);
  const t = I18N[lang];

  if(!isLoggedIn()){
    alert(t.app.loginRequired);
    location.href = "login.html";
    return;
  }

  const settings = await loadSettings();

  // Header bits
  setSimpleLogoImg("app-logo", settings, lang);
  byId("app-site-name").textContent = settings?.branding?.[`site_name_${lang}`] || "WasfaOne";
  byId("app-home-link").textContent = t.home;

  // Hero image
  const hero = byId("app-hero");
  hero.src = settings?.images?.app_background || settings?.images?.hero_secondary || "";
  hero.alt = settings?.images_meta?.app_background?.[`alt_${lang}`] || "";

  // Texts
  byId("app-title").textContent = t.app.title;
  byId("app-subtitle").textContent = t.app.sub;
  byId("lbl-diet").textContent = t.app.lblDiet;
  byId("lbl-servings").textContent = t.app.lblServings;
  byId("lbl-time").textContent = t.app.lblTime;
  byId("lbl-macros").textContent = t.app.lblMacros;
  byId("lbl-ingredients").textContent = t.app.lblIngr;
  byId("btn-generate").textContent = t.app.btnGenerate;
  byId("btn-load-last").textContent = t.app.btnLoadLast;
  byId("btn-logout").textContent = t.app.btnLogout;
  byId("footer-privacy").textContent = lang==="ar" ? "سياسة الخصوصية" : "Privacy Policy";

  const uname = localStorage.getItem("user_name") || "";
  const uemail = localStorage.getItem("user_email") || "";
  byId("session-user").textContent = `${uname} <${uemail}>`;

  // Diet systems
  const dietSel = byId("diet-system");
  dietSel.innerHTML = "";
  (settings?.diet_systems || []).forEach(d => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d[`name_${lang}`] || d.name_en || d.name_ar;
    dietSel.appendChild(opt);
  });

  // Bind
  byId("btn-logout").addEventListener("click", logout);

  // Load last user state on open
  await loadLastStateAndRender();

  // Form submit → generate
  byId("recipe-form").addEventListener("submit", async (e)=>{
    e.preventDefault();
    await generateRecipeAndRender();
  });

  byId("btn-load-last").addEventListener("click", loadLastStateAndRender);
  byId("btn-copy-json").addEventListener("click", copyResultJson);
}

async function withAuthFetch(url, options={}){
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("x-auth-token", localStorage.getItem("auth_token") || "");
  headers.set("x-session-nonce", localStorage.getItem("session_nonce") || "");
  return fetch(url, { ...options, headers });
}

async function loadLastStateAndRender(){
  const lang = getLang();
  const email = localStorage.getItem("user_email");
  const res = await withAuthFetch(`/.netlify/functions/userState?email=${encodeURIComponent(email)}&lang=${lang}`, { method:"GET" });
  if(!res.ok) return; // no state yet
  const data = await res.json();
  if(data && data?.last){
    renderRecipe(data.last, lang);
  }
}

async function generateRecipeAndRender(){
  const lang = getLang();
  const email = localStorage.getItem("user_email");

  const payload = {
    lang,
    email,
    diet: byId("diet-system").value,
    servings: Number(byId("servings").value || 1),
    time: Number(byId("time").value || 15),
    macros: (byId("macros").value || "").trim(),
    ingredients: (byId("ingredients").value || "").trim(),
  };

  const res = await withAuthFetch("/.netlify/functions/generateRecipe", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if(!res.ok || !data?.ok){
    const msg = data?.message || I18N[lang].app.unableNow;
    showAppError(msg);
    return;
  }

  // Show & persist to user state
  renderRecipe(data.recipe, lang);

  await withAuthFetch("/.netlify/functions/userState", {
    method: "PUT",
    body: JSON.stringify({ email, lang, last: data.recipe })
  });
}

function showAppError(msg){
  const el = byId("app-error");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(()=> el.classList.add("hidden"), 4000);
}

function renderRecipe(recipe, lang){
  const t = I18N[lang];
  const card = byId("result-card");
  card.classList.remove("hidden");

  byId("res-title").textContent = recipe.title || "";
  byId("res-time-servings").textContent = t.app.timeServ(recipe.time, recipe.servings);

  // macros
  const m = recipe.macros || {};
  byId("res-macros").innerHTML = `
    <li>${(lang==="ar"?"سعرات":"Calories")}: ${m.calories ?? "-"}</li>
    <li>${(lang==="ar"?"بروتين":"Protein")}: ${m.protein ?? "-"}</li>
    <li>${(lang==="ar"?"كربوهيدرات":"Carbs")}: ${m.carbs ?? "-"}</li>
    <li>${(lang==="ar"?"دهون":"Fats")}: ${m.fats ?? "-"}</li>
  `;
  byId("res-macros-title").textContent = t.app.macrosTitle;

  // ingredients
  const ing = recipe.ingredients || [];
  byId("res-ingredients").innerHTML = ing.map(x=>`<li>${x.name} — ${x.quantity}</li>`).join("");
  byId("res-ingredients-title").textContent = t.app.ingTitle;

  // steps
  const steps = recipe.preparation || [];
  byId("res-steps").innerHTML = steps.map(s=>`<li><strong>${s.title}:</strong> ${s.instruction}</li>`).join("");

  // copy button label
  byId("btn-copy-json").textContent = t.app.copyJson;
}

async function copyResultJson(){
  const lang = getLang();
  const title = byId("res-title").textContent;
  if(!title){ return; }
  // reconstruct JSON from DOM (lightweight)
  const macrosLis = [...byId("res-macros").querySelectorAll("li")].map(li=>li.textContent);
  // Better: rely on last state stored:
  const email = localStorage.getItem("user_email");
  const res = await withAuthFetch(`/.netlify/functions/userState?email=${encodeURIComponent(email)}&lang=${lang}`, { method:"GET" });
  const data = await res.json();
  if(data?.last){
    const txt = JSON.stringify(data.last, null, 2);
    await navigator.clipboard.writeText(txt);
  }
}

/* ------------------------- Admin Page ------------------------- */
async function initAdminPage(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initAdminPage);
  const t = I18N[lang];
  const settings = await loadSettings();

  // header
  setSimpleLogoImg("admin-logo", settings, lang);
  byId("admin-site-name").textContent = settings?.branding?.[`site_name_${lang}`] || "WasfaOne";
  byId("admin-home-link").textContent = t.home;

  // gate texts
  byId("admin-gate-title").textContent = t.admin.gateTitle;
  byId("admin-gate-sub").textContent = t.admin.gateSub;

  // Save admin key in sessionStorage
  const keyInput = byId("admin-key-input");
  const gateError = byId("admin-gate-error");
  const panels = byId("admin-panels");
  const gate = byId("admin-gate");
  const savedKey = sessionStorage.getItem("admin_key");
  if(savedKey){ await openAdmin(savedKey); }
  byId("admin-key-save").addEventListener("click", async ()=>{
    const k = keyInput.value.trim();
    await openAdmin(k);
  });

  async function openAdmin(k){
    // simple probe to validate key by calling /adminSettings GET
    const ok = await fetch("/.netlify/functions/adminSettings", { headers: { "x-admin-key": k }}).then(r=>r.ok).catch(()=>false);
    if(!ok){ gateError.textContent = lang==="ar"?"مفتاح أدمن غير صحيح.":"Invalid admin key."; gateError.classList.remove("hidden"); return; }
    sessionStorage.setItem("admin_key", k);
    gate.classList.add("hidden"); panels.classList.remove("hidden");
    initTabs(); await loadUsers(); await loadSettingsEditor(); await loadImagesEditor();
  }

  /* Tabs */
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
      // actions
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
        status: g("status"),
        start_date: g("start_date"),
        end_date: g("end_date")
      };
    }
  }

  /* Settings Editor */
  async function loadSettingsEditor(){
    const key = sessionStorage.getItem("admin_key");
    const res = await fetch("/.netlify/functions/adminSettings", { headers: { "x-admin-key": key }});
    const data = await res.json();
    const s = data?.settings || {};

    byId("site_name_ar").value = s.branding?.site_name_ar || "WasfaOne";
    byId("site_name_en").value = s.branding?.site_name_en || "WasfaOne";
    byId("logo_url").value     = s.branding?.logo_url || "";

    byId("phone_display").value = s.contact?.phone_display || "";
    byId("whatsapp_link").value = s.contact?.whatsapp_link || "";
    byId("email_contact").value = s.contact?.email || "";

    const list = byId("diet-list-editor");
    list.innerHTML = "";
    (s.diet_systems||[]).forEach((d, idx)=>{
      const row = document.createElement("div");
      row.className = "card";
      row.innerHTML = `
        <div class="grid md:grid-cols-3 gap-2">
          <input class="inp" data-f="id" placeholder="id" value="${d.id}">
          <input class="inp" data-f="name_ar" placeholder="name_ar" value="${d.name_ar}">
          <input class="inp" data-f="name_en" placeholder="name_en" value="${d.name_en}">
          <input class="inp" data-f="description_ar" placeholder="description_ar" value="${d.description_ar}">
          <input class="inp" data-f="description_en" placeholder="description_en" value="${d.description_en}">
          <button class="btn bg-slate-200 rounded px-3" data-action="remove">Remove</button>
        </div>
      `;
      row.querySelector('[data-action="remove"]').onclick = ()=>{ row.remove(); };
      list.appendChild(row);
    });

    byId("btn-add-diet").onclick = ()=>{
      const row = document.createElement("div");
      row.className = "card";
      row.innerHTML = `
        <div class="grid md:grid-cols-3 gap-2">
          <input class="inp" data-f="id" placeholder="id">
          <input class="inp" data-f="name_ar" placeholder="name_ar">
          <input class="inp" data-f="name_en" placeholder="name_en">
          <input class="inp" data-f="description_ar" placeholder="description_ar">
          <input class="inp" data-f="description_en" placeholder="description_en">
          <button class="btn bg-slate-200 rounded px-3" data-action="remove">Remove</button>
        </div>
      `;
      row.querySelector('[data-action="remove"]').onclick = ()=>{ row.remove(); };
      list.appendChild(row);
    };

    byId("settings-form").onsubmit = async (e)=>{
      e.preventDefault();
      // build payload
      const diets = [...list.children].map(row=>{
        const g = f => row.querySelector(`[data-f="${f}"]`)?.value?.trim() || "";
        return {
          id: g("id"),
          name_ar: g("name_ar"),
          name_en: g("name_en"),
          description_ar: g("description_ar"),
          description_en: g("description_en")
        };
      });

      const payload = {
        ...s,
        branding: {
          site_name_ar: byId("site_name_ar").value.trim(),
          site_name_en: byId("site_name_en").value.trim(),
          logo_url: byId("logo_url").value.trim()
        },
        contact: {
          phone_display: byId("phone_display").value.trim(),
          whatsapp_link: byId("whatsapp_link").value.trim(),
          email: byId("email_contact").value.trim(),
          social: s.contact?.social || {}
        },
        diet_systems: diets
      };

      // minimal URL checks
      const urls = [payload.branding.logo_url, payload.contact.whatsapp_link];
      if(!urls.every(u => !u || isValidHttpUrl(u))){
        byId("settings-status").textContent = t.admin.invalidUrl; return;
      }

      const key = sessionStorage.getItem("admin_key");
      const r = await fetch("/.netlify/functions/adminSettings", {
        method: "PUT",
        headers: { "Content-Type":"application/json", "x-admin-key": key },
        body: JSON.stringify({ settings: payload })
      });
      byId("settings-status").textContent = r.ok ? t.admin.saved : "Error";
      // cache-busting for logo
      if (payload.branding.logo_url) payload.branding.logo_url += `?v=${Date.now()}`;
    };
  }

  /* Images Editor */
  async function loadImagesEditor(){
    const key = sessionStorage.getItem("admin_key");
    const res = await fetch("/.netlify/functions/adminSettings", { headers: { "x-admin-key": key }});
    const data = await res.json();
    const s = data?.settings || {};

    const grid = byId("images-grid");
    grid.innerHTML = "";
    const imgs = s.images || {};
    const metas = s.images_meta || {};
    Object.keys(imgs).forEach(k=>{
      const url = imgs[k] || "";
      const meta = metas[k] || {};
      const ar = meta.alt_ar || "";
      const en = meta.alt_en || "";
      const frame = document.createElement("div");
      frame.className = "img-frame p-3";
      frame.innerHTML = `
        <div class="mb-2 font-bold">${k}</div>
        <img src="${url}" alt="${ar||en||k}">
        <div class="grid md:grid-cols-2 gap-2 mt-2">
          <input class="inp" data-f="url" placeholder="URL" value="${url}">
          <input class="inp" data-f="alt_ar" placeholder="alt_ar" value="${ar}">
          <input class="inp" data-f="alt_en" placeholder="alt_en" value="${en}">
        </div>
      `;
      grid.appendChild(frame);
    });

    byId("images-form").onsubmit = async (e)=>{
      e.preventDefault();
      const frames = [...grid.children];
      const images = {};
      const images_meta = {};
      for(const f of frames){
        const keyName = f.querySelector(".font-bold").textContent.trim();
        const url = f.querySelector('[data-f="url"]').value.trim();
        const alt_ar = f.querySelector('[data-f="alt_ar"]').value.trim();
        const alt_en = f.querySelector('[data-f="alt_en"]').value.trim();
        if(url && !isValidHttpUrl(url)){ byId("images-status").textContent = I18N[getLang()].admin.invalidUrl; return; }
        images[keyName] = url ? `${url}?v=${Date.now()}` : "";
        images_meta[keyName] = { alt_ar, alt_en };
      }
      const payload = { ...(data.settings||{}), images, images_meta };
      const key = sessionStorage.getItem("admin_key");
      const r = await fetch("/.netlify/functions/adminSettings", {
        method: "PUT",
        headers: { "Content-Type":"application/json", "x-admin-key": key },
        body: JSON.stringify({ settings: payload })
      });
      byId("images-status").textContent = r.ok ? I18N[getLang()].admin.saved : "Error";
    };
  }
}

/* ------------------------- Privacy Page ------------------------- */
async function initPrivacyPage(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initPrivacyPage);
  const t = I18N[lang];
  const s = await loadSettings();

  setSimpleLogoImg("privacy-logo", s, lang);
  byId("privacy-site-name").textContent = s?.branding?.[`site_name_${lang}`] || "WasfaOne";
  byId("privacy-home-link").textContent = I18N[lang].home;

  byId("privacy-title").textContent = t.privacy.title;
  byId("privacy-content").textContent = t.privacy.content;
  byId("privacy-back-home").textContent = t.privacy.backHome;
}

/* ------------------------- 404 Page ------------------------- */
function init404Page(){
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(init404Page);
  const t = I18N[lang];
  byId("notfound-text").textContent = t.notfound.text;
  byId("notfound-home").textContent = t.notfound.home;
}

/* ------------------------- Expose to window ------------------------- */
window.loadIndexPage   = loadIndexPage;
window.initLoginPage   = initLoginPage;
window.initAppPage     = initAppPage;
window.initAdminPage   = initAdminPage;
window.initPrivacyPage = initPrivacyPage;
window.init404Page     = init404Page;
