/* /public/assets/app.js
 * واجهة WasfaOne — توليد وصفات + التعامل مع التجربة 7 أيام والحد اليومي
 * - يقرأ بيانات الجلسة من localStorage (تم حفظها بعد login)
 * - يرسل الطلب إلى /.netlify/functions/generateRecipe مع الرؤوس الأمنية
 * - يعرض الردود الودية عند انتهاء التجربة/بلوغ الحد اليومي
 */

(function(){
  "use strict";

  /* ---------- عناصر الواجهة ---------- */
  const el = (id) => document.getElementById(id);

  const planBadge   = el("planBadge");
  const trialInfo   = el("trialInfo");
  const statusBar   = el("statusBar");
  const errorBar    = el("errorBar");
  const generateBtn = el("generateBtn");
  const recipeOut   = el("recipeOut");

  const mealTypeSelect   = el("mealTypeSelect");
  const cuisineSelect    = el("cuisineSelect");
  const dietTypeSelect   = el("dietTypeSelect");
  const caloriesInput    = el("caloriesInput");
  const allergiesInput   = el("allergiesInput");
  const availableInput   = el("availableInput");

  /* ---------- أدوات صغيرة ---------- */
  const show  = (node, msg, ok=true) => {
    if(!node) return;
    node.textContent = msg || "";
    node.classList.toggle("hidden", !msg);
    if(node === statusBar){
      node.classList.toggle("bg-emerald-50", !!msg && ok);
      node.classList.toggle("text-emerald-800", !!msg && ok);
      node.classList.toggle("dark:bg-emerald-900/30", !!msg && ok);
      node.classList.toggle("dark:text-emerald-200", !!msg && ok);
    }
    if(node === errorBar){
      node.classList.toggle("bg-rose-50", !!msg && !ok);
      node.classList.toggle("text-rose-800", !!msg && !ok);
      node.classList.toggle("dark:bg-rose-900/30", !!msg && !ok);
      node.classList.toggle("dark:text-rose-200", !!msg && !ok);
    }
  };
  const fmtDate = (s) => String(s||"").trim();
  const toList  = (txt) => {
    if(!txt) return [];
    // يفصل على الفواصل العربية/الإنجليزية + الأسطر
    return String(txt).split(/[,،\n]/).map(x => x.trim()).filter(Boolean);
  };
  const htmlEscape = (s) => String(s||"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#039;");

  /* ---------- حالة الجلسة من localStorage ---------- */
  function getSession(){
    try{
      return {
        token: localStorage.getItem("auth_token") || "",
        nonce: localStorage.getItem("session_nonce") || "",
        name:  localStorage.getItem("user_name") || "",
        email: localStorage.getItem("user_email") || "",
        plan:  localStorage.getItem("plan") || "", // قد لا تكون مخزّنة إذا لم نعدّل login.html بعد
        trial_expires_at: localStorage.getItem("trial_expires_at") || "",
        daily_limit: localStorage.getItem("daily_limit") || "",
        used_today: localStorage.getItem("used_today") || "",
        last_reset: localStorage.getItem("last_reset") || ""
      };
    }catch{ return { token:"", nonce:"" }; }
  }

  function badgeForPlan(plan){
    const p = String(plan||"").toLowerCase();
    if (p === "monthly") {
      planBadge.textContent = "Monthly";
      planBadge.classList.remove("badge-trial","badge-year");
      planBadge.classList.add("badge-month");
    } else if (p === "yearly") {
      planBadge.textContent = "Yearly";
      planBadge.classList.remove("badge-trial","badge-month");
      planBadge.classList.add("badge-year");
    } else {
      planBadge.textContent = "Trial";
      planBadge.classList.remove("badge-month","badge-year");
      planBadge.classList.add("badge-trial");
    }
  }

  function renderTrialInfo(plan, trial_expires_at){
    const p = String(plan||"").toLowerCase();
    if (p === "trial" && trial_expires_at) {
      trialInfo.textContent = `التجربة تنتهي في: ${fmtDate(trial_expires_at)} (توقيت دبي)`;
    } else {
      trialInfo.textContent = "";
    }
  }

  /* ---------- عرض الوصفة الناتجة ---------- */
  function renderRecipe(rec){
    if(!rec || typeof rec !== "object"){
      recipeOut.innerHTML = `<div class="text-sm opacity-70">لم يتم توليد وصفة بعد.</div>`;
      return;
    }
    const title = htmlEscape(rec.title);
    const servings = Number(rec.servings)||1;
    const tmin = Number(rec.total_time_min)||0;

    const m = rec.macros||{};
    const kcal = Number(m.calories)||0;
    const p = Number(m.protein_g)||0;
    const c = Number(m.carbs_g)||0;
    const f = Number(m.fat_g)||0;

    const ings = Array.isArray(rec.ingredients)?rec.ingredients:[];
    const steps = Array.isArray(rec.steps)?rec.steps:[];
    const gramsHint = rec._ingredients_gram_coverage ? `<span class="text-xs opacity-70">(${htmlEscape(rec._ingredients_gram_coverage)} تغطية جرام)</span>`:"";

    recipeOut.innerHTML = `
      <div class="space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h3 class="text-xl font-extrabold">${title}</h3>
          <div class="text-sm opacity-80">حصص: ${servings} • الوقت: ${tmin} دقيقة</div>
        </div>

        <div class="grid sm:grid-cols-4 gap-2 text-sm">
          <div class="p-3 rounded-md border border-slate-200 dark:border-slate-700">
            <div class="opacity-60">سعرات/حصة</div>
            <div class="font-bold">${kcal} kcal</div>
          </div>
          <div class="p-3 rounded-md border border-slate-200 dark:border-slate-700">
            <div class="opacity-60">بروتين</div>
            <div class="font-bold">${p} جم</div>
          </div>
          <div class="p-3 rounded-md border border-slate-200 dark:border-slate-700">
            <div class="opacity-60">صافي الكارب</div>
            <div class="font-bold">${c} جم</div>
          </div>
          <div class="p-3 rounded-md border border-slate-200 dark:border-slate-700">
            <div class="opacity-60">دهون</div>
            <div class="font-bold">${f} جم</div>
          </div>
        </div>

        <div>
          <h4 class="font-bold mb-1">المكوّنات ${gramsHint}</h4>
          <ul class="list-disc pr-5 space-y-1 text-sm">
            ${ings.map(x => `<li>${htmlEscape(String(x||""))}</li>`).join("")}
          </ul>
        </div>

        <div>
          <h4 class="font-bold mb-1">الخطوات</h4>
          <ol class="list-decimal pr-5 space-y-1 text-sm">
            ${steps.map(x => `<li>${htmlEscape(String(x||""))}</li>`).join("")}
          </ol>
        </div>
      </div>
    `;
  }

  /* ---------- التعامل مع رسائل التجربة/الترقية ---------- */
  function showTrialExpired(){
    const cta = `
      <div class="mt-2 flex flex-wrap gap-2">
        <a class="btn px-3 py-1.5 rounded-md bg-[color:var(--primary)] text-white text-sm" href="/public/index.html#plans">الترقية الآن</a>
        <a class="btn px-3 py-1.5 rounded-md bg-green-600 text-white text-sm" id="errWA" target="_blank">WhatsApp</a>
      </div>
    `;
    show(errorBar, "انتهت فترة التجربة المجانية. للمتابعة يرجى الترقية (شهري 29 درهم / سنوي 25 درهم/شهر).", false);
    errorBar.insertAdjacentHTML("beforeend", cta);
    wireWhatsApp("errWA");
  }

  function showTrialDailyLimit(){
    const cta = `
      <div class="mt-2 flex flex-wrap gap-2">
        <a class="btn px-3 py-1.5 rounded-md bg-[color:var(--primary)] text-white text-sm" href="/public/index.html#plans">الترقية الآن</a>
        <a class="btn px-3 py-1.5 rounded-md bg-green-600 text-white text-sm" id="errWA" target="_blank">WhatsApp</a>
      </div>
    `;
    show(errorBar, "لقد وصلت للحد اليومي للوصفات في فترة التجربة. قم بالترقية للحصول على وصفات غير محدودة.", false);
    errorBar.insertAdjacentHTML("beforeend", cta);
    wireWhatsApp("errWA");
  }

  async function wireWhatsApp(id){
    try{
      const r = await fetch("/data/settings.json?ts="+Date.now(), { cache:"no-store" });
      const s = await r.json();
      const wa = s?.contact?.whatsapp_link || "#";
      const a = document.getElementById(id);
      if(a) a.href = wa;
    }catch{/* ignore */}
  }

  /* ---------- إرسال طلب التوليد ---------- */
  async function generate(){
    show(statusBar, "");
    show(errorBar, "");

    const session = getSession();
    if(!session.token || !session.nonce){
      show(errorBar, "هذه الجلسة غير صالحة. يُرجى تسجيل الدخول مرة أخرى.", false);
      return;
    }

    generateBtn.disabled = true;
    generateBtn.textContent = "جاري التوليد ...";

    // نبني المدخلات
    const mealType    = mealTypeSelect?.value || "وجبة";
    const cuisine     = cuisineSelect?.value || "متنوع";
    const dietType    = dietTypeSelect?.value || "balanced";
    const caloriesRaw = Number(caloriesInput?.value||0);
    const allergies   = toList(allergiesInput?.value);
    const available   = toList(availableInput?.value);

    const payload = {
      mealType,
      cuisine,
      dietType,
      caloriesTarget: caloriesRaw > 0 ? Math.floor(caloriesRaw) : 0,
      allergies,
      availableIngredients: available
    };

    try{
      const res = await fetch("/.netlify/functions/generateRecipe", {
        method: "POST",
        headers: {
          "Content-Type":"application/json",
          "X-Auth-Token": session.token,
          "X-Session-Nonce": session.nonce
        },
        body: JSON.stringify(payload)
      });

      const code = res.status;
      const data = await res.json().catch(()=>({ ok:false, error:"bad_json" }));

      if(code === 403 && (data?.error === "trial_expired")){
        showTrialExpired();
        recipeOut.innerHTML = `<div class="text-sm opacity-70">لا يمكن التوليد: انتهت التجربة.</div>`;
        return;
      }
      if(code === 403 && (data?.error === "trial_daily_limit_reached")){
        showTrialDailyLimit();
        recipeOut.innerHTML = `<div class="text-sm opacity-70">لا يمكن التوليد: تم بلوغ الحد اليومي للتجربة اليوم.</div>`;
        return;
      }

      if(!res.ok || !data.ok){
        const msg = data?.message_ar || "تعذّر إتمام الطلب. حاول لاحقًا.";
        show(errorBar, msg, false);
        return;
      }

      // نجاح — عرض الوصفة
      renderRecipe(data.recipe);
      show(statusBar, "تم توليد الوصفة بنجاح ✅", true);

    } catch(e){
      show(errorBar, "حدث خطأ غير متوقع. يرجى المحاولة لاحقًا.", false);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "توليد وصفة";
    }
  }

  /* ---------- تهيئة الصفحة ---------- */
  async function init(){
    // شارة الخطة من localStorage (قد لا تتوفّر حتى نعدّل login.html لحفظها)
    const s = getSession();
    badgeForPlan(s.plan || "trial");
    renderTrialInfo(s.plan || "trial", s.trial_expires_at || "");

    // تأمين زر واتساب في كروت الأخطاء/الهيدر (إن وُجد)
    wireWhatsApp("ctaWhatsApp");

    // زر توليد
    generateBtn?.addEventListener("click", generate);

    // عرض افتراضي
    renderRecipe(null);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
