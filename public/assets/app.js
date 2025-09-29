/* WasfaOne Frontend — Server-only flow (Netlify Function) */

const API_ENDPOINT = "/.netlify/functions/generateRecipe";

// عناصر DOM
let mealTypeEl, cuisineEl, dietTypeEl, calorieTargetEl, commonAllergyEl, customAllergyEl, focusEl;
let generateBtn, loadingIndicator, errorMsg, statusMsg;
let recipeTitle, timeValue, servingsValue, caloriesValue, proteinValue, carbsValue, fatsValue, ingredientsList, preparationSteps, rawJson;

// أدوات مساعدة
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
  recipeTitle.textContent = "";
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

// توحيد البنية المتوقعة من الخادم
function validateRecipeSchema(rec) {
  const must = ["title","servings","total_time_min","macros","ingredients","steps","lang"];
  if (!rec || typeof rec !== "object") return { ok:false, error:"recipe_not_object" };
  for (const k of must) if (!(k in rec)) return { ok:false, error:`missing_${k}` };

  const m = rec.macros;
  if (!m || typeof m !== "object") return { ok:false, error:"macros_not_object" };
  for (const key of ["protein_g","carbs_g","fat_g","calories"]) {
    if (typeof m[key] !== "number") return { ok:false, error:`macro_${key}_type` };
  }
  if (!Array.isArray(rec.ingredients) || rec.ingredients.some(x => typeof x !== "string")) {
    return { ok:false, error:"ingredients_type" };
  }
  if (!Array.isArray(rec.steps) || rec.steps.some(x => typeof x !== "string")) {
    return { ok:false, error:"steps_type" };
  }
  return { ok:true };
}

function renderRecipe(recipe) {
  recipeTitle.textContent = recipe.title;
  timeValue.textContent = `${recipe.total_time_min} دقيقة`;
  servingsValue.textContent = `${recipe.servings}`;
  caloriesValue.textContent = `${recipe.macros.calories}`;
  proteinValue.textContent = `${recipe.macros.protein_g}`;
  carbsValue.textContent = `${recipe.macros.carbs_g}`;
  fatsValue.textContent = `${recipe.macros.fat_g}`;
  ingredientsList.innerHTML = recipe.ingredients.map(i => `<li>${i}</li>`).join("");
  preparationSteps.innerHTML = recipe.steps.map(s => `<li>${s}</li>`).join("");
  rawJson.textContent = JSON.stringify(recipe, null, 2);
}

async function onGenerate() {
  clearOutput();
  showError("");
  showStatus("جاري التوليد ...");

  generateBtn.disabled = true;
  loadingIndicator.classList.remove("hidden");
  generateBtn.textContent = "جاري التوليد ...";

  const allergies = []
    .concat(commonAllergyEl.value ? [commonAllergyEl.value] : [])
    .concat(
      customAllergyEl.value
        ? customAllergyEl.value.split(",").map(s => s.trim()).filter(Boolean)
        : []
    );

  const payload = {
    mealType: mealTypeEl.value,
    cuisine: cuisineEl.value,
    dietType: dietTypeEl.value,
    caloriesTarget: Number(calorieTargetEl.value) || 500,
    allergies,
    focus: focusEl.value || "",
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

    if (data.note) showStatus(data.note); else showStatus("تم التوليد بنجاح.");

    const v = validateRecipeSchema(data.recipe);
    if (!v.ok) throw new Error(`بنية غير متوقعة من الخادم: ${v.error}`);

    renderRecipe(data.recipe);
  } catch (err) {
    showError(err.message || "حدث خطأ غير متوقع.");
    showStatus("", false);
  } finally {
    generateBtn.disabled = false;
    loadingIndicator.classList.add("hidden");
    generateBtn.textContent = "توليد الوصفة الآن";
  }
}

function setup() {
  // ربط العناصر
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

  generateBtn.addEventListener("click", onGenerate);
}

document.addEventListener("DOMContentLoaded", setup);
