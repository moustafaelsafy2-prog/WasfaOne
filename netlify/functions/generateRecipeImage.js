// netlify/functions/generateRecipeImage.js
// هدف: صورة مُعبّرة قدر الإمكان عن الطبق، مع تجربة كل المزوّدين بالترتيب الأسرع.
// 1) Pexels (محسّن بالترتيب والتقييم الذكي للنتائج)
// 2) Google Generative Language (إن وُجد نموذج صور لحسابك)
// 3) Replicate (FLUX/SDXL) مع negative prompt وثبات seed
// 4) Placeholder كملاذ أخير
//
// الاستجابة ثابتة: { ok: true, image: { data_url, mime, mode } }

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-auth-token, x-session-nonce",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
const ok  = (obj) => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, ...obj }) });
const bad = (code, error, extra = {}) => ({ statusCode: code, headers: HEADERS, body: JSON.stringify({ ok: false, error, ...extra }) });

const PEXELS_KEY    = process.env.PEXELS_API_KEY || "";
const GEMINI_KEY    = process.env.GEMINI_API_KEY || "";
const REPLICATE_KEY = process.env.REPLICATE_API_TOKEN || "";

/* =============== أدوات عامة =============== */
function normalizeList(a, max = 25){
  return (Array.isArray(a) ? a : [])
    .map(s => String(s || "").trim())
    .filter(Boolean)
    .slice(0, max);
}
function tokenize(s){
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu," ")
    .replace(/\s+/g," ")
    .trim()
    .split(" ")
    .filter(Boolean);
}
function uniq(arr){ return Array.from(new Set(arr)); }

function cuisineHints(c){
  const m = String(c||"").toLowerCase();
  if(/عراقي|iraqi/.test(m)) return ["iraqi","middle eastern","arab","levant","grill","kebab"];
  if(/شامي|levant|syria|leban|فلسطين|اردن/.test(m)) return ["levant","arab","middle eastern","mezze","grill","kebab"];
  if(/مصري|egypt/.test(m)) return ["egyptian","arab","middle eastern","grill"];
  if(/خليج|saudi|kuwait|emirati|qatari|omani|bahraini/.test(m)) return ["gulf","arab","middle eastern"];
  if(/تركي|turk/.test(m)) return ["turkish","kebab","grill","meze"];
  if(/هندي|india/.test(m)) return ["indian","curry","masala","spices"];
  if(/ايراني|فارسي|persian|iran/.test(m)) return ["persian","kebab","saffron"];
  if(/متوسطي|medit/.test(m)) return ["mediterranean","olive oil","fresh"];
  return ["food","dish","cooked","plated"];
}

function buildTextPrompt({ title = "", ingredients = [], steps = [], cuisine = "", lang = "ar" }){
  const titleLine = title ? `اسم الطبق: ${title}` : "اسم الطبق غير محدد";
  const ingLine   = ingredients.length ? `المكوّنات: ${ingredients.join(", ")}` : "المكوّنات: —";
  const stepsLine = steps.length ? `ملخص التحضير: ${steps.join(" ثم ")}` : "طريقة التحضير: —";
  const cuiLine   = cuisine ? `المطبخ: ${cuisine}` : "المطبخ: متنوع";

  const ar = `
أنت مصوّر أطعمة محترف. أنشئ صورة فوتوغرافية واقعية للطبق النهائي:
${titleLine}
${cuiLine}
${ingLine}
${stepsLine}

[أسلوب التصوير]
- زاوية 30–45°، إضاءة طبيعية ناعمة، عمق ميدان ضحل خفيف.
- تقديم أنيق على طبق مناسب، خلفية مطبخية محايدة.
- بدون أي نصوص/شعارات/علامات مائية، وبدون أشخاص/أيدي.
- ألوان واقعية شهية تُبرز المكوّنات.

أخرج صورة واحدة مناسبة للويب.
`.trim();

  const en = `
You are a professional food photographer. Generate one photorealistic final dish image:
Title: ${title || "N/A"}
Cuisine: ${cuisine || "Mixed"}
Key ingredients: ${(ingredients||[]).join(", ") || "—"}
Preparation summary: ${(steps||[]).join(" then ") || "—"}

[Style]
- 30–45° angle, soft natural light, slight shallow depth of field.
- Elegant plating, neutral kitchen backdrop.
- No text/logos/watermarks; no people/hands.
- Realistic, appetizing colors emphasizing the listed ingredients.

Return exactly one web-suitable image.
`.trim();

  return (lang === "en") ? en : ar;
}

function buildNegativePrompt(){
  return "text, watermark, logo, person, hands, fingers, human, cartoon, blurry, low quality, lowres, overexposed, underexposed, artifacts, extra objects, cut off, wrong ingredients";
}

function stableSeedFrom(str){
  // رقم ثابت مشتق من النص لإعادة إنتاج نتيجة مشابهة
  let h = 2166136261;
  for (let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h += (h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24); }
  return Math.abs(h >>> 0);
}

async function fetchAsDataURL(imageUrl, timeoutMs = 20000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  const resp = await fetch(imageUrl, { signal: ctrl.signal });
  clearTimeout(t);
  if(!resp.ok) throw new Error(`image_fetch_HTTP_${resp.status}`);
  const mime = resp.headers.get("content-type") || "image/jpeg";
  const buf  = Buffer.from(await resp.arrayBuffer());
  const b64  = buf.toString("base64");
  return { dataUrl: `data:${mime};base64,${b64}`, mime };
}

/* =============== 1) PEXELS (محسّن) =============== */
async function scorePexelsCandidate(photo, title, ingredients, cuisine){
  // نحسب درجة ارتباط بناءً على ال-alt والـ url
  const text = (photo?.alt || "") + " " + (photo?.url || "");
  const toks = tokenize(text);
  if (!toks.length) return -1;

  const titleTokens = uniq(tokenize(title));
  const ingTokens   = uniq(normalizeList(ingredients, 6).flatMap(tokenize));
  const cuiTokens   = uniq(cuisineHints(cuisine));

  let score = 0;

  // مطابقة اسم الطبق (وزن عالي)
  for (const tk of titleTokens) if (toks.includes(tk)) score += 5;

  // مطابقة المكونات (وزن متوسط)
  for (const tk of ingTokens) if (toks.includes(tk)) score += 2;

  // تلميحات للمطبخ وكلمات "food/dish"
  for (const tk of cuiTokens) if (toks.includes(tk.toLowerCase())) score += 1;

  // تعزيز لو كان الوصف يحوي كلمات تصوير طعام
  const boostWords = ["food","dish","grill","kebab","salad","stew","soup","plate","cooked","roasted","baked","meat","vegetable","rice"];
  for (const bw of boostWords) if (toks.includes(bw)) score += 1;

  return score;
}

async function tryPexelsEnhanced({ title, ingredients, cuisine }){
  if(!PEXELS_KEY) return null;

  // نبني عدة استعلامات قصيرة؛ نجرب الأسرع أولًا
  const queries = uniq([
    [title, cuisine].filter(Boolean).join(" "),
    [title, "food"].filter(Boolean).join(" "),
    [cuisine, "traditional dish"].filter(Boolean).join(" "),
    [title, ingredients.slice(0,2).join(" ")].filter(Boolean).join(" "),
    "arab food dish",
  ].map(q => q.trim()).filter(Boolean));

  // نبحث في أول استعلام قوي بـ per_page=12 ثم نقيّم محليًا
  const primary = queries[0] || (title || "dish");
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(primary)}&per_page=12&orientation=landscape`;

  const ctrl = new AbortController();
  const timeout = setTimeout(()=>ctrl.abort(), 9000);
  const resp = await fetch(url, { headers: { Authorization: PEXELS_KEY }, signal: ctrl.signal });
  clearTimeout(timeout);

  const text = await resp.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if(!resp.ok || !Array.isArray(data?.photos) || data.photos.length === 0) {
    return null;
  }

  // قيّم كل صورة واختر الأعلى
  let best = null, bestScore = -1;
  for (const p of data.photos){
    const s = await scorePexelsCandidate(p, title, ingredients, cuisine);
    if (s > bestScore){ best = p; bestScore = s; }
  }
  // إن لم يفلح التقييم (كلها سلبية) اختر أول نتيجة
  const chosen = best || data.photos[0];
  const candidate = chosen?.src?.large2x || chosen?.src?.large || chosen?.src?.medium || chosen?.src?.original;
  if(!candidate) return null;

  try{
    const { dataUrl, mime } = await fetchAsDataURL(candidate, 15000);
    return { dataUrl, mime, mode: "inline" };
  }catch{ return null; }
}

/* =============== 2) Google (إن توفر نموذج صور) =============== */
const GL_BASE = "https://generativelanguage.googleapis.com/v1beta";
let cachedModels = null;
let cachedImageModel = null;

async function glListModels(){
  if(!GEMINI_KEY) throw new Error("no_gemini_key");
  if(cachedModels) return cachedModels;

  const url = `${GL_BASE}/models`;
  const ctrl = new AbortController();
  const timeout = setTimeout(()=>ctrl.abort(), 8000);
  const resp = await fetch(url, { headers: { "x-goog-api-key": GEMINI_KEY }, signal: ctrl.signal });
  clearTimeout(timeout);

  const text = await resp.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if(!resp.ok) throw new Error(data?.error?.message || `listModels_HTTP_${resp.status}`);
  cachedModels = Array.isArray(data?.models) ? data.models : [];
  return cachedModels;
}
function pickImageModelFrom(models){
  const hasGC = (m) => Array.isArray(m?.supportedGenerationMethods)
    ? m.supportedGenerationMethods.includes("generateContent")
    : true;
  const imagen = models.find(m => /(^|\/)models\/.*imagen/i.test(m?.name||"") && hasGC(m));
  if (imagen?.name) return imagen.name.replace(/^models\//, "");
  const imageLike = models.find(m => /(^|\/)models\/.*image/i.test(m?.name||"") && hasGC(m));
  if (imageLike?.name) return imageLike.name.replace(/^models\//, "");
  return null;
}
async function tryGoogleImage(prompt){
  if(!GEMINI_KEY) return null;
  try{
    if(!cachedImageModel){
      const models = await glListModels();
      cachedImageModel = pickImageModelFrom(models);
      if(!cachedImageModel) return null;
    }
    const url = `${GL_BASE}/models/${encodeURIComponent(cachedImageModel)}:generateContent`;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, topP: 1, maxOutputTokens: 64 },
      safetySettings: []
    };
    const ctrl = new AbortController();
    const timeout = setTimeout(()=>ctrl.abort(), 12000);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timeout);
    const raw = await resp.text();
    let data = null; try { data = JSON.parse(raw); } catch {}
    if(!resp.ok) return null;

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const found = parts.find(p =>
      (p && p.inlineData  && /^image\//i.test(p.inlineData?.mimeType  || "")) ||
      (p && p.inline_data && /^image\//i.test(p.inline_data?.mime_type || "")) ||
      (p && p.fileData    && /^image\//i.test(p.fileData?.mimeType    || ""))
    );
    if(!found) return null;

    const mime =
      found.inlineData?.mimeType ||
      found.inline_data?.mime_type ||
      found.fileData?.mimeType ||
      "image/png";

    const b64 =
      found.inlineData?.data ||
      found.inline_data?.data ||
      null;

    if (!b64 && found.fileData?.fileUri) {
      const { dataUrl, mime: m2 } = await fetchAsDataURL(found.fileData.fileUri, 20000);
      return { dataUrl, mime: m2 || mime, mode: "inline" };
    }
    if (!b64) return null;

    return { dataUrl: `data:${mime};base64,${b64}`, mime, mode: "inline" };
  }catch{ return null; }
}

/* =============== 3) Replicate (FLUX/SDXL مع negative) =============== */
const REPLICATE_MODEL_CANDIDATES = [
  { owner:"black-forest-labs", name:"flux-schnell" }, // أسرع
  { owner:"stability-ai",      name:"sdxl" }          // أدق
];
async function replicateLatestVersion(owner, name){
  const url = `https://api.replicate.com/v1/models/${owner}/${name}/versions`;
  const ctrl = new AbortController();
  const timeout = setTimeout(()=>ctrl.abort(), 8000);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${REPLICATE_KEY}` }, signal: ctrl.signal });
  clearTimeout(timeout);
  const data = await resp.json().catch(()=> ({}));
  if(!resp.ok) throw new Error(data?.detail || `replicate_versions_HTTP_${resp.status}`);
  const v = (Array.isArray(data?.results) ? data.results[0] : null);
  if(!v?.id) throw new Error("replicate_no_versions");
  return v.id;
}
async function replicatePredict(versionId, input, overallTimeoutMs=45000){
  const create = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPLICATE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ version: versionId, input })
  });
  const created = await create.json().catch(()=> ({}));
  if(!create.ok) throw new Error(created?.detail || `replicate_create_HTTP_${create.status}`);
  const id = created?.id; if(!id) throw new Error("replicate_no_id");

  const t0 = Date.now();
  while(true){
    await new Promise(r=>setTimeout(r, 900));
    const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${REPLICATE_KEY}` }
    });
    const js = await r.json().catch(()=> ({}));
    const st = js?.status;
    if(st === "succeeded"){
      const out = js?.output;
      const first = Array.isArray(out) ? out[0] : (typeof out === "string" ? out : null);
      if(!first) throw new Error("replicate_empty_output");
      return first;
    }
    if(st === "failed" || st === "canceled") throw new Error(`replicate_${st}`);
    if(Date.now() - t0 > overallTimeoutMs) throw new Error("replicate_timeout");
  }
}
async function tryReplicateEnhanced(textPrompt, seed){
  if(!REPLICATE_KEY) return null;
  const negative = buildNegativePrompt();
  let lastErr = null;
  for(const m of REPLICATE_MODEL_CANDIDATES){
    try{
      const version = await replicateLatestVersion(m.owner, m.name);
      const input = (m.name === "sdxl")
        ? { prompt: textPrompt, negative_prompt: negative, width: 768, height: 512, scheduler:"K_EULER", num_inference_steps: 28, guidance_scale: 7.0, seed }
        : { prompt: textPrompt, negative_prompt: negative, width: 768, height: 512, num_inference_steps: 8, seed };
      const url = await replicatePredict(version, input);
      const { dataUrl, mime } = await fetchAsDataURL(url, 20000);
      return { dataUrl, mime, mode: "inline" };
    }catch(e){ lastErr = e && e.message || String(e); }
  }
  return null;
}

/* =============== 4) Placeholder =============== */
function placeholderDataURL(){
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="256" height="256">
      <rect width="128" height="128" fill="#f8fafc"/>
      <circle cx="64" cy="64" r="44" fill="#ffffff" stroke="#e5e7eb" stroke-width="4"/>
      <circle cx="64" cy="64" r="24" fill="#fde68a" stroke="#f59e0b" stroke-width="3"/>
      <g fill="#94a3b8">
        <rect x="18" y="30" width="8" height="68" rx="2"/>
        <circle cx="22" cy="26" r="4"/>
        <rect x="102" y="30" width="8" height="68" rx="2"/>
      </g>
    </svg>`;
  const encoded = encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
  return `data:image/svg+xml;utf8,${encoded}`;
}

/* =============== HTTP Handler =============== */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };

  if (event.httpMethod === "GET") {
    return ok({
      info: "generateRecipeImage is alive. Use POST to generate an image.",
      providers_available: {
        pexels: !!PEXELS_KEY, google_models: !!GEMINI_KEY, replicate: !!REPLICATE_KEY
      }
    });
  }

  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  // حمولة
  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return ok({ image: { mime: "image/svg+xml", mode: "inline", data_url: placeholderDataURL() } }); }

  const title = String(payload?.title || "").trim();
  const ingredients = normalizeList(payload?.ingredients, 25);
  const steps = normalizeList(payload?.steps, 12);
  const cuisine = String(payload?.cuisine || "").trim();
  const lang = (payload?.lang === "en") ? "en" : "ar";

  const textPrompt = buildTextPrompt({ title, ingredients, steps, cuisine, lang });
  const seed = stableSeedFrom(`${title}|${ingredients.join(",")}|${cuisine}`);

  // 1) Pexels (محسّن)
  try{
    const p = await tryPexelsEnhanced({ title, ingredients, cuisine });
    if(p && p.dataUrl){
      return ok({ image: { mime: p.mime || "image/jpeg", mode: p.mode || "inline", data_url: p.dataUrl } });
    }
  }catch(_){}

  // 2) Google (إن توفر نموذج صور)
  try{
    const g = await tryGoogleImage(textPrompt);
    if(g && g.dataUrl){
      return ok({ image: { mime: g.mime || "image/png", mode: g.mode || "inline", data_url: g.dataUrl } });
    }
  }catch(_){}

  // 3) Replicate (مع negative + seed)
  try{
    const r = await tryReplicateEnhanced(textPrompt, seed);
    if(r && r.dataUrl){
      return ok({ image: { mime: r.mime || "image/png", mode: r.mode || "inline", data_url: r.dataUrl } });
    }
  }catch(_){}

  // 4) Placeholder
  return ok({ image: { mime: "image/svg+xml", mode: "inline", data_url: placeholderDataURL() } });
};
