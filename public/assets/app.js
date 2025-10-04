/* WasfaOne Frontend — Server-only flow (Netlify Function) with Custom Macros */
/* نسخة كاملة بعد إدخال التعديلات:
   - تمرير رؤوس الاشتراك X-Auth-Token و X-Session-Nonce لكل الطلبات
   - تصحيح اسم الحقل إلى caloriesTarget (بدلاً من calorieTarget)
   - استخدام normalizeAllergies للإرسال
   - استخدام نفس الرؤوس في توليد صورة الطبق
*/

const API_ENDPOINT = "/.netlify/functions/generateRecipe";
const API_IMAGE_ENDPOINT = "/.netlify/functions/generateRecipeImage";

// DOM refs
let mealTypeEl, cuisineEl, dietTypeEl, calorieTargetEl, commonAllergyEl, customAllergyEl, focusEl;
let customBox, customProteinEl, customCarbsEl, customFatEl;
let generateBtn, loadingIndicator, errorMsg, statusMsg;
let recipeTitle, timeValue, servingsValue, caloriesValue, proteinValue, carbsValue, fatsValue, ingredientsList, preparationSteps, rawJson;

/* ====================== Helpers ====================== */
function $(sel) { return document.querySelector(sel); }

function showStatus(message, isError = false) {
  statusMsg.textContent = message || "";
  statusMsg.classList.toggle("hidden", !message);
  statusMsg.classList.toggle("text-red-600", !!isError);
  statusMsg.classList.toggle("text-emerald-700", !isError);
}
function showError(message) {
  errorMsg.textContent = message || "";
  errorMsg.classList.toggle("hidden", !message);
}
function clearOutput() {
  if (recipeTitle) recipeTitle.innerHTML = ""; // إزالة أي صورة سابقة داخل العنوان
  timeValue.textContent = "—";
  servingsValue.textContent = "—";
  caloriesValue.textContent = "—";
  proteinValue.textContent = "—";
  carbsValue.textContent = "—";
  fatsValue.textContent = "—";
  ingredientsList.innerHTML = "";
  preparationSteps.innerHTML = "";
  rawJson.textContent = "";
}

// رؤوس المصادقة تُرسل في كل طلب (token + nonce)
function getAuthHeaders() {
  const token = (localStorage.getItem('auth_token') || '').trim();
  const nonce = (localStorage.getItem('session_nonce') || '').trim();
  const h = { 'Content-Type': 'application/json' };
  if (token) h['X-Auth-Token'] = token;
  if (nonce) h['X-Session-Nonce'] = nonce;
  return h;
}

/* ====================== Schema check ====================== */
function validateRecipeSchema(rec) {
  const must = ["title","servings","total_time_min","macros","ingredients","steps","lang"];
  if (!rec || typeof rec !== "object") return { ok:false, error:"recipe_not_object" };
  for (const k of must) if (!(k in rec)) return { ok:false, error:`missing_${k}` };
  const m = rec.macros;
  if (!m || typeof m !== "object") return { ok:false, error:"macros_not_object" };
  for (const key of ["protein_g","carbs_g","fat_g","calories"]) {
    if (!(key in m)) return { ok:false, error:`missing_macro_${key}` };
  }
  if (!Array.isArray(rec.ingredients) || !rec.ingredients.length) return { ok:false, error:"ingredients_empty" };
  if (!Array.isArray(rec.steps) || !rec.steps.length) return { ok:false, error:"steps_empty" };
  return { ok:true };
}

/* ====================== Render ====================== */
function renderRecipe(recipe) {
  recipeTitle.textContent = recipe.title;
  generateAndRenderRecipeImage(recipe); // توليد الصورة بجانب الاسم
  timeValue.textContent = `${recipe.total_time_min} دقيقة`;
  servingsValue.textContent = `${recipe.servings}`;
  caloriesValue.textContent = `${recipe.macros.calories}`;
  proteinValue.textContent = `${recipe.macros.protein_g}`;
  carbsValue.textContent = `${recipe.macros.carbs_g}`;
  fatsValue.textContent = `${recipe.macros.fat_g}`;
  ingredientsList.innerHTML = recipe.ingredients.map(i => `<li>${i}</li>`).join("");
  preparationSteps.innerHTML = recipe.steps.map(s => `<li>${s}</li>`).join("");
  if (rawJson) rawJson.textContent = JSON.stringify(recipe, null, 2);
}

/* ====== توليد وعرض صورة الطبق عبر دالة منفصلة ====== */
async function generateAndRenderRecipeImage(recipe) {
  try {
    const payload = {
      title: recipe.title || "",
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
      steps: Array.isArray(recipe.steps) ? recipe.steps : [],
      cuisine: (cuisineEl && cuisineEl.value) || "",
      lang: recipe.lang || "ar"
    };

    const res = await fetch(API_IMAGE_ENDPOINT, {
      method: "POST",
      headers: getAuthHeaders(), // نفس بوابة الاشتراك إن كانت الدالة محمية
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.image || !data.image.data_url) return;

    if (!recipeTitle) return;
    const img = document.createElement("img");
    img.src = data.image.data_url;
    img.alt = recipe.title || "صورة الطبق";
    img.decoding = "async";
    img.loading = "lazy";
    img.style.width = "88px";
    img.style.height = "88px";
    img.style.objectFit = "cover";
    img.style.borderRadius = "12px";
    img.style.marginInlineEnd = "12px";
    img.style.verticalAlign = "middle";
    img.style.display = "inline-block";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = recipe.title || "";
    titleSpan.style.verticalAlign = "middle";

    recipeTitle.innerHTML = "";
    recipeTitle.appendChild(img);
    recipeTitle.appendChild(titleSpan);
  } catch (e) {
    console.error("image_generation_failed", e); // لا نكسر الواجهة
  }
}

/* ====================== Input sanitation ====================== */
function normalizeAllergies(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map(s => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 10);
}

/* ====================== Main action ====================== */
async function onGenerate() {
  clearOutput();
  showError("");
  showStatus("جاري التوليد ...");

  generateBtn.disabled = true;
  if (loadingIndicator) loadingIndicator.classList.remove("hidden");
  if (generateBtn) generateBtn.textContent = "جاري التوليد ...";

  const allergies = []
    .concat(commonAllergyEl && commonAllergyEl.value ? [commonAllergyEl.value] : [])
    .concat(
      customAllergyEl && customAllergyEl.value
        ? customAllergyEl.value.split(",").map(s => s.trim()).filter(Boolean)
        : []
    );

  const isCustom = dietTypeEl && dietTypeEl.value === "custom";
  const customMacros = isCustom ? {
    protein_g: customProteinEl ? (+customProteinEl.value || 0) : 0,
    carbs_g: customCarbsEl ? (+customCarbsEl.value || 0) : 0,
    fat_g: customFatEl ? (+customFatEl.value || 0) : 0
  } : null;

  const payload = {
    mealType: mealTypeEl ? mealTypeEl.value : "",
    cuisine: cuisineEl ? cuisineEl.value : "",
    dietType: dietTypeEl ? dietTypeEl.value : "",
    // ✅ الاسم الصحيح كما يتوقعه الخادم
    caloriesTarget: calorieTargetEl ? (Number(calorieTargetEl.value) || 500) : 500,
    // ✅ إرسال قائمة نظيفة
    allergies: normalizeAllergies(allergies),
    focus: (focusEl && focusEl.value) || "",
    customMacros,
    lang: "ar"
  };

  // Debug اختياري لتأكيد إرسال الرؤوس (احذفها لاحقًا)
  try {
    const _t = (localStorage.getItem('auth_token') || '').trim();
    const _n = (localStorage.getItem('session_nonce') || '').trim();
    console.debug('auth_debug', { token_tail: _t.slice(-6), nonce_tail: _n.slice(-6) });
  } catch {}

  try {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: getAuthHeaders(), // ✅ تمرير الرؤوس المطلوبة
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.error || "تعذر الاتصال بالخادم.");

    showStatus(data.note || "تم التوليد بنجاح.");
    const v = validateRecipeSchema(data.recipe);
    if (!v.ok) throw new Error(`بنية غير متوقعة من الخادم: ${v.error}`);

    renderRecipe(data.recipe);
  } catch (err) {
    showError(err.message || "حدث خطأ غير متوقع.");
    showStatus("", false);
  } finally {
    generateBtn.disabled = false;
    if (loadingIndicator) loadingIndicator.classList.add("hidden");
    if (generateBtn) generateBtn.textContent = "توليد الوصفة";
  }
}

/* ====================== Setup ====================== */
function setup() {
  // Bind elements
  mealTypeEl = document.getElementById("mealType");
  cuisineEl = document.getElementById("cuisine");
  dietTypeEl = document.getElementById("dietType");
  calorieTargetEl = document.getElementById("calorieTarget");
  commonAllergyEl = document.getElementById("commonAllergy");
  customAllergyEl = document.getElementById("customAllergy");
  focusEl = document.getElementById("focus");

  generateBtn = document.getElementById("generateBtn");
  loadingIndicator = document.getElementById("loadingIndicator");
  errorMsg = document.getElementById("errorMsg");
  statusMsg = document.getElementById("statusMsg");

  recipeTitle = document.getElementById("recipeTitle");
  timeValue = document.getElementById("timeValue");
  servingsValue = document.getElementById("servingsValue");
  caloriesValue = document.getElementById("caloriesValue");
  proteinValue = document.getElementById("proteinValue");
  carbsValue = document.getElementById("carbsValue");
  fatsValue = document.getElementById("fatsValue");
  ingredientsList = document.getElementById("ingredientsList");
  preparationSteps = document.getElementById("preparationSteps");
  rawJson = document.getElementById("rawJson");

  if (generateBtn) generateBtn.addEventListener("click", () => {
    const v = calorieTargetEl ? (+calorieTargetEl.value || 0) : 0;
    if (v < 100 || v > 2000) { showError("أدخل سعرات بين 100 و 2000"); return; }
    if (dietTypeEl && dietTypeEl.value === "custom") {
      const p = Number(customProteinEl?.value)||0, c = Number(customCarbsEl?.value)||0, f = Number(customFatEl?.value)||0;
      if (p<=0 && c<=0 && f<=0) { showError("أدخل قيم الماكروز للمخصص (بروتين/كارب/دهون)."); return; }
    }
    onGenerate();
  });

  loadSettingsAndBindDietList();
}

document.addEventListener("DOMContentLoaded", setup);

/* ====================== Settings & Custom Diet Box ====================== */
async function loadSettingsAndBindDietList() {
  try {
    const res = await fetch("/data/settings.json?ts=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("settings_fetch_failed");
    const s = await res.json();
    const diets = Array.isArray(s?.diet_systems) ? s.diet_systems : [];

    if (dietTypeEl && diets.length) {
      dietTypeEl.innerHTML = diets.map(d => `<option value="${d.id}">${d.name_ar}</option>`).join("");
    }

    function toggleCustom() {
      const isCustom = dietTypeEl && dietTypeEl.value === "custom";
      if (isCustom && !customBox) {
        customBox = document.createElement("div");
        customBox.className = "grid grid-cols-3 gap-4 p-4 bg-white/70 border border-slate-200 rounded-xl mt-3";
        customBox.innerHTML = `
      <div><label class="block text-sm text-slate-600 mb-1">بروتين (جم/حصة)</label>
        <input id="customProtein" type="number" min="0" step="1" value="30" class="w-full border rounded-md p-3">
      </div>
      <div><label class="block text-sm text-slate-600 mb-1">كربوهيدرات (جم/حصة)</label>
        <input id="customCarbs" type="number" min="0" step="1" value="35" class="w-full border rounded-md p-3">
      </div>
      <div><label class="block text-sm text-slate-600 mb-1">دهون (جم/حصة)</label>
        <input id="customFat" type="number" min="0" step="1" value="20" class="w-full border rounded-md p-3">
      </div>`;
        const anchor = document.getElementById("calorieTarget");
        if (anchor && anchor.parentElement && anchor.parentElement.parentElement) {
          anchor.parentElement.parentElement.insertAdjacentElement("afterend", customBox);
        } else {
          document.body.appendChild(customBox);
        }
      }
      customProteinEl = document.getElementById("customProtein");
      customCarbsEl = document.getElementById("customCarbs");
      customFatEl = document.getElementById("customFat");
      if (customBox) customBox.classList.toggle("hidden", !isCustom);
    }

    if (dietTypeEl) {
      dietTypeEl.addEventListener("change", toggleCustom);
      toggleCustom();
    }
  } catch (e) {
    console.error(e);
  }
}
