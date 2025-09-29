/* WasfaOne Frontend - Unified Logic (Revised for Safe DOM Access) */

// تحديد نقطة النهاية للاتصال بالدالة الخلفية (Netlify Function)
const API_ENDPOINT = "/.netlify/functions/generateRecipe";

// الإعلان عن المتغيرات العليا (لكن لن يتم تعيين قيمها إلا في setupEventListeners)
let mealTypeEl, cuisineEl, dietTypeEl, calorieTargetEl, commonAllergyEl, customAllergyEl, focusEl;
let generateBtn, loadingIndicator, errorMsg, statusMsg, recipeOutput;
let recipeTitle, timeValue, servingsValue, caloriesValue, proteinValue, carbsValue, fatsValue, ingredientsList, preparationSteps, rawJson;

// 1. Helper لعرض حالة النظام أو الأخطاء
function showStatus(message, isError = false) {
    if (!statusMsg || !errorMsg) return; // حماية إضافية
    statusMsg.textContent = message;
    statusMsg.classList.remove('hidden');
    if (isError) {
        statusMsg.classList.remove('text-blue-600');
        statusMsg.classList.add('text-red-600');
        errorMsg.textContent = message;
        errorMsg.classList.remove('hidden');
    } else {
        statusMsg.classList.remove('text-red-600');
        statusMsg.classList.add('text-blue-600');
        errorMsg.classList.add('hidden');
    }
}

// 2. دالة العرض - تتوقع نفس بنية JSON التي تعيدها الدالة الخلفية
function renderRecipe(data) {
    if (!data || !data.title || !data.macros || !data.ingredients || !data.steps) {
        throw new Error("بنية الوصفة المستلمة غير صالحة.");
    }
    
    errorMsg.classList.add('hidden');
    
    recipeTitle.textContent = data.title;
    timeValue.textContent = `${data.total_time_min} دقيقة`;
    servingsValue.textContent = `${data.servings} حصة`;

    caloriesValue.textContent = `${data.macros.calories || 'N/A'}`;
    proteinValue.textContent = `${data.macros.protein_g || 'N/A'} جم`;
    carbsValue.textContent = `${data.macros.carbs_g || 'N/A'} جم`;
    fatsValue.textContent = `${data.macros.fat_g || 'N/A'} جم`;

    ingredientsList.innerHTML = '';
    data.ingredients.forEach(ingredient => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="text-gray-700">${ingredient}</span>`;
        ingredientsList.appendChild(li);
    });

    preparationSteps.innerHTML = '';
    data.steps.forEach((step, index) => {
        const div = document.createElement('div');
        div.className = 'prep-step';
        div.innerHTML = `
            <div class="step-title">${index + 1}. ${step.substring(0, 50)}...</div> 
            <p class="text-gray-600 pr-0 text-base">${step}</p>
        `;
        preparationSteps.appendChild(div);
    });

    rawJson.textContent = JSON.stringify(data, null, 2);

    recipeOutput.classList.remove('hidden');
    setTimeout(() => { 
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); 
    }, 100);
}

// 3. دالة الاتصال بالدالة الخلفية
async function fetchRecipe() {
    // جمع المدخلات
    const mealType = mealTypeEl.value;
    const cuisine = cuisineEl.value;
    const dietType = dietTypeEl.value;
    const calorieTarget = calorieTargetEl.value;
    const commonAllergy = commonAllergyEl.value;
    const customAllergy = customAllergyEl.value.trim();
    const focus = focusEl.value.trim() || "مُبتكرة وعصرية";
    
    let dietConstraints = "";
    if (dietType === "نظام د. محمد سعيد") {
        dietConstraints = `(${dietType}) يجب أن تكون خالية تماماً من الكربوهيدرات المرتفعة، السكريات، الجلوتين، اللاكتوز، الليكتين، البقوليات والزيوت المهدرجة. مسموح فقط بالدهون الصحية والأجبان الدسمة الحيوانية والزبادي اليوناني.`;
    } else {
        dietConstraints = `(${dietType})`;
    }

    let allergyConstraint = "";
    const allergies = [];
    if (commonAllergy !== "لا يوجد") allergies.push(commonAllergy);
    if (customAllergy) allergies.push(customAllergy);
    if (allergies.length > 0) {
        allergyConstraint = ` **خالية تمامًا من (حساسية):** ${allergies.join(' و ')}.`;
    }

    const ingredientsString = `الوجبة: ${mealType} - المطبخ: ${cuisine}. التركيز: ${focus}. ${allergyConstraint}`;
    
    const payload = {
        diet: dietType + dietConstraints,
        servings: 1, 
        time: 30, 
        macros: `${calorieTarget} سعرة حرارية`,
        ingredients: ingredientsString
    };

    try {
        const r = await fetch(API_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        if (!r.ok && r.status !== 200) { 
             throw new Error(`فشل الاتصال بالخادم: كود HTTP ${r.status}`);
        }
        
        const jr = await r.json();

        if (jr.ok && jr.recipe) {
            if (jr.note) {
                 showStatus(`تم التوليد بنجاح (ملاحظة: ${jr.note})`, false);
            }
            return jr.recipe;
        } else {
            const errorNote = jr.note || jr.error || "خطأ غير محدد من الخادم الخلفي.";
            throw new Error(errorNote);
        }
    } catch (error) {
        if (error.message.includes("المفتاح (GEMINI_API_KEY) مفقود")) {
             throw new Error("فشل الذكاء الاصطناعي: المفتاح السري (GEMINI_API_KEY) مفقود أو غير مهيأ في بيئة التشغيل الخلفية.");
        }
        throw new Error(error.message);
    }
}

// 4. ربط الزر بالدالة - وتعيين العناصر هنا
function setupEventListeners() {
    // ----------------------------------------------------
    // تعيين قيم المتغيرات بعد التأكد من تحميل DOM
    // ----------------------------------------------------
    mealTypeEl = document.getElementById('mealType');
    cuisineEl = document.getElementById('cuisine');
    dietTypeEl = document.getElementById('dietType');
    calorieTargetEl = document.getElementById('calorieTarget');
    commonAllergyEl = document.getElementById('commonAllergy');
    customAllergyEl = document.getElementById('customAllergy');
    focusEl = document.getElementById('focus');

    generateBtn = document.getElementById('generateBtn');
    loadingIndicator = document.getElementById('loadingIndicator');
    errorMsg = document.getElementById('errorMsg');
    statusMsg = document.getElementById('statusMsg'); 
    recipeOutput = document.getElementById('recipeOutput');

    recipeTitle = document.getElementById('recipeTitle');
    timeValue = document.getElementById('timeValue');
    servingsValue = document.getElementById('servingsValue');
    caloriesValue = document.getElementById('caloriesValue');
    proteinValue = document.getElementById('proteinValue');
    carbsValue = document.getElementById('carbsValue');
    fatsValue = document.getElementById('fatsValue');
    ingredientsList = document.getElementById('ingredientsList');
    preparationSteps = document.getElementById('preparationSteps');
    rawJson = document.getElementById('rawJson');
    
    if (!generateBtn) {
        // إذا لم يتم العثور على الزر حتى بعد تحميل DOM، فهناك مشكلة في الـ HTML
        console.error("Critical Error: Generate button (ID: generateBtn) not found.");
        return;
    }
    // ----------------------------------------------------
    
    generateBtn.addEventListener('click', async () => {
        if (!calorieTargetEl.value || +calorieTargetEl.value < 100 || +calorieTargetEl.value > 2000) {
            showStatus("يرجى إدخال قيمة سعرات حرارية صالحة بين 100 و 2000.", true);
            return;
        }
        
        generateBtn.disabled = true;
        loadingIndicator.classList.remove('hidden');
        generateBtn.innerHTML = '<div class="w-5 h-5 border-2 border-dashed rounded-full loader ml-2"></div> جارٍ التوليد...';
        showStatus("جاري توليد الوصفة بالذكاء الاصطناعي... قد يستغرق الأمر بعض الوقت.", false);
        recipeOutput.classList.add('hidden'); 

        try {
            const recipe = await fetchRecipe();
            renderRecipe(recipe);
            showStatus("تم توليد الوصفة بنجاح.", false);
        } catch (error) {
            showStatus(error.message, true);
        } finally {
            generateBtn.disabled = false;
            loadingIndicator.classList.add('hidden');
            generateBtn.innerHTML = 'توليد الوصفة الآن';
        }
    });
}

// تشغيل الكود بمجرد تحميل الصفحة بالكامل
document.addEventListener("DOMContentLoaded", setupEventListeners);
