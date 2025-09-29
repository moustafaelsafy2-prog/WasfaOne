<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>مُنشئ الوصفات بالذكاء الاصطناعي</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=Cairo:wght@200..1000&display=swap');
        body{font-family:'Cairo','Inter',sans-serif;background:#f7f7f9;min-height:100vh;overflow-x:hidden}
        .recipe-card{box-shadow:0 10px 30px rgba(0,0,0,.08);transition:transform .3s;padding-bottom:2rem}
        .recipe-card:hover{transform:translateY(-2px)}
        .ingredient-list li{position:relative;padding-right:1.5rem;line-height:1.8;margin-bottom:.75rem;font-size:1rem}
        .ingredient-list li::before{content:'•';position:absolute;right:0;color:#ef4444;font-weight:bold}
        .prep-step{counter-increment:step-counter;margin-top:1.5rem;padding-bottom:1rem;border-bottom:1px solid #f3f4f6}
        .prep-step:last-child{border-bottom:none}
        .prep-step .step-title{font-size:1.125rem;font-weight:700;color:#1f2937;margin-bottom:.5rem;display:flex;align-items:center}
        .prep-step .step-title::before{content:counter(step-counter)'. ';color:#ef4444;font-size:1.25rem;font-weight:800;margin-left:.5rem}
        .loader{border-top-color:#ef4444;animation:spinner 1.5s linear infinite}
        @keyframes spinner{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
        select,input[type=number],input[type=text]{min-height:48px}
        @media (max-width:1023px){.recipe-card .grid{display:flex;flex-direction:column}.recipe-card .order-1{order:1}.recipe-card .order-2{order:2}}
    </style>
</head>
<body class="p-4 md:p-8">
    <div class="max-w-5xl mx-auto container-wrapper">
        <header class="text-center mb-8">
            <h1 class="text-4xl font-extrabold text-red-600 mb-2">مُولِّد الوصفات الذكي</h1>
            <p class="text-gray-600 text-lg">اختر تفضيلاتك الغذائية ودع الذكاء الاصطناعي يُحضّر لك وجبتك المثالية.</p>
        </header>

        <div class="bg-white p-6 md:p-8 rounded-xl shadow-lg mb-8">
            <h2 class="text-2xl font-bold text-gray-800 mb-6 border-b pb-3 border-gray-100">حدد مواصفات الوجبة والنظام الغذائي</h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                <div>
                    <label for="mealType" class="block text-sm font-medium text-gray-700 mb-1">نوع الوجبة</label>
                    <select id="mealType" class="mt-1 block w-full pl-3 pr-10 py-3 text-base border-gray-300 focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm rounded-md shadow-sm border">
                        <option value="غداء">غداء</option>
                        <option value="فطور">فطور</option>
                        <option value="عشاء" selected>عشاء</option>
                        <option value="وجبة خفيفة">وجبة خفيفة</option>
                    </select>
                </div>
                <div>
                    <label for="cuisine" class="block text-sm font-medium text-gray-700 mb-1">المطبخ</label>
                    <select id="cuisine" class="mt-1 block w-full pl-3 pr-10 py-3 text-base border-gray-300 focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm rounded-md shadow-sm border">
                        <option value="شرق أوسطي" selected>شرق أوسطي</option>
                        <option value="مطبخ مصري">مطبخ مصري</option>
                        <option value="مطبخ شامي (لبناني، سوري، أردني، فلسطيني)">مطبخ شامي</option>
                        <option value="مطبخ خليجي (سعودي، إماراتي، كويتي)">مطبخ خليجي</option>
                        <option value="مطبخ مغربي/تونسي/جزائري">مطبخ مغربي/تونسي/جزائري</option>
                        <option value="مطبخ يمني">مطبخ يمني</option>
                        <option value="إيطالي">إيطالي</option>
                        <option value="آسيوي">آسيوي (كوري، ياباني، صيني)</option>
                        <option value="عالمي/مُبتكر">عالمي/مُبتكر</option>
                    </select>
                </div>
                <div>
                    <label for="dietType" class="block text-sm font-medium text-gray-700 mb-1">النظام الغذائي المتبع</label>
                    <select id="dietType" class="mt-1 block w-full pl-3 pr-10 py-3 text-base border-gray-300 focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm rounded-md shadow-sm border">
                        <option value="عادي/متوازن" selected>عادي / متوازن</option>
                        <option value="نظام د. محمد سعيد">نظام د. محمد سعيد</option>
                        <option value="كيتو">كيتو</option>
                        <option value="نباتي (فيجيتاريان)">نباتي (Vegetarian)</option>
                        <option value="فيجن (نباتي صرف)">فيجن (Vegan)</option>
                        <option value="قليل الكربوهيدرات">قليل الكربوهيدرات</option>
                        <option value="خالي من الجلوتين">خالي من الجلوتين</option>
                        <option value="عالي البروتين">عالي البروتين</option>
                    </select>
                </div>
                <div>
                    <label for="calorieTarget" class="block text-sm font-medium text-gray-700 mb-1">السعرات الحرارية المطلوبة (لكل حصة)</label>
                    <input type="number" id="calorieTarget" min="100" max="2000" step="50" placeholder="مثال: 500 سعرة" value="550" class="mt-1 block w-full px-3 py-3 text-base border-gray-300 focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm rounded-md shadow-sm border">
                </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
                <div>
                    <label for="commonAllergy" class="block text-sm font-medium text-gray-700 mb-1">الحساسية الغذائية الشائعة</label>
                    <select id="commonAllergy" class="mt-1 block w-full pl-3 pr-10 py-3 text-base border-gray-300 focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm rounded-md shadow-sm border">
                        <option value="لا يوجد" selected>لا يوجد</option>
                        <option value="حساسية القمح/الجلوتين">القمح / الجلوتين</option>
                        <option value="حساسية الألبان/اللاكتوز">الألبان / اللاكتوز</option>
                        <option value="حساسية المكسرات">المكسرات</option>
                        <option value="حساسية البيض">البيض</option>
                        <option value="حساسية المأكولات البحرية">المأكولات البحرية</option>
                        <option value="حساسية فول الصويا">فول الصويا</option>
                    </select>
                </div>
                <div>
                    <label for="customAllergy" class="block text-sm font-medium text-gray-700 mb-1">حساسية أو مكونات أخرى يجب تجنبها (اختياري)</label>
                    <input type="text" id="customAllergy" placeholder="اكتب المكونات التي لديك حساسية منها" class="mt-1 block w-full px-3 py-3 text-base border-gray-300 focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm rounded-md shadow-sm border">
                </div>
            </div>
            <div class="mt-6">
                <label for="focus" class="block text-sm font-medium text-gray-700 mb-1">المكون الرئيسي / التركيز (اختياري)</label>
                <input type="text" id="focus" placeholder="مثل: دجاج و خضار" class="mt-1 block w-full px-3 py-3 text-base border-gray-300 focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm rounded-md shadow-sm border">
            </div>
            <button id="generateBtn" class="mt-6 w-full flex justify-center items-center py-3 px-4 border border-transparent text-lg font-medium rounded-xl text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition duration-150 ease-in-out shadow-md hover:shadow-lg disabled:bg-red-400">
                <div id="loadingIndicator" class="hidden w-5 h-5 border-2 border-dashed rounded-full loader ml-2"></div>
                توليد الوصفة الآن
            </button>
            <p id="errorMsg" class="mt-3 text-center text-sm text-red-500 hidden"></p>
        </div>

        <div id="recipeOutput" class="recipe-card bg-white p-6 md:p-8 rounded-xl border border-gray-200 hidden">
            <div class="text-center mb-6">
                <h2 id="recipeTitle" class="text-3xl font-extrabold text-gray-900 mb-2"></h2>
                <div class="flex flex-col sm:flex-row justify-center items-center space-y-2 sm:space-y-0 sm:space-x-4 sm:space-x-reverse text-gray-500 text-sm font-medium">
                    <p class="flex items-center"><span id="timeValue"></span></p>
                    <p class="flex items-center"><span id="servingsValue"></span></p>
                </div>
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 border-t pt-6 border-gray-100">
                <div class="lg:col-span-1 order-1">
                    <div class="bg-white p-4 md:p-6 rounded-xl mb-6 flex flex-col items-center border border-gray-100 shadow-sm">
                        <h3 class="text-xl font-bold text-red-600 mb-4">القيمة الغذائية (لكل حصة)</h3>
                        <div class="mb-6 w-36 h-36 flex flex-col items-center justify-center rounded-full bg-red-100 border-4 border-red-500 shadow-md">
                            <div id="caloriesValue" class="text-3xl font-black text-gray-900"></div>
                            <div class="text-sm font-medium text-red-600">سعرة حرارية</div>
                        </div>
                        <div class="w-full grid grid-cols-3 gap-3 text-center">
                            <div class="p-2 rounded-lg bg-green-50 border border-green-200"><div id="proteinValue" class="text-xl font-bold text-green-700"></div><div class="text-xs font-medium text-gray-600 mt-1">بروتين</div></div>
                            <div class="p-2 rounded-lg bg-blue-50 border border-blue-200"><div id="carbsValue" class="text-xl font-bold text-blue-700"></div><div class="text-xs font-medium text-gray-600 mt-1">كربوهيدرات</div></div>
                            <div class="p-2 rounded-lg bg-yellow-50 border border-yellow-200"><div id="fatsValue" class="text-xl font-bold text-yellow-700"></div><div class="text-xs font-medium text-gray-600 mt-1">دهون</div></div>
                        </div>
                    </div>
                    <div>
                        <h3 class="text-2xl font-bold text-gray-800 mb-4 border-b pb-2 border-gray-100">المكونات:</h3>
                        <ul id="ingredientsList" class="ingredient-list pr-4 text-gray-700"></ul>
                    </div>
                </div>
                <div class="lg:col-span-2 order-2">
                    <h3 class="text-2xl font-extrabold text-gray-900 mb-6 border-b pb-2 border-gray-100">طريقة التحضير:</h3>
                    <div id="preparationSteps" class="space-y-4"></div>
                </div>
            </div>
        </div>
    </div>

    <script type="module">
        const mealTypeEl=document.getElementById('mealType');
        const cuisineEl=document.getElementById('cuisine');
        const dietTypeEl=document.getElementById('dietType');
        const calorieTargetEl=document.getElementById('calorieTarget');
        const commonAllergyEl=document.getElementById('commonAllergy');
        const customAllergyEl=document.getElementById('customAllergy');
        const focusEl=document.getElementById('focus');
        const generateBtn=document.getElementById('generateBtn');
        const loadingIndicator=document.getElementById('loadingIndicator');
        const errorMsg=document.getElementById('errorMsg');
        const recipeOutput=document.getElementById('recipeOutput');
        const recipeTitle=document.getElementById('recipeTitle');
        const timeValue=document.getElementById('timeValue');
        const servingsValue=document.getElementById('servingsValue');
        const caloriesValue=document.getElementById('caloriesValue');
        const proteinValue=document.getElementById('proteinValue');
        const carbsValue=document.getElementById('carbsValue');
        const fatsValue=document.getElementById('fatsValue');
        const ingredientsList=document.getElementById('ingredientsList');
        const preparationSteps=document.getElementById('preparationSteps');

        function renderRecipe(data){
            recipeTitle.textContent=data.title||'';
            timeValue.textContent=data.time||'';
            servingsValue.textContent=data.servings||'';
            const m=data.macros||{};
            caloriesValue.textContent=`${m.calories||''}`;
            proteinValue.textContent=`${m.protein||''} جم`;
            carbsValue.textContent=`${m.carbs||''} جم`;
            fatsValue.textContent=`${m.fats||''} جم`;
            ingredientsList.innerHTML='';
            (data.ingredients||[]).forEach(ing=>{
                const li=document.createElement('li');
                li.innerHTML=`<span class="font-bold text-gray-800">${ing.name}</span> <span class="text-gray-500 text-sm mr-2">(${ing.quantity})</span>`;
                ingredientsList.appendChild(li);
            });
            preparationSteps.innerHTML='';
            (data.preparation||[]).forEach(step=>{
                const div=document.createElement('div');
                div.className='prep-step';
                div.innerHTML=`<div class="step-title">${step.title}</div><p class="text-gray-600 pr-0 text-base">${step.instruction}</p>`;
                preparationSteps.appendChild(div);
            });
            recipeOutput.classList.remove('hidden');
            setTimeout(()=>{window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});},100);
        }

        async function generateRecipe(){
            const payload={
                mealType:mealTypeEl.value,
                cuisine:cuisineEl.value,
                dietType:dietTypeEl.value,
                calorieTarget:calorieTargetEl.value,
                commonAllergy:commonAllergyEl.value,
                customAllergy:customAllergyEl.value.trim(),
                focus:(focusEl.value||'').trim()||'مُبتكرة وعصرية'
            };
            const res=await fetch('/.netlify/functions/generateRecipe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
            const text=await res.text();
            if(!res.ok){ throw new Error(`خادم التوليد أعاد ${res.status}: ${text.slice(0,300)}`); }
            let json={};
            try{ json=JSON.parse(text); }catch(e){ throw new Error('استجابة غير صالحة من الخادم: '+text.slice(0,200)); }
            if(!json.ok||!json.recipe){ throw new Error(json.error||json.message||'invalid_response'); }
            return json.recipe;
        }

        generateBtn.addEventListener('click',async()=>{
            if(!calorieTargetEl.value||parseInt(calorieTargetEl.value)<100||parseInt(calorieTargetEl.value)>2000){
                errorMsg.textContent='يرجى إدخال قيمة سعرات صحيحة بين 100 و 2000.';
                errorMsg.classList.remove('hidden');
                return;
            }
            generateBtn.disabled=true;loadingIndicator.classList.remove('hidden');errorMsg.classList.add('hidden');recipeOutput.classList.add('hidden');
            generateBtn.innerHTML='<div class="w-5 h-5 border-2 border-dashed rounded-full loader ml-2"></div> جارٍ التوليد...';
            try{
                const recipe=await generateRecipe();
                renderRecipe(recipe);
            }catch(err){
                errorMsg.textContent=err.message;errorMsg.classList.remove('hidden');
            }finally{
                generateBtn.disabled=false;loadingIndicator.classList.add('hidden');generateBtn.textContent='توليد الوصفة الآن';
            }
        });
    </script>
</body>
</html>
