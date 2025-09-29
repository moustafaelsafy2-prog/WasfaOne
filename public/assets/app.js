// Netlify Function: generateRecipe
// هذا الإصدار مُعدَّل لأغراض التشخيص: تم تعطيل المصادقة وحفظ التاريخ (GitHub).

const OWNER = process.env.GITHUB_REPO_OWNER; // موجود فقط للتصريح عن المتغير
const REPO = process.env.GITHUB_REPO_NAME;   // موجود فقط للتصريح عن المتغير
const GH_TOKEN = process.env.GITHUB_TOKEN;   // موجود فقط للتصريح عن المتغير
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 

const GH_API = "https://api.github.com"; // لم يعد يُستخدم

// تم تبسيط دالة المصادقة للسماح بالوصول دائماً في وضع التشخيص
async function auth(event){
  const email = "guest_for_diagnosis@example.com";
  // لن نستخدم أي منطق GitHub هنا
  return { ok:true, email, user: {} }; 
}

// تم تعطيل جميع دوال GitHub

function sanitizeEmail(email){ return (email||"").toLowerCase().replace(/[^a-z0-9]+/g,"_"); }

function stableHash(obj){
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 5381; for(let i=0;i<s.length;i++){ h=((h<<5)+h)+s.charCodeAt(i); h|=0; }
  return (h>>>0).toString(16);
}

function validateRecipeSchema(rec){
  const baseKeys = ["title","servings","total_time_min","macros","ingredients","steps","lang"];
  if(typeof rec!=="object" || rec===null) return { ok:false, error:"not_object" };
  for(const k of baseKeys){ if(!(k in rec)) return { ok:false, error:`missing_${k}` }; }
  if(typeof rec.title!=="string") return { ok:false, error:"title_type" };
  if(typeof rec.servings!=="number") return { ok:false, error:"servings_type" };
  if(typeof rec.total_time_min!=="number") return { ok:false, error:"time_type" };
  if(!rec.macros || typeof rec.macros!=="object") return { ok:false, error:"macros_type" };
  for(const m of ["protein_g","carbs_g","fat_g","calories"]){ if(typeof rec.macros[m] !== "number") return { ok:false, error:`macro_${m}` }; }
  if(!Array.isArray(rec.ingredients) || rec.ingredients.some(x=>typeof x!=="string")) return { ok:false, error:"ingredients_type" };
  if(!Array.isArray(rec.steps) || rec.steps.some(x=>typeof x!=="string")) return { ok:false, error:"steps_type" };
  if(rec.lang!=="ar" && rec.lang!=="en") return { ok:false, error:"lang_invalid" };
  return { ok:true };
}

function buildPrompt(input){
  const { diet, servings, time, macros, ingredients } = input;
  
  let dietConstraints = `النظام الغذائي: ${diet}.`;
  if (diet.includes("د. محمد سعيد")) {
      dietConstraints = `
        **يجب أن تلتزم بدقة بمتطلبات نظام د. محمد سعيد (نظام كيتوني معدّل):**
        - خالية تماماً من الكربوهيدرات المرتفعة والسكريات.
        - خالية تماماً من الجلوتين، اللاكتوز، الليكتين، البقوليات والزيوت المهدرجة.
        - مسموح فقط بالدهون الصحية (مثل زيت الزيتون، الأفوكادو).
        - مسموح فقط بالأجبان الدسمة من أصل حيواني والزبادي اليوناني.
      `;
  }
  
  const ingredientsConstraint = ingredients || "بدون";
  const macrosConstraint = macros || "بدون";
  
  return `أنت مساعد طاهٍ محترف. أعد وصفة طعام باللغة العربية فقط وبنية JSON STRICT دون أي شرح خارج JSON.
  
المتطلبات الحتمية:
- نفس البنية دائمًا بالمفاتيح: title (نص), servings (رقم صحيح), total_time_min (رقم صحيح), macros:{protein_g (رقم صحيح),carbs_g (رقم صحيح),fat_g (رقم صحيح),calories (رقم صحيح)}, ingredients[] (مصفوفة نصوص), steps[] (مصفوفة نصوص), lang (ar).
- يجب أن تكون جميع قيَم الماكروز والسعرات الحرارية والوقت والحصص أرقامًا صحيحة.
- lang="ar".
- ${dietConstraints} عدد الحصص: ${servings}. الوقت الأقصى (للتوليد التلقائي): ${time} دقيقة.
- يجب أن تكون المكونات المتوفرة (أو القيود المطلوبة): ${ingredientsConstraint}.
- يجب أن تكون الماكروز المستهدفة: ${macrosConstraint}.
- **الأهم:** يجب أن تكون المكونات في مصفوفة 'ingredients' مفصلة بكميات وأسماء مثل: "150 جرام (كوب واحد) دقيق لوز"

أعِد JSON فقط بلا شروحات ولا Markdown.`;
}

async function callGeminiOnce(url, body){
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
      try {
          const r = await fetch(url, { 
              method:"POST", 
              headers:{ "Content-Type":"application/json" }, 
              body: JSON.stringify(body) 
          });
          
          const jr = await r.json();

          if(!r.ok) {
              const errorMessage = jr.error?.message || `HTTP Error ${r.status}`;
              if (r.status === 429 && i < maxRetries - 1) {
                  const delay = Math.pow(2, i) * 1000 + Math.random()*1000;
                  await new Promise(r => setTimeout(r, delay));
                  continue;
              }
              // إرجاع كود الخطأ ورسالة الخطأ من API
              return { ok:false, code:r.status, text:null, error: errorMessage };
          }
          
          const text = (((jr.candidates||[])[0]||{}).content||{}).parts?.map(p=>p.text).join("") || "";
          return { ok:true, code:200, text };

      } catch (e) {
          if (i < maxRetries - 1) {
              const delay = Math.pow(2, i) * 1000 + Math.random()*1000;
              await new Promise(r => setTimeout(r, delay));
              continue;
          }
          return { ok:false, code:500, text: null, error: e.message };
      }
  }
}

async function callGemini(prompt){
  if(!GEMINI_API_KEY) return { ok:false, reason:"no_key", code: 401 };

  const schema = {
      type: "OBJECT",
      properties: {
          title: { type: "STRING" },
          servings: { type: "NUMBER" },
          total_time_min: { type: "NUMBER" },
          macros: {
              type: "OBJECT",
              properties: {
                  protein_g: { type: "NUMBER" },
                  carbs_g: { type: "NUMBER" },
                  fat_g: { type: "NUMBER" },
                  calories: { type: "NUMBER" }
              },
              required: ["protein_g", "carbs_g", "fat_g", "calories"]
          },
          ingredients: { type: "ARRAY", items: { type: "STRING" } },
          steps: { type: "ARRAY", items: { type: "STRING" } },
          lang: { type: "STRING" }
      },
      required: ["title", "servings", "total_time_min", "macros", "ingredients", "steps", "lang"]
  };

  const body = {
    contents: [{ role:"user", parts:[{ text: prompt }]}],
    generationConfig: { 
        temperature: 0.7,
        topP: 1, 
        topK: 1, 
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: schema
    },
    safetySettings: []
  };

  const modelName = "gemini-2.5-flash-preview-05-20";
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  
  let aiRes = await callGeminiOnce(apiUrl, body);

  if (!aiRes.ok) { return aiRes; }
  
  return aiRes;
}

function tryParseJsonFromText(t){
  if(!t) return null;
  let s = t.trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim();
  const first = s.indexOf("{"); const last = s.lastIndexOf("}");
  if(first !== -1 && last !== -1) s = s.slice(first, last+1);
  try{ return JSON.parse(s); }catch(e){ 
    console.error("JSON Parse failed:", e, "Text:", t);
    return null; 
  }
}

function fallbackRecipe(input){
  const s = Number(input.servings)||1;
  const t = 30;
  const constraints = (input.ingredients? String(input.ingredients).split(/[،,]/).map(x=>x.trim()).filter(Boolean) : []);
  const baseIng = constraints.length? constraints : ["صدر دجاج (200 جرام)","أرز أبيض مطبوخ (150 جرام)","بروكلي (100 جرام)","زيت زيتون (1 ملعقة صغيرة)","ملح","فلفل"];
  const targetCaloriesMatch = (input.macros || "").match(/(\d+)\s*سعرة/);
  const targetCalories = targetCaloriesMatch ? Number(targetCaloriesMatch[1]) : 600;

  return {
    title: `وجبة ${input.diet||"متوازنة"} سريعة (وصفة افتراضية)`,
    servings: s,
    total_time_min: t,
    macros: { protein_g: Math.round(targetCalories*0.35/4/s), carbs_g: Math.round(targetCalories*0.35/4/s), fat_g: Math.round(targetCalories*0.3/9/s), calories: targetCalories },
    ingredients: baseIng,
    steps: [
      "قم بتتبيل المكونات الرئيسية (مثل الدجاج) بالملح والفلفل.",
      "اشوِ البروتين أو اطهِه حتى النضج التام.",
      "سخّن الأرز والخضار وقدم الوجبة كاملة.",
      "قسّم الوجبة إلى حصص متساوية (${s} حصص)."
    ],
    lang: "ar"
  };
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod === "OPTIONS") return { statusCode: 204 };
    if(event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ ok:false, error:"method_not_allowed" }) };

    // Auth (معطلة حالياً لأغراض التشخيص)
    const a = await auth(event);
    
    // Input
    const body = JSON.parse(event.body||"{}");
    const input = {
      email: a.email,
      diet: String(body.diet||"عادي/متوازن"), 
      servings: Number(body.servings||1), 
      time: Number(body.time||30), 
      macros: String(body.macros||"500 سعرة حرارية"), 
      ingredients: String(body.ingredients||"وصفة متوازنة") 
    };
    
    let aiReason = null; 

    // *************** التحقق من المفتاح ***************
    if (!GEMINI_API_KEY) {
        const msg = "فشل الذكاء الاصطناعي: المفتاح (GEMINI_API_KEY) مفقود في إعدادات البيئة (Backend).";
        return { statusCode: 200, body: JSON.stringify({ 
            ok:true, 
            cached:false, 
            recipe: fallbackRecipe(input), 
            note: msg 
        }) };
    }
    // **********************************************

    // Cache (معطلة حالياً)
    let recipe = null;
    let usedAI = false;

    const prompt = buildPrompt(input);
    const aiRes = await callGemini(prompt);
    
    if(!aiRes.ok){
        console.error("Gemini API call failed:", aiRes.code, aiRes.error || "Unknown Error");
        aiReason = aiRes.error || `خطأ HTTP غير محدد (كود: ${aiRes.code})`;
    }

    if(aiRes.ok){
      const parsed = tryParseJsonFromText(aiRes.text);
      if(parsed) { recipe = parsed; usedAI = true; }
    }

    if(!recipe){
      // إذا فشل الاستدعاء أو التحليل، أعد سبب الخطأ الدقيق
      const msg = `فشل توليد الوصفة بالذكاء الاصطناعي. السبب: ${aiReason || 'فشل في تحليل استجابة AI.'} يتم عرض وصفة افتراضية.`;
      recipe = fallbackRecipe(input);
      // لن يتم حفظ الوصفة هنا
      return { statusCode: 200, body: JSON.stringify({ ok:true, cached:false, recipe, note: msg }) };
    }

    // Validate schema
    const v = validateRecipeSchema(recipe);
    if(!v.ok){
      console.error("Generated recipe failed schema validation:", v.error);
      recipe = fallbackRecipe(input);
      const msg = `تم توليد وصفة لكنها لم تتبع البنية المطلوبة (${v.error}). يتم عرض وصفة افتراضية.`;
      return { statusCode: 200, body: JSON.stringify({ ok:true, cached:false, recipe, note: msg }) };
    }

    // لن يتم حفظ التاريخ في هذا الإصدار التشخيصي
    // if(OWNER && REPO && GH_TOKEN) { ... }

    return { statusCode:200, body: JSON.stringify({ ok:true, cached:false, recipe }) };
  }catch(err){
    const msg = "تعذر توليد الوصفة حاليًا بسبب خطأ داخلي. يرجى مراجعة سجلات الخادم.";
    return { statusCode: 200, body: JSON.stringify({ ok:true, cached:false, recipe: fallbackRecipe({ diet:"متوازنة", servings:1, time:30, macros:"500 سعرة حرارية" }) , note: msg }) };
  }
};
