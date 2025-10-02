// netlify/functions/generateRecipeImage.js
// الهدف: إرجاع صورة طبق بجانب الاسم دائمًا، مع تجربة جميع الاحتمالات الممكنة بالترتيب الأسرع:
// 1) Pexels (أسرع: صور جاهزة مرخّصة) — يتطلب PEXELS_API_KEY
// 2) Google Generative Language (إن كان الحساب يدعم توليد الصور) — يتطلب GEMINI_API_KEY
// 3) Replicate (توليد صور بالنماذج FLUX/SDXL) — يتطلب REPLICATE_API_TOKEN
// 4) Placeholder SVG كملاذ أخير
//
// ملاحظات:
// - واجهة الاستجابة ثابتة ومبسطة: { ok: true, image: { data_url, mime, mode } }
// - لا نُرجع أي إشارات للمزوّد أو تفاصيل داخل الاستجابة (بناءً على رغبتك "بدون إشارة").
// - يدعم GET للفحص اليدوي (لا يولّد صورة).

/* ======================
   CORS + Helpers
====================== */
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-auth-token, x-session-nonce",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
const ok  = (obj) => ({ statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, ...obj }) });
const bad = (code, error, extra = {}) => ({ statusCode: code, headers: HEADERS, body: JSON.stringify({ ok: false, error, ...extra }) });

/* ======================
   Environment
====================== */
const PEXELS_KEY    = process.env.PEXELS_API_KEY || "";
const GEMINI_KEY    = process.env.GEMINI_API_KEY || "";         // Google AI Studio / Generative Language API
const REPLICATE_KEY = process.env.REPLICATE_API_TOKEN || "";

/* ======================
   Generic helpers
====================== */
function normalizeList(a, max=25){
  return (Array.isArray(a)?a:[])
    .map(s=>String(s||"").trim()).filter(Boolean).slice(0,max);
}

function buildPrompt({ title = "", ingredients = [], steps = [], cuisine = "", lang = "ar" }) {
  const titleLine = title ? `اسم الطبق: ${title}` : "اسم الطبق غير محدد";
  const ingLine   = ingredients.length ? `المكوّنات: ${ingredients.join(", ")}` : "المكوّنات: —";
  const stepsLine = steps.length ? `ملخص التحضير: ${steps.join(" ثم ")}` : "طريقة التحضير: —";
  const cuiLine   = cuisine ? `المطبخ: ${cuisine}` : "المطبخ: متنوع";

  const ar = `
أنت مصوّر أطعمة محترف. أنشئ صورة طعام فوتوغرافية عالية الجودة تمثل الشكل النهائي للطبق التالي:
${titleLine}
${cuiLine}
${ingLine}
${stepsLine}

[تعليمات النمط]
- زاوية 30–45°، إضاءة طبيعية ناعمة.
- تقديم أنيق على طبق مناسب، خلفية مطبخية محايدة.
- دون نصوص/شعارات/علامات مائية أو أشخاص/أيدي.
- ألوان واقعية وتفاصيل فاتحة للشهية تُبرز المكوّنات المذكورة.

أخرج صورة واحدة نهائية مناسبة للويب.
`.trim();

  const en = `
You are a professional food photographer. Generate one photorealistic final dish image for:
Title: ${title || "N/A"}
Cuisine: ${cuisine || "Mixed"}
Key ingredients: ${(ingredients||[]).join(", ") || "—"}
Preparation summary: ${(steps||[]).join(" then ") || "—"}

[Style]
- 30–45° camera angle, soft natural light.
- Elegant plating, neutral kitchen backdrop.
- No text/logos/watermarks; no people/hands.
- Realistic, appetizing colors emphasizing the listed ingredients.

Return exactly one web-suitable image.
`.trim();

  return (lang === "en") ? en : ar;
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

/* ======================
   1) PEXELS (الأسرع)
====================== */
async function tryPexels({ title, ingredients, cuisine }){
  if(!PEXELS_KEY) return null;

  // استعلام ذكي: اسم الطبق + أهم مكوّنات + المطبخ
  const topIngs = normalizeList(ingredients, 3).join(" ");
  const query = [title, cuisine, topIngs].filter(Boolean).join(" ").trim() || "dish food plate";
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;

  const ctrl = new AbortController();
  const timeout = setTimeout(()=>ctrl.abort(), 8000); // سريع
  const resp = await fetch(url, { headers: { Authorization: PEXELS_KEY }, signal: ctrl.signal });
  clearTimeout(timeout);

  const text = await resp.text();
  let data = null; try { data = JSON.parse(text); } catch {}

  if(!resp.ok) return null;

  const photo = (data?.photos && data.photos[0]) || null;
  if(!photo?.src) return null;

  const candidate = photo.src.large2x || photo.src.large || photo.src.medium || photo.src.original;
  if(!candidate) return null;

  try{
    const { dataUrl, mime } = await fetchAsDataURL(candidate, 15000);
    return { dataUrl, mime, mode: "inline" };
  }catch{ return null; }
}

/* ======================
   2) Google Generative Language (إن توفّر — أسرع من Replicate غالبًا)
====================== */
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
  // أفضلية لأي اسم يحتوي "imagen" أو "image" ويدعم generateContent
  const hasGC = (m) => Array.isArray(m?.supportedGenerationMethods)
    ? m.supportedGenerationMethods.includes("generateContent")
    : true; // بعض البيئات لا تُرجع القائمة

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
      if(!cachedImageModel) return null; // لا يوجد نموذج صور
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
      // قد يعود URI فقط — نحوله لبيز64
      const { dataUrl, mime: m2 } = await fetchAsDataURL(found.fileData.fileUri, 20000);
      return { dataUrl, mime: m2 || mime, mode: "inline" };
    }
    if (!b64) return null;

    return { dataUrl: `data:${mime};base64,${b64}`, mime, mode: "inline" };
  }catch{
    return null;
  }
}

/* ======================
   3) Replicate (أبطأ بسبب الـ polling)
====================== */
const REPLICATE_MODEL_CANDIDATES = [
  { owner:"black-forest-labs", name:"flux-schnell" }, // سريع
  { owner:"stability-ai",      name:"sdxl" }          // دقيق
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
  const id = created?.id;
  if(!id) throw new Error("replicate_no_id");

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
      return first; // URL للصورة
    }
    if(st === "failed" || st === "canceled"){
      throw new Error(`replicate_${st}`);
    }
    if(Date.now() - t0 > overallTimeoutMs){
      throw new Error("replicate_timeout");
    }
  }
}

async function tryReplicate(prompt, seedHint){
  if(!REPLICATE_KEY) return null;
  let lastErr = null;
  for(const m of REPLICATE_MODEL_CANDIDATES){
    try{
      const version = await replicateLatestVersion(m.owner, m.name);
      const input = m.name === "sdxl"
        ? { prompt, width: 768, height: 512, scheduler:"K_EULER", num_inference_steps: 28, guidance_scale: 7.0, seed: seedHint || 1234 }
        : { prompt, width: 768, height: 512, num_inference_steps: 8, seed: seedHint || 1234 };

      const url = await replicatePredict(version, input);
      const { dataUrl, mime } = await fetchAsDataURL(url, 20000);
      return { dataUrl, mime, mode: "inline" };
    }catch(e){
      lastErr = e && e.message || String(e);
      // جرّب النموذج التالي
    }
  }
  return null;
}

/* ======================
   4) Placeholder (ملاذ أخير)
====================== */
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

/* ======================
   HTTP Handler
====================== */
exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };

  // فحص يدوي سريع
  if (event.httpMethod === "GET") {
    return ok({
      info: "generateRecipeImage is alive. Use POST to generate an image.",
      providers_available: {
        pexels: !!PEXELS_KEY,
        google_models: !!GEMINI_KEY,
        replicate: !!REPLICATE_KEY
      },
      sample_payload: {
        title: "سلطة تبولة",
        ingredients: ["برغل","بقدونس","طماطم","زيت زيتون"],
        steps: ["تقطيع","خلط","تتبيل"],
        cuisine: "شرق أوسطي",
        lang: "ar"
      }
    });
  }

  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  // اقرأ الحمولة
  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return ok({ image: { mime: "image/svg+xml", mode: "inline", data_url: placeholderDataURL() } }); }

  const title = String(payload?.title || "").trim();
  const ingredients = normalizeList(payload?.ingredients, 25);
  const steps = normalizeList(payload?.steps, 12);
  const cuisine = String(payload?.cuisine || "").trim();
  const lang = (payload?.lang === "en") ? "en" : "ar";

  const prompt = buildPrompt({ title, ingredients, steps, cuisine, lang });

  // ترتيب المحاولات: Pexels → Google → Replicate → Placeholder

  // 1) Pexels
  try{
    const p = await tryPexels({ title, ingredients, cuisine });
    if(p && p.dataUrl){
      return ok({ image: { mime: p.mime || "image/jpeg", mode: p.mode || "inline", data_url: p.dataUrl } });
    }
  }catch(_){ /* ننتقل للمحاولة التالية */ }

  // 2) Google Generative Language (إن توفّر نموذج صور)
  try{
    const g = await tryGoogleImage(prompt);
    if(g && g.dataUrl){
      return ok({ image: { mime: g.mime || "image/png", mode: g.mode || "inline", data_url: g.dataUrl } });
    }
  }catch(_){ /* ننتقل للمحاولة التالية */ }

  // 3) Replicate
  try{
    const seedHint = (title + "|" + ingredients.join(",")).length % 100000; // شبه ثابت لنفس الطبق
    const r = await tryReplicate(prompt, seedHint);
    if(r && r.dataUrl){
      return ok({ image: { mime: r.mime || "image/png", mode: r.mode || "inline", data_url: r.dataUrl } });
    }
  }catch(_){ /* ننتقل للملاذ الأخير */ }

  // 4) Placeholder كملاذ أخير
  return ok({ image: { mime: "image/svg+xml", mode: "inline", data_url: placeholderDataURL() } });
};
