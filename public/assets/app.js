/* WasfaOne Frontend — Standalone binding with Custom Macros + Available Ingredients + Recent Titles */

const API_ENDPOINT = "/.netlify/functions/generateRecipe";

// DOM refs
let mealTypeEl, cuisineEl, dietTypeEl, calorieTargetEl, commonAllergyEl, customAllergyEl, focusEl, availableIngredientsEl;
let customBox, customProteinEl, customCarbsEl, customFatEl;
let generateBtn, loadingIndicator, errorMsg, statusMsg;
let recipeTitle, timeValue, servingsValue, caloriesValue, proteinValue, carbsValue, fatsValue, ingredientsList, preparationSteps, rawJson;

// helpers
function showStatus(message, isError = false) {
  statusMsg.textContent = message || "";
  statusMsg.classList.toggle("hidden", !message);
  statusMsg.classList.toggle("text-red-600", !!isError);
  statusMsg.classList.toggle("text-blue-600", !isError);
}
function showError(message) {
  errorMsg.textContent = message || "";
  errorMsg.classList.toggle("hidden", !message);
}
function clearOutput() {
  if (recipeTitle) recipeTitle.textContent = "";
  if (timeValue) timeValue.textContent = "—";
  if (servingsValue) servingsValue.textContent = "—";
  if (caloriesValue) caloriesValue.textContent = "—";
  if (proteinValue) proteinValue.textContent = "—";
  if (carbsValue) carbsValue.textContent = "—";
  if (fatsValue) fatsValue.textContent = "—";
  if (ingredientsList) ingredientsList.innerHTML = "";
  if (preparationSteps) preparationSteps.innerHTML = "";
  if (rawJson) rawJson.textContent = "";
}
function validateRecipeSchema(rec) {
  const must = ["title","servings","total_time_min","macros","ingredients","steps","lang"];
  if (!rec || typeof rec !== "object") return { ok:false, error:"recipe_not_object" };
  for (const k of must) if (!(k in rec)) return { ok:false, error:`missing_${k}` };
  const m = rec.macros;
  if (!m || typeof m !== "object") return { ok:false, error:"macros_not_object" };
  for (const key of ["protein_g","carbs_g","fat_g","calories"]) {
    if (typeof m[key] !== "number") return { ok:false, error:`macro_${key}_type` };
  }
  if (!Array.isArray(rec.ingredients) || rec.ingredients.some(x => typeof x !== "string"))
    return { ok:false, error:"ingredients_type" };
  if (!Array.isArray(rec.steps) || rec.steps.some(x => typeof x !== "string"))
    return { ok:false, error:"steps_type" };
  return { ok:true };
}
function renderRecipe(recipe) {
  if (recipeTitle) recipeTitle.textContent = recipe.title;
  if (timeValue) timeValue.textContent = `${recipe.total_time_min} دقيقة`;
  if (servingsValue) servingsValue.textContent = `${recipe.servings}`;
  if (caloriesValue) caloriesValue.textContent = `${recipe.macros.calories}`;
  if (proteinValue) proteinValue.textContent = `${recipe.macros.protein_g}`;
  if (carbsValue) carbsValue.textContent = `${recipe.macros.carbs_g}`;
  if (fatsValue) fatsValue.textContent = `${recipe.macros.fat_g}`;
  if (ingredientsList) ingredientsList.innerHTML = recipe.ingredients.map(i => `<li>${i}</li>`).join("");
  if (preparationSteps) preparationSteps.innerHTML = recipe.steps.map(s => `<li>${s}</li>`).join("");
  if (rawJson) rawJson.textContent = JSON.stringify(recipe, null, 2);
}

function parseAvailableList(text){
  if(!text) return [];
  const parts = text
    .split(/[\n,،]+/).map(s=>s.trim()).filter(Boolean)
    .map(s=>s.replace(/[{}\[\]<>:";]/g," "))
    .map(s=>s.replace(/\s+/g,' '));
  return Array.from(new Set(parts)).slice(0,50);
}

function recentKey(){ 
  const mt = mealTypeEl ? mealTypeEl.value : 'وجبة';
  const cu = cuisineEl ? cuisineEl.value : 'متنوع';
  const dt = dietTypeEl ? dietTypeEl.value : 'balanced';
  return ['k', mt, cu, dt].join('|');
}
function getRecentTitles(){
  const key = recentKey();
  const all = JSON.parse(localStorage.getItem("wasfa_recent_titles")||"{}");
  return Array.isArray(all[key]) ? all[key] : [];
}
function pushRecentTitle(title){
  const key = recentKey();
  const all = JSON.parse(localStorage.getItem("wasfa_recent_titles")||"{}");
  const list = Array.isArray(all[key]) ? all[key] : [];
  const t = String(title||"").trim();
  if (t && !list.includes(t)) list.unshift(t);
  all[key] = list.slice(0,10);
  localStorage.setItem("wasfa_recent_titles", JSON.stringify(all));
}

async function onGenerate() {
  clearOutput();
  showError("");
  showStatus("جاري التوليد ...");

  if (generateBtn) generateBtn.disabled = true;
  if (loadingIndicator) loadingIndicator.classList.remove("hidden");
  if (generateBtn) generateBtn.textContent = "جاري التوليد ...";

  const allergies = []
    .concat(commonAllergyEl && commonAllergyEl.value ? [commonAllergyEl.value] : [])
    .concat(
      customAllergyEl && customAllergyEl.value
        ? customAllergyEl.value.split(/[,،]+/).map(s => s.trim()).filter(Boolean)
        : []
    );

  const isCustom = dietTypeEl && dietTypeEl.value === "custom";
  const customMacros = isCustom && customProteinEl && customCarbsEl && customFatEl
    ? {
        protein_g: Number(customProteinEl.value) || 0,
        carbs_g: Number(customCarbsEl.value) || 0,
        fat_g: Number(customFatEl.value) || 0
      }
    : null;

  const payload = {
    mealType: mealTypeEl ? mealTypeEl.value : "وجبة",
    cuisine: cuisineEl ? cuisineEl.value : "متنوع",
    dietType: dietTypeEl ? dietTypeEl.value : "balanced",
    caloriesTarget: calorieTargetEl ? (Number(calorieTargetEl.value) || 500) : 500,
    allergies,
    focus: (focusEl && focusEl.value) || "",
    customMacros,
    availableIngredients: parseAvailableList(availableIngredientsEl && availableIngredientsEl.value),
    recentTitles: getRecentTitles(),
    lang: "ar"
  };

  try {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data?.error || "تعذر الاتصال بالخادم.");
    }

    showStatus(data.note || "تم التوليد بنجاح.");
    const v = validateRecipeSchema(data.recipe);
    if (!v.ok) throw new Error(`بنية غير متوقعة من الخادم: ${v.error}`);

    renderRecipe(data.recipe);
    pushRecentTitle(data.recipe.title);
  } catch (err) {
    showError(err.message || "حدث خطأ غير متوقع.");
    showStatus("", false);
  } finally {
    if (generateBtn) generateBtn.disabled = false;
    if (loadingIndicator) loadingIndicator.classList.add("hidden");
    if (generateBtn) generateBtn.textContent = "توليد الوصفة الآن";
  }
}

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
      if (customBox) customBox.classList.toggle("hidden", !isCustom);
    }
    if (dietTypeEl) {
      dietTypeEl.addEventListener("change", toggleCustom);
      toggleCustom();
    }
  } catch (_e) {
    // fallback: keep existing options if present
  }
}

function ensureCustomBoxes() {
  if (!document.getElementById("customMacrosBox")) {
    customBox = document.createElement("div");
    customBox.id = "customMacrosBox";
    customBox.className = "grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4 hidden";
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
}

function setup() {
  mealTypeEl = document.getElementById("mealType");
  cuisineEl = document.getElementById("cuisine");
  dietTypeEl = document.getElementById("dietType");
  calorieTargetEl = document.getElementById("calorieTarget");
  commonAllergyEl = document.getElementById("commonAllergy");
  customAllergyEl = document.getElementById("customAllergy");
  focusEl = document.getElementById("focus");
  availableIngredientsEl = document.getElementById("availableIngredients");

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

  customBox = document.getElementById("customMacrosBox");
  ensureCustomBoxes();

  if (generateBtn) generateBtn.addEventListener("click", () => {
    const v = calorieTargetEl ? (+calorieTargetEl.value || 0) : 0;
    if (v < 100 || v > 2000) { showError("أدخل سعرات بين 100 و 2000"); return; }
    if (dietTypeEl && dietTypeEl.value === "custom") {
      const p = Number(customProteinEl.value)||0, c = Number(customCarbsEl.value)||0, f = Number(customFatEl.value)||0;
      if (p<=0 && c<=0 && f<=0) { showError("أدخل قيم الماكروز للمخصص (بروتين/كارب/دهون)."); return; }
    }
    onGenerate();
  });

  loadSettingsAndBindDietList();
}

document.addEventListener("DOMContentLoaded", setup);
