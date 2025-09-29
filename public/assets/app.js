/* WasfaOne Frontend — Single-file vanilla JS */

const I18N = {
  ar: {
    toggle: "EN",
    loading: "جاري توليد الوصفة...",
    needLogin: "الرجاء تسجيل الدخول",
    invalid: "مدخلات غير صالحة",
    copied: "تم النسخ",
    friendlyErr: "تعذر توليد الوصفة حاليًا. يرجى التأكد من إعداد مفتاح API في الخلفية.",
  },
  en: {
    toggle: "ع",
    loading: "Generating Recipe...",
    needLogin: "Please login",
    invalid: "Invalid input",
    copied: "Copied",
    friendlyErr: "Unable to generate a recipe right now. Please ensure your backend API key is set up.",
  }
};

function byId(id){ return document.getElementById(id); }
function qs(sel, root=document){ return root.querySelector(sel); }
function setHtml(id, h){ const el = byId(id); if(el) el.innerHTML = h; }
function show(el){ if(typeof el==="string") el = byId(el); if(el) el.classList.remove("hidden"); }
function hide(el){ if(typeof el==="string") el = byId(el); if(el) el.classList.add("hidden"); }
function safeJSON(o){ return JSON.stringify(o, null, 2); }
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
function alertBox(text){
  const el = byId("app-alert"); if(!el) return;
  // Use a dedicated status message area for the new design
  const statusEl = byId("statusMsg");
  if(statusEl) {
    statusEl.textContent = text;
    if(text) statusEl.classList.remove("hidden"); else statusEl.classList.add("hidden");
  }
}
async function loadSettings(){ const r = await fetch("/data/settings.json", { cache:"no-store" }); if(!r.ok) throw new Error("settings_failed"); return r.json(); }
function requireAuthOrRedirect(){
  // تم تبسيط هذا لافتراض مصادقة ناجحة سلفًا، أو يجب أن يكون لديك صفحة login.html
  const email = localStorage.getItem("user_email");
  if(!email){ 
    console.error("User email missing. Assuming logged out state.");
    return false; // يمنع استدعاء الدالة الخلفية بدون بيانات أساسية
  }
  return true;
}

// دالة جديدة لتنسيق بيانات الوصفة من generateRecipe.js وعرضها
function renderRecipe(r, lang){
  const T = I18N[lang];
  
  // يتم استخدام بنية البيانات التي تتوقعها دالة generateRecipe.js
  const recipe = {
      title: r.title || T.invalid,
      time: r.total_time_min || 0,
      servings: r.servings || 0,
      calories: r.macros?.calories || 0,
      protein: r.macros?.protein_g || 0,
      carbs: r.macros?.carbs_g || 0,
      fats: r.macros?.fat_g || 0,
      ingredients: r.ingredients || [],
      steps: r.steps || []
  };

  byId('recipeTitle').textContent = recipe.title;
  byId('timeValue').textContent = `${recipe.time} min`;
  byId('servingsValue').textContent = `${recipe.servings}`;

  byId('caloriesValue').textContent = `${recipe.calories}`;
  byId('proteinValue').textContent = `${recipe.protein} جم`;
  byId('carbsValue').textContent = `${recipe.carbs} جم`;
  byId('fatsValue').textContent = `${recipe.fats} جم`;

  const ingredientsList = byId('ingredientsList');
  ingredientsList.innerHTML = '';
  recipe.ingredients.forEach(ingredient => {
      const li = document.createElement('li');
      // نفترض أن المكونات هي نصوص فقط من generateRecipe.js
      li.innerHTML = `<span class="font-bold text-gray-800">${ingredient}</span>`;
      ingredientsList.appendChild(li);
  });

  const preparationSteps = byId('preparationSteps');
  preparationSteps.innerHTML = '';
  recipe.steps.forEach(step => {
      const div = document.createElement('div');
      div.className = 'prep-step';
      // يتم عرض الخطوات كنصوص مباشرة
      div.innerHTML = `
          <div class="step-title">${T.toggle === "EN" ? "الخطوة" : "Step"}</div>
          <p class="text-gray-600 pr-0 text-base">${step}</p>
      `;
      preparationSteps.appendChild(div);
  });

  // عرض الـ JSON الخام
  byId('rawJson').textContent = safeJSON(r);

  byId('recipeOutput').classList.remove('hidden');
  setTimeout(() => { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }, 100);
}

// دالة لتجميع المدخلات من DOM الجديد
function getRecipeInput(lang) {
    // تحديث الأسماء لتطابق app.html الجديد
    const dietType = byId('dietType')?.value || "balanced";
    const calorieTarget = byId('calorieTarget')?.value || "500";
    const commonAllergy = byId('commonAllergy')?.value;
    const customAllergy = byId('customAllergy')?.value?.trim();
    const focus = byId('focus')?.value?.trim() || "وصفة دجاج صحية غنية بالبروتين";
    const mealType = byId('mealType')?.value;
    const cuisine = byId('cuisine')?.value;

    let ingredients = [];
    let macros = "";

    // دمج قيود النظام الغذائي، الحساسية، والتركيز في حقل 'ingredients' أو 'macros'
    // يتم وضع هذا المنطق في app.js ليعمل مع generateRecipe.js
    
    // بناء قيد الماكروز والسعرات الحرارية
    if (calorieTarget && Number(calorieTarget) > 0) {
      macros = `${calorieTarget} سعرة حرارية`;
    }

    // بناء حقل المكونات (سيتم تفسيره في generateRecipe.js كقيد)
    let constraints = [];
    if (mealType) constraints.push(`لوجبة ${mealType}`);
    if (cuisine) constraints.push(`من المطبخ ${cuisine}`);

    let allergyConstraint = "";
    if (commonAllergy !== "لا يوجد") constraints.push(`خالي من: ${commonAllergy}`);
    if (customAllergy) constraints.push(`خالي من: ${customAllergy}`);
    
    if(focus) constraints.push(`التركيز على: ${focus}`);


    // نجمع جميع القيود في حقل المكونات ليتم معالجته بواسطة generateRecipe.js
    // دالة generateRecipe.js تبحث عن 'ingredients' و 'macros'
    
    return {
      email: localStorage.getItem("user_email") || "guest@example.com", // استخدام إيميل افتراضي مؤقت إذا لم يكن موجود
      diet: dietType,
      servings: 1, // تم تثبيتها في app.html
      time: 30, // قيمة افتراضية للوقت
      macros: macros,
      ingredients: constraints.join('، ')
    };
}


async function initAppPage(){
  // لا توجد حاجة للتحقق من requireAuthOrRedirect طالما يتم التعامل مع auth في Netlify Function
  const lang = getLang(); applyLangToDocument(lang);
  bindLangToggle(initAppPage);
  const T = I18N[lang];
  const btnGen = byId("generateBtn");
  const loadingIndicator = byId("loadingIndicator");
  const errorMsg = byId("errorMsg");
  const recipeOutput = byId('recipeOutput');

  // يتم هنا استخدام أسماء الحقول في app.html
  const dietSel = byId("dietType"); 
  
  // تعبئة الأنظمة من settings (تُركت كما هي للتحميل المستقبلي)
  try{
    const settings = await loadSettings();
    if(dietSel){
      dietSel.innerHTML = "";
      // يجب أن يتطابق هذا المنطق مع ملف settings.json الفعلي
      (settings?.diets || settings?.diet_systems || []).forEach(d => {
        const opt = document.createElement("option");
        opt.value = d.id || d.value || "balanced";
        opt.textContent = (lang==="ar"? (d.name_ar||d.label_ar||"") : (d.name_en||d.label_en||""));
        dietSel.appendChild(opt);
        // إعادة تعيين القيمة المختارة في حال وجودها
        if(d.value === "عادي/متوازن") opt.selected = true;
      });
    }
  }catch(e){ console.error("Could not load settings:", e); }

  // دالة تحميل الوصفة الأخيرة (لا توجد أزرار loadLast في app.html الجديد، لذا تم تجاهلها أو إلغاء ربطها)
  // تم حذفها مؤقتاً لتجنب استدعاء دالة userState غير الموجودة

  if(btnGen) btnGen.onclick = async () => {
    // التحقق من صلاحية السعرات الحرارية
    const calorieTargetEl = byId('calorieTarget');
    if (!calorieTargetEl.value || +calorieTargetEl.value < 100 || +calorieTargetEl.value > 2000) {
        errorMsg.textContent = T.invalid + ": يرجى إدخال قيمة سعرات حرارية صالحة بين 100 و 2000.";
        show(errorMsg);
        return;
    }

    try{
      // تهيئة الواجهة
      btnGen.disabled = true;
      show(loadingIndicator);
      hide(errorMsg);
      hide(recipeOutput);
      btnGen.innerHTML = `<div class="w-5 h-5 border-2 border-dashed rounded-full loader ml-2"></div> ${T.loading}`;
      alertBox(T.loading);

      const payload = getRecipeInput(lang);
      
      const r = await fetch("/.netlify/functions/generateRecipe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // يجب أن يتم تخزين هذه الرموز في localStorage من صفحة login/auth
          "x-auth-token": localStorage.getItem("auth_token")||"",
          "x-session-nonce": localStorage.getItem("session_nonce")||""
        },
        body: JSON.stringify(payload)
      });
      const jr = await r.json();
      
      // إيقاف التهيئة
      btnGen.disabled = false;
      hide(loadingIndicator);
      btnGen.innerHTML = T.toggle === "EN" ? 'توليد الوصفة الآن' : 'Generate Recipe Now';
      alertBox(""); // مسح رسالة التحميل

      // الخادم المُحدَّث يُعيد دائمًا recipe حتى عند فشل Gemini (هذا هو المنطق في generateRecipe.js)
      if(jr?.ok && jr?.recipe){ 
        // تحقق من وجود رسالة ملاحظة (note) من الخادم (رسالة فشل صديقة)
        if(jr.note) {
          errorMsg.textContent = jr.note;
          show(errorMsg);
        }
        renderRecipe(jr.recipe, lang); 
      }
      else{
        // في حال فشل الاتصال بالدالة الخلفية أو الخطأ غير المتوقع
        errorMsg.textContent = jr?.error || T.friendlyErr;
        show(errorMsg);
      }
    }catch(e){
      console.error("Fetch error:", e);
      errorMsg.textContent = T.friendlyErr;
      show(errorMsg);
      // إيقاف التهيئة عند الفشل
      btnGen.disabled = false;
      hide(loadingIndicator);
      btnGen.innerHTML = T.toggle === "EN" ? 'توليد الوصفة الآن' : 'Generate Recipe Now';
      alertBox("");
    }
  };
}

document.addEventListener("DOMContentLoaded", () => {
  // يفترض أن هذا الملف يُستخدم لصفحة app.html
  initAppPage();
});
