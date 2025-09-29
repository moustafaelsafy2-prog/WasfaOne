// Netlify Function: generateRecipe
// POST: { email, diet, servings, time, macros, ingredients }
// Requires headers: x-auth-token, x-session-nonce (must match users.json for email)
// Deterministic caching: data/history/{email_sanitized}.json -> { last, cache:{ [hash]: recipe } }

const OWNER = process.env.GITHUB_REPO_OWNER;
const REPO = process.env.GITHUB_REPO_NAME;
const REF = process.env.GITHUB_REF || "main";
const GH_TOKEN = process.env.GITHUB_TOKEN;
// المفتاح مأخوذ من متغيرات البيئة، ويجب أن يكون GEMINI_API_KEY مضبوطًا
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 

const GH_API = "https://api.github.com";

function sanitizeEmail(email){ return (email||"").toLowerCase().replace(/[^a-z0-9]+/g,"_"); }

async function ghGetJson(path, allow404=false){
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${REF}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent":"WasfaOne" }
  });
  if(allow404 && r.status===404) return { json:null, sha:null, notFound:true };
  if(!r.ok) throw new Error(`GitHub GET ${path} ${r.status}`);
  const data = await r.json();
  const decoded = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  return { json: decoded, sha: data.sha };
}
async function ghPutJson(path, obj, sha, message){
  const content = Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64');
  const r = await fetch(`${GH_API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      "User-Agent":"WasfaOne",
      "Content-Type":"application/json"
    },
    body: JSON.stringify({ message, content, sha, branch: REF })
  });
  if(!r.ok) throw new Error(`GitHub PUT ${path} ${r.status}`);
  return r.json();
}

async function auth(event){
  const token = event.headers["x-auth-token"] || event.headers["X-Auth-Token"];
  const nonce = event.headers["x-session-nonce"] || event.headers["X-Session-Nonce"];
  let email = null;
  try{ const body = JSON.parse(event.body||"{}"); email = body.email || null; }catch{}
  
  if(!token || !nonce || !email) {
      if(!GEMINI_API_KEY) {
           console.warn("Auth missing but skipping strict check because GEMINI_API_KEY is also missing. Returning temporary user.");
           return { ok:true, email: "guest@example.com", user: {} };
      }
      return { ok:false, statusCode:401, error:"missing_auth" };
  }

  const { json: users } = await ghGetJson("data/users.json");
  const user = (users||[]).find(u => (u.email||"").toLowerCase() === email.toLowerCase());
  if(!user) return { ok:false, statusCode:401, error:"no_user" };
  if(user.auth_token !== token || user.session_nonce !== nonce) return { ok:false, statusCode:401, error:"bad_token" };
  return { ok:true, email, user };
}

// Stable hash for caching (order-independent)
function stableHash(obj){
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 5381; for(let i=0;i<s.length;i++){ h=((h<<5)+h)+s.charCodeAt(i); h|=0; }
  return (h>>>0).toString(16);
}

// Schema validation (the UI expects this exact shape)
function validateRecipeSchema(rec){
  const baseKeys = ["title","servings","total_time_min","macros","ingredients","steps","lang"];
  if(typeof rec!=="object" || rec===null) return { ok:false, error:"not_object" };
  for(const k of baseKeys){ if(!(k in rec)) return { ok:false, error:`missing_${k}` }; }
  if(typeof rec.title!=="string") return { ok:false, error:"title_type" };
  if(typeof rec.servings!=="number") return { ok:false, error:"servings_type" };
  if(typeof rec.total_time_min!=="number") return { ok:false, error:"time_type" };
  if(!rec.macros || typeof rec.macros!=="object") return { ok:false, error:"macros_type" };
  // تم تبسيط التحقق من الماكروز ليعمل مع الأرقام فقط
  for(const m of ["protein_g","carbs_g","fat_g","calories"]){ if(typeof rec.macros[m] !== "number") return { ok:false, error:`macro_${m}` }; }
  if(!Array.isArray(rec.ingredients) || rec.ingredients.some(x=>typeof x!=="string")) return { ok:false, error:"ingredients_type" };
  if(!Array.isArray(rec.steps) || rec.steps.some(x=>typeof x!=="string")) return { ok:false, error:"steps_type" };
  if(rec.lang!=="ar" && rec.lang!=="en") return { ok:false, error:"lang_invalid" };
  return { ok:true };
}

function buildPrompt(input){
  const { diet, servings, time, macros, ingredients } = input;
  
  // بناء النظام الغذائي الخاص (المنطق من app.html الأصلي)
  let dietConstraints = `النظام الغذائي: ${diet}.`;
  if (diet.includes("د. محمد سعيد")) {
      dietConstraints = `
        **يجب أن تلتزم بدقة بمتطلبات نظام د. محمد سعيد (نظام كيتوني معدّل):**
        - خالية تماماً من الكربوهيدرات المرتفعة والسكريات.
        - خالية تماماً من الجلوتين، اللاكتوز، الليكتين، والبقوليات.
        - خالية تماماً من الزيوت المهدرجة.
        - مسموح فقط بالدهون الصحية (مثل زيت الزيتون، الأفوكادو).
        - مسموح فقط بالأجبان الدسمة من أصل حيواني والزبادي اليوناني.
      `;
  }
  
  // بناء المكونات (حيث تم دمج القيود في app.js)
  const ingredientsConstraint = ingredients || "بدون";
  
  // بناء الماكروز (حيث تم وضع السعرات المستهدفة)
  const macrosConstraint = macros || "بدون";
  
  // يجب أن يعود JSON بنفس البنية التي تم التحقق منها في validateRecipeSchema
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
  // استخدام دالة async/await مع محاولة إعادة المحاولة
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
              // إذا كان الخطأ 429 (معدل محدود)، انتظر وحاول مرة أخرى
              if (r.status === 429 && i < maxRetries - 1) {
                  const delay = Math.pow(2, i) * 1000 + Math.random()*1000;
                  await new Promise(r => setTimeout(r, delay));
                  continue;
              }
              // إرجاع كود الخطأ ورسالة الخطأ من API
              return { ok:false, code:r.status, text:null, error: errorMessage };
          }
          
          // الاستجابة في حالة JSON/Structued generation
          const text = (((jr.candidates||[])[0]||{}).content||{}).parts?.map(p=>p.text).join("") || "";
          return { ok:true, code:200, text };

      } catch (e) {
          // خطأ شبكة، انتظر وحاول مرة أخرى
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
  
  // استدعاء Gemini
  let aiRes = await callGeminiOnce(apiUrl, body);

  if (!aiRes.ok) {
      // إرجاع النتيجة الفاشلة مباشرة إذا لم ينجح الاستدعاء
      return aiRes; 
  }
  
  // إذا نجح الاستدعاء، نستخدم النص المستخرج من callGeminiOnce
  return aiRes;
}

function tryParseJsonFromText(t){
  if(!t) return null;
  // إزالة أي بادئات أو لاحقات غير مرغوب فيها مثل '```json'
  let s = t.trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim();
  // تقطيع الأقواس لتنظيف أي نص إضافي
  const first = s.indexOf("{"); const last = s.lastIndexOf("}");
  if(first !== -1 && last !== -1) s = s.slice(first, last+1);
  try{ return JSON.parse(s); }catch(e){ 
    console.error("JSON Parse failed:", e, "Text:", t);
    return null; 
  }
}

function fallbackRecipe(input){
  const s = Number(input.servings)||1;
  const t = 30; // 30 دقيقة كقيمة افتراضية
  
  // يمكن استخدام حقل ingredients القادم من الواجهة كقيود/مكونات
  const constraints = (input.ingredients? String(input.ingredients).split(/[،,]/).map(x=>x.trim()).filter(Boolean) : []);
  const baseIng = constraints.length? constraints : ["صدر دجاج (200 جرام)","أرز أبيض مطبوخ (150 جرام)","بروكلي (100 جرام)","زيت زيتون (1 ملعقة صغيرة)","ملح","فلفل"];
  
  // محاولة استخلاص السعرات الحرارية المستهدفة من حقل macros إذا كانت موجودة
  const targetCaloriesMatch = (input.macros || "").match(/(\d+)\s*سعرة/);
  const targetCalories = targetCaloriesMatch ? Number(targetCaloriesMatch[1]) : 600;

  return {
    title: `وجبة ${input.diet||"متوازنة"} سريعة`,
    servings: s,
    total_time_min: t,
    // تقديرات الماكروز بناءً على السعرات المستهدفة
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
    if(!OWNER || !REPO || !GH_TOKEN) {
        // إذا كانت متغيرات بيئة GitHub مفقودة
        console.error("GitHub Config Missing!");
    }

    // Auth
    const a = await auth(event);
    if(!a.ok && GEMINI_API_KEY) return { statusCode: a.statusCode, body: JSON.stringify({ ok:false, error:a.error }) };

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
    
    let aiReason = null; // لتخزين سبب فشل AI

    // *************** التحقق من المفتاح ***************
    if (!GEMINI_API_KEY) {
        const msg = "تعذر توليد الوصفة: المفتاح (GEMINI_API_KEY) مفقود في إعدادات البيئة (Backend).";
        return { statusCode: 200, body: JSON.stringify({ 
            ok:true, 
            cached:false, 
            recipe: fallbackRecipe(input), 
            note: msg 
        }) };
    }
    // **********************************************

    // Cache (تُركت دون تغيير)
    const cacheKey = stableHash({ d:input.diet, s:input.servings, t:input.time, m:input.macros, i:input.ingredients });
    const emailSan = sanitizeEmail(a.email);
    const histPath = `data/history/${emailSan}.json`;
    const { json: curHist, sha } = await ghGetJson(histPath, true);
    const history = curHist || { last:null, cache:{} };

    if(history.cache && history.cache[cacheKey]){
      const rec = history.cache[cacheKey];
      return { statusCode:200, body: JSON.stringify({ ok:true, cached:true, recipe: rec }) };
    }

    // Generate via Gemini with robust fallback
    let recipe = null;
    let usedAI = false;

    const prompt = buildPrompt(input);
    const aiRes = await callGemini(prompt);
    
    if(!aiRes.ok){
        console.error("Gemini API call failed:", aiRes.code, aiRes.error || "Unknown Error");
        // تسجيل سبب فشل AI
        aiReason = aiRes.error || `خطأ HTTP غير محدد (كود: ${aiRes.code})`;
    }

    if(aiRes.ok){
      const parsed = tryParseJsonFromText(aiRes.text);
      if(parsed) { recipe = parsed; usedAI = true; }
    }

    if(!recipe){
      // إذا فشل الاستدعاء أو التحليل، أعد سبب الخطأ الدقيق إلى الواجهة
      const msg = `فشل توليد الوصفة بالذكاء الاصطناعي. السبب: ${aiReason || 'فشل في تحليل استجابة AI.'} يتم عرض وصفة افتراضية.`;
      recipe = fallbackRecipe(input);
      // لا يتم حفظ الوصفة الافتراضية هنا لتجنب تكرارها
      return { statusCode: 200, body: JSON.stringify({ ok:true, cached:false, recipe, note: msg }) };
    }

    // Validate schema (تُركت دون تغيير)
    const v = validateRecipeSchema(recipe);
    if(!v.ok){
      console.error("Generated recipe failed schema validation:", v.error);
      recipe = fallbackRecipe(input);
      // يتم إرجاع الوصفة الافتراضية مع رسالة خطأ
      const msg = `تم توليد وصفة لكنها لم تتبع البنية المطلوبة (${v.error}). يتم عرض وصفة افتراضية.`;
      return { statusCode: 200, body: JSON.stringify({ ok:true, cached:false, recipe, note: msg }) };
    }

    // Save (تُركت دون تغيير)
    history.cache = history.cache || {};
    history.cache[cacheKey] = recipe;
    history.last = recipe;
    // التأكد من أن عملية الحفظ لا تتسبب في الفشل إذا لم يكن هناك إعدادات GitHub
    if(OWNER && REPO && GH_TOKEN) {
      await ghPutJson(histPath, history, sha || undefined, `generateRecipe:${a.email}:${cacheKey}${usedAI?":ai":"::fallback"}`);
    } else {
       console.warn("Skipping history save: GitHub config missing.");
    }

    return { statusCode:200, body: JSON.stringify({ ok:true, cached:false, recipe }) };
  }catch(err){
    // Never bubble internal errors to UI; return a friendly message
    const msg = "تعذر توليد الوصفة حاليًا بسبب خطأ داخلي. يرجى مراجعة سجلات الخادم.";
    return { statusCode: 200, body: JSON.stringify({ ok:true, cached:false, recipe: fallbackRecipe({ diet:"متوازنة", servings:1, time:30, macros:"500 سعرة حرارية" }) , note: msg }) };
  }
};
