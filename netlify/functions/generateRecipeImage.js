// netlify/functions/generateRecipeImage.js
// هدف: صورة مُعبّرة فعلاً عن الطبق، مع منع صور الأشخاص أو المشاهد العامة.
// الترتيب: Wikimedia → Pexels (تصفية صارمة) → Google (إن توفر) → Replicate (negative قوي + seed) → Placeholder.
// الاستجابة: { ok:true, image:{ data_url, mime, mode } }

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

/* ================== أدوات عامة ================== */
function normalizeList(a, max=25){
  return (Array.isArray(a)?a:[])
    .map(s=>String(s||"").trim()).filter(Boolean).slice(0,max);
}
function uniq(arr){ return Array.from(new Set(arr)); }
function tokenize(s){
  return String(s||"")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu," ")
    .replace(/\s+/g," ")
    .trim()
    .split(" ")
    .filter(Boolean);
}
function stableSeedFrom(str){
  let h = 2166136261;
  for (let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
  return Math.abs(h>>>0);
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

/* ================== قواعد المطابقة ================== */
// كلمات ممنوعة (وجودها يُقصي النتيجة) — عربي/إنجليزي
const BANNED_TOKENS = [
  "person","people","woman","man","girl","boy","portrait","selfie","model","fitness","yoga","travel",
  "tourist","lifestyle","fashion","dress","beach","mountain","forest","city","wedding","family","couple",
  "رجل","امرأة","نساء","بنات","فتاة","شخص","اشخاص","أشخاص","عائلة","طفل","أزياء","سيلفي","رحلة","بحر","شاطئ"
];

// كلمات مُحبّذة تؤكد أنها أكل/طبق
const FOOD_HINTS = [
  "food","dish","plate","plated","meal","cooked","baked","roasted","grilled","stew","soup","salad","kebab","kabob",
  "kofta","shawarma","rice","meat","chicken","beef","lamb","vegetable","herbs","sauce","garnish","olive","tagine",
  "mezze","hummus","falafel","fattoush","tabbouleh","baba","moussaka","mandi","kabsa","dolma","mahshi","moussakhan",
  "cuisine","restaurant","kitchen"
];

// تحويل اسم الطبق إلى مفاتيح إنجليزية شائعة (للأطباق العربية)
function dishSynonyms(title){
  const t = String(title||"").toLowerCase();
  const m = [];
  if(/كباب|kebab/.test(t)) m.push("kebab","kabob","grilled meat");
  if(/كفتة|كفته|kofta/.test(t)) m.push("kofta","kebab","grilled meat");
  if(/تبوله|تبولة|tabbouleh/.test(t)) m.push("tabbouleh","salad","parsley bulgur salad");
  if(/فتوش|fattoush/.test(t)) m.push("fattoush","salad");
  if(/حمص|hummus/.test(t)) m.push("hummus","mezze");
  if(/بابا غنوج|baba/.test(t)) m.push("baba ganoush","eggplant dip");
  if(/مشاوي|مشوي|grill/.test(t)) m.push("grilled","barbecue");
  if(/منسف|كبسة|mandi|kabsa|mansaf/.test(t)) m.push("rice","arab rice dish");
  if(/مسقعه|moussaka/.test(t)) m.push("moussaka");
  if(/شاورما|shawarma/.test(t)) m.push("shawarma");
  return uniq(m);
}

function cuisineHints(c){
  const m = String(c||"").toLowerCase();
  if(/عراقي|iraqi/.test(m)) return ["iraqi","middle eastern","arab","grill"];
  if(/شامي|levant|syria|leban|فلسطين|اردن/.test(m)) return ["levant","arab","middle eastern","mezze","grill"];
  if(/مصري|egypt/.test(m)) return ["egyptian","arab","middle eastern","grill"];
  if(/خليج|saudi|kuwait|emirati|qatari|omani|bahraini/.test(m)) return ["gulf","arab","middle eastern"];
  if(/تركي|turk/.test(m)) return ["turkish","kebab","meze"];
  if(/ايراني|فارسي|persian|iran/.test(m)) return ["persian","kebab","saffron"];
  if(/متوسطي|medit/.test(m)) return ["mediterranean","olive oil","fresh"];
  return [];
}

// يحسب نقاط الصورة استنادًا إلى alt/url مع فلترة الممنوعات
function scoreCandidateText(text, { title, ingredients, cuisine }){
  const toks = tokenize(text);
  // اقصاء مباشر إن وجد محظور
  for(const b of BANNED_TOKENS){ if (toks.includes(b)) return -999; }

  let score = 0;
  // اسم الطبق
  const titleTokens = uniq(tokenize(title)).concat(dishSynonyms(title));
  for (const tk of titleTokens) if (toks.includes(tk)) score += 6;

  // المكونات
  const ingTokens = uniq(normalizeList(ingredients,6).flatMap(tokenize));
  for (const tk of ingTokens) if (toks.includes(tk)) score += 2;

  // تلميحات المطبخ
  for (const tk of cuisineHints(cuisine)) if (toks.includes(tk)) score += 2;

  // تلميحات طعام عامة
  for (const tk of FOOD_HINTS) if (toks.includes(tk)) score += 1;

  return score;
}

/* ================== (A) Wikimedia Commons ================== */
function commonsQueries({ title, cuisine, ingredients }){
  const base = [
    title,
    `${title} dish`,
    `${title} food`,
    `${title} ${cuisine} dish`,
    `${title} recipe`,
  ];
  const ing = (ingredients||[]).slice(0,3).join(" ");
  base.push(`${title} ${ing}`);
  return uniq(base.map(s=>s.trim()).filter(Boolean));
}

async function tryWikimedia({ title, cuisine, ingredients }){
  const queries = commonsQueries({ title, cuisine, ingredients });
  for (const q of queries){
    try{
      const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=12&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=900&format=json&origin=*`;
      const ctrl = new AbortController();
      const timeout = setTimeout(()=>ctrl.abort(), 9000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timeout);
      const data = await resp.json().catch(()=> ({}));
      if(!resp.ok || !data?.query?.pages) continue;

      const pages = Object.values(data.query.pages)
        .filter(p=> Array.isArray(p.imageinfo) && p.imageinfo.length);

      let best=null, bestScore=-1;
      for(const p of pages){
        const info = p.imageinfo[0];
        const mime = (info.mime||"").toLowerCase();
        if(!/^image\/(jpeg|jpg|png|webp)$/i.test(mime)) continue;
        const cand = info.thumburl || info.url; if(!cand) continue;

        const text = `${p.title||""} ${(info.extmetadata?.ImageDescription?.value||"")}`.replace(/<[^>]+>/g," ");
        const s = scoreCandidateText(text, { title, ingredients, cuisine });
        if(s>bestScore){ bestScore=s; best={ url:cand, mime: info.mime||"image/jpeg" }; }
      }
      if(best && bestScore>0){
        const { dataUrl, mime } = await fetchAsDataURL(best.url, 15000);
        return { dataUrl, mime, mode:"inline" };
      }
    }catch(_){}
  }
  return null;
}

/* ================== (B) Pexels مع تصفية صارمة ================== */
async function tryPexels({ title, ingredients, cuisine }){
  if(!PEXELS_KEY) return null;

  // استعلام مركّب يؤكد أنه عن طبق
  const enrichedTitle = [title, ...dishSynonyms(title), "food dish", "on plate"].filter(Boolean).join(" ");
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(enrichedTitle)}&per_page=24&orientation=landscape`;

  const ctrl = new AbortController();
  const timeout = setTimeout(()=>ctrl.abort(), 9000);
  const resp = await fetch(url, { headers: { Authorization: PEXELS_KEY }, signal: ctrl.signal });
  clearTimeout(timeout);

  const data = await resp.json().catch(()=> ({}));
  if(!resp.ok || !Array.isArray(data?.photos) || !data.photos.length) return null;

  let best=null, bestScore=-1;
  for(const ph of data.photos){
    const text = `${ph?.alt||""} ${ph?.url||""}`.toLowerCase();
    const s = scoreCandidateText(text, { title, ingredients, cuisine });
    if(s>bestScore){ bestScore=s; best = ph?.src?.large2x || ph?.src?.large || ph?.src?.medium || ph?.src?.original || null; }
  }
  // ارفض النتائج السالبة (تحتوي محظورات)
  if(bestScore<=0 || !best) return null;

  try{
    const { dataUrl, mime } = await fetchAsDataURL(best, 15000);
    return { dataUrl, mime, mode:"inline" };
  }catch(_){ return null; }
}

/* ================== (C) Google (إن وُجد نموذج صور) ================== */
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
  const data = await resp.json().catch(()=> ({}));
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
- زاوية 30–45°، إضاءة طبيعية، تقديم أنيق على طبق، خلفية مطبخ محايدة.
- بدون أي نصوص/شعارات/أشخاص/أيدي، وبدون ديكور لا علاقة له بالطعام.
أخرج صورة واحدة مناسبة للويب.
`.trim();

  const en = `
You are a professional food photographer. Generate one photorealistic final dish image:
Title: ${title || "N/A"}
Cuisine: ${cuisine || "Mixed"}
Key ingredients: ${(ingredients||[]).join(", ") || "—"}
Preparation summary: ${(steps||[]).join(" then ") || "—"}
- 30–45° angle, soft natural light, elegant plating on a plate, neutral kitchen backdrop.
- No text/logos/people/hands, no unrelated props.
Return exactly one web-suitable image.
`.trim();

  return (lang === "en") ? en : ar;
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
    const body = { contents:[{ role:"user", parts:[{ text: prompt }] }], generationConfig:{ temperature:0, topP:1, maxOutputTokens:64 }, safetySettings:[] };

    const ctrl = new AbortController();
    const timeout = setTimeout(()=>ctrl.abort(), 12000);
    const resp = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timeout);

    const data = await resp.json().catch(()=> ({}));
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
      return { dataUrl, mime: m2 || mime, mode:"inline" };
    }
    if (!b64) return null;

    return { dataUrl:`data:${mime};base64,${b64}`, mime, mode:"inline" };
  }catch{ return null; }
}

/* ================== (D) Replicate (negative قوي + seed) ================== */
const REPLICATE_MODEL_CANDIDATES = [
  { owner:"black-forest-labs", name:"flux-schnell" }, // أسرع
  { owner:"stability-ai",      name:"sdxl" }          // أدق
];

function negativePrompt(){
  return "text, watermark, logo, people, person, hands, fingers, portrait, selfie, cartoon, unrealistic, extra objects, wrong ingredients, clutter, low quality, lowres, blurry, artifacts";
}

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
    const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, { headers: { Authorization: `Bearer ${REPLICATE_KEY}` } });
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

async function tryReplicateEnhanced(prompt, seed){
  if(!REPLICATE_KEY) return null;
  let lastErr = null;
  for(const m of REPLICATE_MODEL_CANDIDATES){
    try{
      const version = await replicateLatestVersion(m.owner, m.name);
      const input = (m.name === "sdxl")
        ? { prompt, negative_prompt: negativePrompt(), width: 800, height: 600, scheduler:"K_EULER", num_inference_steps: 28, guidance_scale: 7.0, seed }
        : { prompt, negative_prompt: negativePrompt(), width: 800, height: 600, num_inference_steps: 8, seed };
      const url = await replicatePredict(version, input);
      const { dataUrl, mime } = await fetchAsDataURL(url, 22000);
      return { dataUrl, mime, mode:"inline" };
    }catch(e){ lastErr = e && e.message || String(e); }
  }
  return null;
}

/* ================== Placeholder ================== */
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
  const encoded = encodeURIComponent(svg).replace(/'/g,"%27").replace(/"/g,"%22");
  return `data:image/svg+xml;utf8,${encoded}`;
}

/* ================== Handler ================== */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };

  if (event.httpMethod === "GET") {
    return ok({
      info: "generateRecipeImage (strict filtering) is alive. Use POST."
    });
  }

  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return ok({ image:{ mime:"image/svg+xml", mode:"inline", data_url: placeholderDataURL() } }); }

  const title = String(payload?.title || "").trim();
  const ingredients = normalizeList(payload?.ingredients, 25);
  const steps = normalizeList(payload?.steps, 12);
  const cuisine = String(payload?.cuisine || "").trim();
  const lang = (payload?.lang === "en") ? "en" : "ar";

  // 1) Wikimedia (أدق)
  try{
    const wm = await tryWikimedia({ title, cuisine, ingredients });
    if(wm && wm.dataUrl) return ok({ image:{ mime: wm.mime || "image/jpeg", mode:"inline", data_url: wm.dataUrl } });
  }catch(_){}

  // 2) Pexels (مع تصفية شديدة)
  try{
    const px = await tryPexels({ title, ingredients, cuisine });
    if(px && px.dataUrl) return ok({ image:{ mime: px.mime || "image/jpeg", mode:"inline", data_url: px.dataUrl } });
  }catch(_){}

  // 3) Google (إن توفر نموذج صور)
  try{
    const g = await tryGoogleImage(buildTextPrompt({ title, ingredients, steps, cuisine, lang }));
    if(g && g.dataUrl) return ok({ image:{ mime: g.mime || "image/png", mode:"inline", data_url: g.dataUrl } });
  }catch(_){}

  // 4) Replicate (negative + seed)
  try{
    const seed = stableSeedFrom(`${title}|${ingredients.join(",")}|${cuisine}`);
    const rp = await tryReplicateEnhanced(buildTextPrompt({ title, ingredients, steps, cuisine, lang }), seed);
    if(rp && rp.dataUrl) return ok({ image:{ mime: rp.mime || "image/png", mode:"inline", data_url: rp.dataUrl } });
  }catch(_){}

  // 5) Placeholder
  return ok({ image:{ mime:"image/svg+xml", mode:"inline", data_url: placeholderDataURL() } });
};
