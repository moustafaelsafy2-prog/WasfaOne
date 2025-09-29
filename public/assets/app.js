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
    // يجب أن تكون البنية كما هي متوقعة من generateRecipe.js
    if (!data || !data.title || !data.macros || !data.ingredients || !data.steps) {
        showStatus("فشل في تحليل البنية. راجع سجلات الخادم.", true);
        return;
    }
    
    errorMsg.classList.add('hidden');
    
    recipeTitle.textContent = data.title;
    timeValue.textContent = `${data.total_time_min} دقيقة`;
    servingsValue.textContent = `${data.servings} حصة`;

    // عرض الماكروز
    caloriesValue.textContent = `${data.macros.calories || 'N/A'}`;
    proteinValue.textContent = `${data.macros.protein_g || 'N/A'} جم`;
    carbsValue.textContent = `${data.macros.carbs_g || 'N/A'} جم`;
    fatsValue.textContent = `${data.macros.fat_g || 'N/A'} جم`;

    // عرض المكونات
    ingredientsList.innerHTML = '';
    data.ingredients.forEach(ingredient => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="text-gray-700">${ingredient}</span>`;
        ingredientsList.appendChild(li);
    });

    // عرض الخطوات
    preparationSteps.innerHTML = '';
    data.steps.forEach((step, index) => {
        const div = document.createElement('div');
        div.className = 'prep-step';
        div.innerHTML = `
            <div class="step-title">${index + 1}. ${step.length > 50 ? step.substring(0, 50) + '...' : step}</div> 
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
    
    // تجميع قيود النظام الغذائي والحساسيات لإرسالها كجزء من input.diet و input.ingredients
    let dietConstraints = "";
    if (dietType === "نظام د. محمد سعيد") {
        dietConstraints = ` (${dietType}) يجب أن تكون خالية تماماً من الكربوهيدرات المرتفعة، السكريات، الجلوتين، اللاكتوز، الليكتين، البقوليات والزيوت المهدرجة. مسموح فقط بالدهون الصحية والأجبان الدسمة الحيوانية والزبادي اليوناني.`;
    } else {
        dietConstraints = ` (${dietType})`;
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
            // ملاحظة: تم إزالة x-auth-token و x-session-nonce ليتوافق مع generateRecipe.js إصدار التشخيص
            body: JSON.stringify(payload)
        });
        
        if (!r.ok && r.status !== 200) { 
             throw new Error(`فشل الاتصال بالخادم: كود HTTP ${r.status}`);
        }
        
        const jr = await r.json();
        
        if (jr.recipe) {
             if (jr.note) {
                 // عرض رسالة الخطأ الدقيقة من الدالة الخلفية (إذا كانت وصفة افتراضية بسبب فشل Gemini)
                 showStatus(jr.note, true);
             }
             return jr.recipe;
        } else {
            // هذا الخطأ يجب أن يحدث فقط إذا لم يكن هناك وصفة ولا ملاحظة!
            const errorNote = jr.error || "خطأ غير محدد من الخادم الخلفي (لم يتم إرجاع وصفة).";
            throw new Error(errorNote);
        }
    } catch (error) {
        if (error.message.includes("المفتاح (GEMINI_API_KEY) مفقود")) {
             throw new Error("فشل الذكاء الاصطناعي: المفتاح السري (GEMINI_API_KEY) مفقود أو غير مهيأ في بيئة التشغيل الخلفية.");
        }
        throw new Error(`فشلت عملية إنشاء الوصفة بعد عدة محاولات. (خطأ الشبكة: ${error.message})`);
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
    
    // إذا لم يتم العثور على أي عنصر رئيسي، لن نقوم بتسجيل الأحداث
    if (!generateBtn || !mealTypeEl || !calorieTargetEl) {
        console.error("Critical Error: One or more essential elements (e.g., generateBtn, mealTypeEl) not found in HTML.");
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
            // إذا لم يكن هناك رسالة خطأ مُحددة من generateRecipe.js، نفترض النجاح
            if (!statusMsg.textContent.includes("فشل") && !statusMsg.textContent.includes("خطأ")) {
                showStatus("تم توليد الوصفة بنجاح.", false);
            }
        } catch (error) {
            // في حالة خطأ شبكة أو خطأ غير متوقع
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
