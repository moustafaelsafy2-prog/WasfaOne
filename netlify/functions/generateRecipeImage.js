// netlify/functions/generateRecipeImage.js
// حل صارم يضمن عدم الخلط:
// 1) توليد بالذكاء الاصطناعي مع Validator صارم (Replicate → Google)
// 2) إن فشل التحقق أو انخفضت الثقة -> نولّد صورة SVG دقيقة "مضمونة" مبنية على المكوّنات (StrictSVG)
// 3) إن نجح التحقق نُلجئ لمصادر مجانية: Wikimedia → Wikipedia PageImages → Wikidata P18 → Openverse
// 4) ثم Pexels (إن وُجد مفتاح) → Placeholder
//
// ملاحظة: StrictSVG يرسم طبقًا متجهيًا جميلًا ويُظهر البروتين والنشويات والخضار المتاحة فقط، فلا يمكن أن يظهر مكوّن غير موجود.
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

/* ================= أدوات عامة ================= */
function normalizeList(a, max=25){
  return (Array.isArray(a)?a:[])
    .map(s=>String(s||"").trim())
    .filter(Boolean)
    .slice(0,max);
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
async function fetchAsDataURL(imageUrl, timeoutMs = 25000){
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

/* ================= كشف صنف/بروتين/مطبخ ================= */
const TOK = {
  fish: ["fish","seafood","salmon","tuna","shrimp","prawn","squid","octopus","sardine","anchovy","mackerel","سمك","سَمَك","سردين","تونة","سلمون","روبيان","جمبري","كاليماري","حبار","أخطبوط","مأكولات","بحرية"],
  chicken: ["chicken","poultry","breast","thigh","drumstick","دجاج","فراخ","صدور","افخاذ"],
  meat: ["meat","beef","lamb","mutton","goat","veal","لحمة","لحم","بقر","غنم","ضأن","ماعز","عجل"],
  veg: ["vegetarian","vegan","نباتي","صيامي"],
  rice: ["rice","أرز","رز","biryani","mandi","kabsa","mansaf","pilaf","pulao"],
  soup: ["soup","شوربة","حساء"],
  salad: ["salad","سلطة"],
  pasta: ["pasta","spaghetti","penne","fettuccine","macaroni","مكرونة","معكرونة"],
  sandwich: ["sandwich","burger","wrap","shawarma","ساندوتش","شطيرة","برجر","شاورما"],
  stew: ["stew","curry","tagine","مرق","يخنة","طاجن"],
  grill: ["grill","grilled","barbecue","مشوي","مشاوي"],
  baked: ["baked","roasted","oven","مخبوز","في الفرن","محمر"],
  dessert: ["dessert","cake","pastry","sweet","حلويات","كيك","بسبوسة","بقلاوة","kunafa","كنافة","حلو"]
};

function detectProtein({ title, ingredients=[] }){
  const text = `${title} ${ingredients.join(" ")}`.toLowerCase();
  const has=(arr)=>arr.some(w=>text.includes(w));
  if(has(TOK.fish)) return "fish";
  if(has(TOK.chicken)) return "chicken";
  if(has(TOK.meat)) return "meat";
  if(has(TOK.veg)) return "veg";
  if (/دجاج|chicken/i.test(text)) return "chicken";
  if (/سمك|fish|seafood/i.test(text)) return "fish";
  if (/لحم|meat|beef|lamb|mutton/i.test(text)) return "meat";
  return "unknown";
}
function detectDishType({ title, ingredients=[], steps=[] }){
  const text = `${title} ${ingredients.join(" ")} ${steps.join(" ")}`.toLowerCase();
  const has=(arr)=>arr.some(w=>text.includes(w));
  if(has(TOK.rice)) return "rice";
  if(has(TOK.soup)) return "soup";
  if(has(TOK.salad)) return "salad";
  if(has(TOK.pasta)) return "pasta";
  if(has(TOK.sandwich)) return "sandwich";
  if(has(TOK.stew)) return "stew";
  if(has(TOK.grill)) return "grill";
  if(has(TOK.baked)) return "baked";
  if(has(TOK.dessert)) return "dessert";
  return "generic";
}
function cuisineHints(c){
  const m = String(c||"").toLowerCase();
  if(/arab|middle eastern|شرق|شامي|خليج|مغربي|تونسي|جزائري|مصري|يمني|سعودي|لبناني|سوري|فلسطيني|أردني/.test(m)) return ["arab","middle eastern","levant","gulf","mediterranean"];
  if(/تركي|turk/.test(m)) return ["turkish","anatolian","meze"];
  if(/ايراني|فارسي|persian|iran/.test(m)) return ["persian","iranian"];
  if(/هندي|india|indian/.test(m)) return ["indian","south asian"];
  if(/باكستان|pakistan/.test(m)) return ["pakistani","south asian"];
  if(/صيني|china|chinese/.test(m)) return ["chinese"];
  if(/يابان|japan/.test(m)) return ["japanese"];
  if(/كوري|korea/.test(m)) return ["korean"];
  if(/تايلند|thai/.test(m)) return ["thai"];
  if(/فيتنام|vietnam/.test(m)) return ["vietnamese"];
  if(/ايطالي|italy/.test(m)) return ["italian","mediterranean"];
  if(/اسباني|spain/.test(m)) return ["spanish","mediterranean"];
  if(/فرنسي|france/.test(m)) return ["french","european"];
  if(/يوناني|greece|greek/.test(m)) return ["greek","mediterranean"];
  if(/امريكي|american|usa/.test(m)) return ["american"];
  if(/مكسيك|mexic/.test(m)) return ["mexican","latin"];
  if(/افريقي|ethiop/.test(m)) return ["african","ethiopian","north african"];
  return [];
}

/* ============== تبسيط أسماء المكونات (AR→EN) ============== */
const INGLEX = {
  "دجاج":"chicken","فراخ":"chicken","لحمة":"meat","لحم":"meat","غنم":"lamb","ضأن":"lamb","بقر":"beef",
  "سمك":"fish","تونة":"tuna","سلمون":"salmon","روبيان":"shrimp","جمبري":"shrimp",
  "أرز":"rice","رز":"rice","برغل":"bulgur","كسكسي":"couscous","مكرونة":"pasta","معكرونة":"pasta","خبز":"bread",
  "طماطم":"tomato","بندورة":"tomato","خس":"lettuce","جرجير":"arugula","خيار":"cucumber","فلفل":"pepper","بصل":"onion","ثوم":"garlic",
  "بطاطس":"potato","بطاطا":"potato","ليمون":"lemon","لايم":"lime","زيتون":"olives","فطر":"mushroom","فلفل حار":"chili",
  "بقدونس":"parsley","كزبرة":"cilantro","ريحان":"basil","زعتر":"thyme","أوريجانو":"oregano","روزماري":"rosemary","شبت":"dill","نعناع":"mint",
  "جبن":"cheese","لبن":"yogurt","زبادي":"yogurt","قشدة":"cream","بيض":"egg",
  "زيت زيتون":"olive oil","زيت":"oil","ملح":"salt","فلفل أسود":"black pepper","كمون":"cumin","كاري":"curry","كركم":"turmeric",
};
const COMMON_VISUAL_ING = [
  "tomato","lettuce","cucumber","lemon","lime","parsley","cilantro","basil","oregano","rosemary","dill","mint",
  "olives","mushroom","cheese","egg","bread","pasta","rice","shrimp","salmon","tuna","fish","chicken","beef","lamb"
];
function ingredientsAllowedTokens(ingredients){
  const base = [];
  for(const line of (ingredients||[])){
    const toks = tokenize(line);
    for(const t of toks){
      const arMatch = Object.keys(INGLEX).find(k => t === tokenize(k)[0]);
      if(arMatch){ base.push(INGLEX[arMatch]); }
      base.push(t);
    }
  }
  const norm = base.map(t=>t.replace(/s$/,""));
  return new Set(norm);
}

/* =============== قواعد تقييم عامّة + حارس المكوّنات =============== */
const BANNED_NONFOOD = [
  "person","people","woman","man","girl","boy","portrait","selfie","hand","hands","fingers",
  "model","fitness","yoga","fashion","travel","tourist","wedding","family","couple",
  "sports","beach","mountain","city","forest","رجل","امرأة","نساء","بنات","فتاة","شخص","أشخاص","أيدي","عائلة","زفاف","سياحة","شاطئ","غابة","مدينة"
];
const FOOD_HINTS = [
  "food","dish","plate","plated","meal","cooked","baked","roasted","grilled","stew","soup",
  "salad","kebab","kabob","kofta","shawarma","rice","meat","chicken","fish","lamb","vegetable","herbs",
  "sauce","garnish","olive","tagine","mezze","cuisine","kitchen","restaurant","tray","platter","bowl"
];
function typeHints(dishType){
  const map = {
    rice: ["rice","pilaf","pulao","biryani","mandi","kabsa","long-grain","saffron","spiced","tray","platter"],
    soup: ["soup","broth","bowl","spoon","ladle","creamy","clear"],
    salad:["salad","greens","herbs","chopped","bowl","fresh"],
    pasta:["pasta","spaghetti","penne","noodles","sauce"],
    sandwich:["sandwich","wrap","burger","bread","pita","bun"],
    stew:["stew","curry","thick","sauce","braised","tagine"],
    grill:["grill","char","skewers","kebab","kabob","grilled"],
    baked:["baked","roasted","oven","tray","sheet"],
    dessert:["dessert","sweet","cake","pastry","syrup","cream"],
    generic:["dish","plate","meal"]
  };
  return map[dishType] || map.generic;
}
function scoreCandidateText(text, meta){
  const toks = tokenize(text);
  for(const b of BANNED_NONFOOD){ if (toks.includes(b)) return -999; }

  const { title, ingredients, cuisine, dishType, protein, allowedSet } = meta;

  for(const cand of COMMON_VISUAL_ING){
    const t = cand.replace(/s$/,"");
    if (toks.includes(t) && !allowedSet.has(t)) return -999;
  }

  if (protein === "veg"){
    for(const t of [...TOK.chicken, ...TOK.meat, ...TOK.fish]) if (toks.includes(t)) return -999;
  } else if (protein === "chicken"){
    for(const t of TOK.fish) if (toks.includes(t)) return -999;
  } else if (protein === "fish"){
    for(const t of [...TOK.chicken, ...TOK.meat]) if (toks.includes(t)) return -999;
  }

  let score = 0;
  for(const tk of uniq(tokenize(title))) if(toks.includes(tk)) score += 6;
  for(const tk of uniq(normalizeList(ingredients,6).flatMap(tokenize))) if(toks.includes(tk)) score += 3;
  for(const tk of cuisineHints(cuisine)) if(toks.includes(tk)) score += 2;
  for(const tk of typeHints(dishType)) if(toks.includes(tk)) score += 2;
  for(const tk of FOOD_HINTS) if(toks.includes(tk)) score += 1;

  if (protein==="chicken" && (toks.includes("chicken")||toks.includes("دجاج"))) score += 3;
  if (protein==="meat"    && (toks.includes("meat")||toks.includes("beef")||toks.includes("lamb")||toks.includes("لحم"))) score += 3;
  if (protein==="fish"    && (toks.includes("fish")||toks.includes("seafood")||toks.includes("سمك"))) score += 3;
  if (protein==="veg"     && (toks.includes("vegetarian")||toks.includes("vegan")||toks.includes("نباتي"))) score += 3;

  return score;
}

/* =============== StrictSVG — توليد صورة مضمونة بلا خلط =============== */
function iconPath(name){
  // أيقونات مت矢ّرة مبسطة (بدون خارجيات)
  const p = {
    plate:  '<circle cx="160" cy="120" r="100" fill="#fff" stroke="#e5e7eb" stroke-width="8"/>'
          + '<circle cx="160" cy="120" r="70"  fill="#f8fafc" stroke="#f1f5f9" stroke-width="4"/>',
    rice:   '<ellipse cx="160" cy="140" rx="60" ry="30" fill="#fafaf0" stroke="#e2e8f0" stroke-width="2"/>'
          + '<g opacity="0.8"><rect x="110" y="130" width="8" height="2" rx="1" fill="#e5e7eb"/><rect x="122" y="138" width="10" height="2" rx="1" fill="#e5e7eb"/><rect x="176" y="143" width="9" height="2" rx="1" fill="#e5e7eb"/></g>',
    chicken:'<path d="M115 120c20-35 70-35 90 0 8 16-4 36-26 44-26 9-50-4-64-21-4-5-3-13 0-23z" fill="#f59e0b" stroke="#b45309" stroke-width="3"/>'
          + '<circle cx="210" cy="105" r="10" fill="#fde68a" stroke="#b45309" stroke-width="3"/>',
    meat:   '<path d="M115 120c22-30 76-28 92 4 10 20-10 42-36 44-32 3-58-18-56-48z" fill="#ef4444" stroke="#991b1b" stroke-width="3"/>'
          + '<circle cx="170" cy="135" r="12" fill="#fecaca" stroke="#991b1b" stroke-width="3"/>',
    fish:   '<path d="M100 130c40-30 85-30 120 0-10 14-10 26 0 40-35-30-80-30-120 0 10-14 10-26 0-40z" fill="#60a5fa" stroke="#1e40af" stroke-width="3"/>'
          + '<circle cx="210" cy="140" r="5" fill="#0f172a"/>',
    veg:    '<path d="M120 155c-10-30 25-55 55-45 20 7 30 28 18 46-12 18-50 20-73-1z" fill="#4ade80" stroke="#15803d" stroke-width="3"/>',
    tomato: '<circle cx="118" cy="110" r="16" fill="#ef4444" stroke="#991b1b" stroke-width="3"/><path d="M118 98l6 8-6 2-6-2 6-8z" fill="#16a34a"/>',
    onion:  '<ellipse cx="140" cy="90" rx="14" ry="18" fill="#e9d5ff" stroke="#7c3aed" stroke-width="3"/>',
    garlic: '<path d="M160 95c10-15 20-15 30 0 5 10 0 20-15 22-18 2-23-10-15-22z" fill="#f8fafc" stroke="#94a3b8" stroke-width="3"/>',
    lemon:  '<ellipse cx="200" cy="95" rx="18" ry="12" fill="#fde047" stroke="#a16207" stroke-width="3"/>',
    pepper: '<path d="M210 115c8-12 20-10 24 2 4 12-6 20-16 20-8 0-14-6-8-22z" fill="#22c55e" stroke="#15803d" stroke-width="3"/>',
    potato: '<ellipse cx="205" cy="160" rx="18" ry="12" fill="#f59e0b" stroke="#b45309" stroke-width="3"/>',
    carrot: '<path d="M230 150l20 8-8 20-20-8 8-20z" fill="#fb923c" stroke="#c2410c" stroke-width="3"/><path d="M248 158l6-10" stroke="#16a34a" stroke-width="3"/>',
    parsley:'<path d="M96 150c12-8 20-8 28 0-9 10-19 12-28 0z" fill="#22c55e" stroke="#16a34a" stroke-width="3"/>',
    cilantro:'<path d="M96 168c12-8 20-8 28 0-9 10-19 12-28 0z" fill="#16a34a" stroke="#15803d" stroke-width="3"/>',
    chili:  '<path d="M108 178c16-8 30-6 36 6-12 4-22 6-36-6z" fill="#ef4444" stroke="#991b1b" stroke-width="3"/>',
    cucumber:'<rect x="98" y="128" rx="6" ry="6" width="28" height="12" fill="#86efac" stroke="#15803d" stroke-width="3"/>',
    olive:  '<ellipse cx="190" cy="170" rx="8" ry="6" fill="#475569" stroke="#0f172a" stroke-width="3"/>',
    pasta:  '<path d="M150 150c20-8 40-8 60 0" stroke="#facc15" stroke-width="6" fill="none"/>',
    bread:  '<path d="M145 170c20-12 40-12 60 0v10h-60v-10z" fill="#f59e0b" stroke="#b45309" stroke-width="3"/>'
  };
  return p[name] || '';
}
function buildStrictSVG(meta){
  const { title, ingredients, protein, dishType } = meta;
  const tkns = ingredients.map(s=>tokenize(s)).flat();
  const has = (w) => tkns.includes(w);
  const hasAny = (arr) => arr.some(has);

  // عناصر أساسية حسب البروتين/النوع
  let proteinIcon = '';
  if (protein === 'chicken') proteinIcon = iconPath('chicken');
  else if (protein === 'meat') proteinIcon = iconPath('meat');
  else if (protein === 'fish') proteinIcon = iconPath('fish');
  else proteinIcon = iconPath('veg');

  let starchIcon = '';
  if (has('rice') || TOK.rice.some(r=>title.toLowerCase().includes(r))) starchIcon = iconPath('rice');
  else if (has('pasta')) starchIcon = iconPath('pasta');
  else if (has('bread')) starchIcon = iconPath('bread');

  // خضار/توابل مأخوذة فقط من القائمة
  const mapIngs = [
    {k:'tomato',  cond: has('tomato')},
    {k:'onion',   cond: has('onion')},
    {k:'garlic',  cond: has('garlic')},
    {k:'lemon',   cond: has('lemon')},
    {k:'pepper',  cond: has('pepper') || has('chili')},
    {k:'potato',  cond: has('potato')},
    {k:'carrot',  cond: has('carrot')},
    {k:'parsley', cond: has('parsley')},
    {k:'cilantro',cond: has('cilantro')},
    {k:'cucumber',cond: has('cucumber')},
    {k:'olive',   cond: has('olive') || has('olives')}
  ].filter(x=>x.cond).map(x=>x.k);

  // نوزّع الأيقونات حول الطبق
  const ring = (items)=>{
    const cx=160, cy=120, R=78;
    return items.map((k,i)=>{
      const ang = (i/items.length)*Math.PI*2;
      const x = cx + R*Math.cos(ang);
      const y = cy + R*Math.sin(ang);
      return `<g transform="translate(${x-12},${y-12})">${iconPath(k)}</g>`;
    }).join('');
  };

  const svg =
`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 320 200">
  <rect width="320" height="200" fill="#f8fafc"/>
  <g>
    ${iconPath('plate')}
    ${starchIcon}
    ${proteinIcon}
    ${ring(mapIngs)}
  </g>
  <g font-family="sans-serif" fill="#0f172a" font-weight="700" font-size="12">
    <text x="16" y="28">${(title||'طبقي')}</text>
    <text x="16" y="44" fill="#64748b">${dishType || ''} • ${protein}</text>
  </g>
</svg>`;
  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return { dataUrl, mime: "image/svg+xml", mode: "inline" };
}

/* =============== Wikimedia Commons (مجاني) =============== */
function commonsQueries({ title, cuisine, ingredients, dishType }){
  const base = [
    title,
    `${title} ${dishType} dish`,
    `${title} food`,
    `${title} ${cuisine} dish`,
    `${title} recipe`
  ];
  const ing = (ingredients||[]).slice(0,3).join(" ");
  base.push(`${title} ${ing}`);
  return uniq(base.map(s=>s.trim()).filter(Boolean));
}
async function tryWikimedia(meta){
  const { title, cuisine, ingredients, dishType } = meta;
  const queries = commonsQueries({ title, cuisine, ingredients, dishType });
  for (const q of queries){
    try{
      const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=16&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=900&format=json&origin=*`;
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
        const s = scoreCandidateText(text, meta);
        if(s>bestScore){ bestScore=s; best={ url:cand, mime: info.mime||"image/jpeg" }; }
      }
      if(best && bestScore>0){
        const { dataUrl, mime } = await fetchAsDataURL(best.url, 18000);
        return { dataUrl, mime, mode:"inline" };
      }
    }catch(_){}
  }
  return null;
}

/* =============== Wikipedia PageImages (مجاني) =============== */
async function tryWikipediaPageImage(meta){
  const langs = ["ar","en"];
  const titleCandidates = uniq([meta.title].concat(
    meta.title.split(/[()،,-]/).map(s=>s.trim()).filter(Boolean)
  ));
  for(const lang of langs){
    for(const t of titleCandidates){
      try{
        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=pageimages|pageterms&format=json&piprop=thumbnail|name&pithumbsize=900&titles=${encodeURIComponent(t)}&origin=*`;
        const ctrl = new AbortController();
        const timeout = setTimeout(()=>ctrl.abort(), 8000);
        const resp = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timeout);
        const data = await resp.json().catch(()=> ({}));
        if(!resp.ok || !data?.query?.pages) continue;
        const pages = Object.values(data.query.pages);
        for(const p of pages){
          const thumb = p?.thumbnail?.source;
          if(!thumb) continue;
          const text = `${p?.title||""} ${Array.isArray(p?.terms?.description)?p.terms.description.join(" "):""}`;
          const s = scoreCandidateText(text, meta);
          if(s>0){
            const { dataUrl, mime } = await fetchAsDataURL(thumb, 15000);
            return { dataUrl, mime: mime || "image/jpeg", mode:"inline" };
          }
        }
      }catch(_){}
    }
  }
  return null;
}

/* =============== Wikidata SPARQL (P18) — مجاني =============== */
async function tryWikidataP18(meta){
  const makeQuery = (label, lang) => `
    SELECT ?img WHERE {
      ?item rdfs:label "${label}"@${lang}.
      ?item wdt:P18 ?img .
    } LIMIT 1
  `.trim();
  const attempts = [
    { l: meta.title, lang: "ar" },
    { l: meta.title, lang: "en" },
  ];
  for(const a of attempts){
    try{
      const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(makeQuery(a.l, a.lang))}`;
      const ctrl = new AbortController();
      const timeout = setTimeout(()=>ctrl.abort(), 8000);
      const resp = await fetch(url, { headers:{ "accept":"application/sparql-results+json" }, signal: ctrl.signal });
      clearTimeout(timeout);
      const data = await resp.json().catch(()=> ({}));
      const img = data?.results?.bindings?.[0]?.img?.value;
      if(!img) continue;
      const s = scoreCandidateText(`${a.l} wikidata image`, meta);
      if(s>0){
        const { dataUrl, mime } = await fetchAsDataURL(img, 20000);
        return { dataUrl, mime: mime || "image/jpeg", mode:"inline" };
      }
    }catch(_){}
  }
  return null;
}

/* =============== Openverse (WordPress) — مجاني =============== */
async function tryOpenverse(meta){
  try{
    const q = [meta.title, meta.dishType, meta.protein, ...cuisineHints(meta.cuisine), "food", "dish"]
      .filter(Boolean).join(" ");
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&format=json&license_type=all&page_size=24`;
    const ctrl = new AbortController();
    const timeout = setTimeout(()=>ctrl.abort(), 8000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timeout);
    const data = await resp.json().catch(()=> ({}));
    const results = Array.isArray(data?.results) ? data.results : [];
    if(!results.length) return null;

    let best=null, bestScore=-1;
    for(const r of results){
      const tags = (Array.isArray(r?.tags)?r.tags.map(t=>t?.name||""):"").join(" ");
      const text = `${r?.title||""} ${r?.description||""} ${tags}`;
      const s = scoreCandidateText(text, meta);
      if(s>bestScore){ bestScore=s; best = r?.url || r?.thumbnail || null; }
    }
    if(best && bestScore>0){
      const { dataUrl, mime } = await fetchAsDataURL(best, 20000);
      return { dataUrl, mime: mime || "image/jpeg", mode:"inline" };
    }
  }catch(_){}
  return null;
}

/* =============== Pexels (مفتاح اختياري) =============== */
async function tryPexels(meta){
  if(!PEXELS_KEY) return null;
  const { title, dishType, protein, cuisine } = meta;

  const proteinWord =
    protein==="veg" ? "vegetarian" :
    protein==="chicken" ? "chicken" :
    protein==="fish" ? "fish" :
    protein==="meat" ? "meat" : "";

  const typeWord = dishType==="generic" ? "dish" : dishType;

  const enriched = [title, proteinWord, typeWord, "cooked food", ...cuisineHints(cuisine)]
    .filter(Boolean).join(" ");

  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(enriched)}&per_page=24&orientation=landscape`;

  const ctrl = new AbortController();
  const timeout = setTimeout(()=>ctrl.abort(), 9000);
  const resp = await fetch(url, { headers: { Authorization: PEXELS_KEY }, signal: ctrl.signal });
  clearTimeout(timeout);

  const data = await resp.json().catch(()=> ({}));
  if(!resp.ok || !Array.isArray(data?.photos) || !data.photos.length) return null;

  let best=null, bestScore=-1;
  for(const ph of data.photos){
    const text = `${ph?.alt||""} ${ph?.url||""}`.toLowerCase();
    const s = scoreCandidateText(text, meta);
    if(s>bestScore){ bestScore=s; best = ph?.src?.large2x || ph?.src?.large || ph?.src?.medium || ph?.src?.original || null; }
  }
  if(bestScore<=0 || !best) return null;

  try{
    const { dataUrl, mime } = await fetchAsDataURL(best, 15000);
    return { dataUrl, mime, mode:"inline" };
  }catch(_){ return null; }
}

/* =============== Google Generative Language (إن توفر) =============== */
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
  const gc = (m)=>Array.isArray(m?.supportedGenerationMethods)?m.supportedGenerationMethods.includes("generateContent"):true;
  const imagen = models.find(m => /(^|\/)models\/.*imagen/i.test(m?.name||"") && gc(m));
  if (imagen?.name) return imagen.name.replace(/^models\//, "");
  const imageAny = models.find(m => /(^|\/)models\/.*image/i.test(m?.name||"") && gc(m));
  if (imageAny?.name) return imageAny.name.replace(/^models\//, "");
  return null;
}
function buildTextPrompt(meta){
  const { title, ingredients, steps, cuisine, dishType, protein, lang, allowedSet } = meta;

  const allowed = Array.from(allowedSet).join(", ") || "only the listed ingredients";
  const disallowed = COMMON_VISUAL_ING
    .map(t=>t.replace(/s$/,""))
    .filter(t=>!allowedSet.has(t));
  const disTxt = disallowed.length ? `Exclude visually: ${disallowed.join(", ")}.` : "Exclude any ingredient not listed.";

  const style = `
- 30–45° angle, soft natural light, elegant plating, neutral kitchen backdrop.
- No text/logos/watermarks. No people or hands. Realistic, appetizing colors.`.trim();

  const en = `
You are a professional food photographer.
Generate ONE photorealistic image for:
Title: ${title || "N/A"}
Cuisine hints: ${cuisineHints(cuisine).join(", ") || "global"}
Dish type: ${dishType}
Protein: ${protein}
Use only these ingredients visually: ${allowed}.
${disTxt}
Key ingredients: ${(ingredients||[]).join(", ") || "—"}
Preparation summary: ${(steps||[]).join(" then ") || "—"}
${dishType==="rice" ? "Ensure a prominent rice base only if rice is in the list." : ""}
${dishType==="soup" ? "Serve in a bowl with visible broth." : ""}
${dishType==="salad" ? "Fresh chopped ingredients, no heavy sauces." : ""}
${dishType==="pasta" ? "Recognizable pasta shapes coated with sauce." : ""}
${dishType==="sandwich" ? "Clearly a sandwich/wrap/burger." : ""}
${dishType==="stew" ? "Thick saucy consistency." : ""}
${dishType==="grill" ? "Grilled/charred cues." : ""}
${dishType==="dessert" ? "Dessert presentation." : ""}
${style}`.trim();

  const ar = `
أنت مصوّر أطعمة محترف.
أنشئ صورة واحدة فوتوغرافية واقعية لـ:
الاسم: ${title || "—"}
تلميحات المطبخ: ${cuisineHints(cuisine).join(", ") || "عالمي"}
نوع الطبق: ${dishType}
نوع البروتين: ${protein}
استخدم بصريًا فقط هذه المكوّنات: ${allowed}.
امنع ظهور أي مكوّن غير مذكور. ${disTxt}
المكوّنات الأساسية: ${(ingredients||[]).join(", ") || "—"}
ملخص التحضير: ${(steps||[]).join(" ثم ") || "—"}
${dishType==="rice" ? "أظهر الأرز فقط إن كان ضمن قائمة المكوّنات." : ""}
- زاوية 30–45°، إضاءة طبيعية ناعمة، خلفية مطبخ محايدة، تقديم أنيق.
- بدون نصوص/شعارات/أشخاص/أيدي، ألوان واقعية فاتحة للشهية.`.trim();

  return (lang==="en") ? en : ar;
}
async function tryGoogleImage(meta){
  if(!GEMINI_KEY) return null;
  try{
    if(!cachedImageModel){
      const models = await glListModels();
      cachedImageModel = pickImageModelFrom(models);
      if(!cachedImageModel) return null;
    }
    const url = `${GL_BASE}/models/${encodeURIComponent(cachedImageModel)}:generateContent`;
    const body = {
      contents:[{ role:"user", parts:[{ text: buildTextPrompt(meta) }] }],
      generationConfig:{ temperature:0, topP:1, maxOutputTokens:64 },
      safetySettings:[]
    };

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

    const mime = found.inlineData?.mimeType || found.inline_data?.mime_type || found.fileData?.mimeType || "image/png";
    const b64  = found.inlineData?.data     || found.inline_data?.data     || null;
    if(!b64 && found.fileData?.fileUri){
      const { dataUrl, mime: m2 } = await fetchAsDataURL(found.fileData.fileUri, 20000);
      return { dataUrl, mime: m2 || mime, mode:"inline" };
    }
    if(!b64) return null;
    return { dataUrl:`data:${mime};base64,${b64}`, mime, mode:"inline" };
  }catch{ return null; }
}

/* =============== Replicate (توليد صارم + Validator CLIP) =============== */
const REPLICATE_MODEL_CANDIDATES = [
  { owner:"black-forest-labs", name:"flux-schnell" }, // أسرع
  { owner:"stability-ai",      name:"sdxl" }          // أدق
];
const REPLICATE_VALIDATOR = { owner:"pharmapsychotic", name:"clip-interrogator" };

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
async function replicatePredict(versionId, input, overallTimeoutMs=60000){
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
    await new Promise(r=>setTimeout(r, 1100));
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
function buildReplicatePrompt(meta){
  const { title, ingredients, steps, cuisine, dishType, protein, allowedSet } = meta;
  const allowed = Array.from(allowedSet).join(", ") || "only the listed ingredients";
  const base = `
Professional food photography of a ${cuisineHints(cuisine).join("/")} ${dishType} ${protein!=="unknown"?protein:""} dish.
Elegant plating, neutral kitchen backdrop, soft natural light, 30–45 degree angle, shallow depth of field.
Use ONLY these ingredients visually: ${allowed}. No other ingredients should appear.
No text, no logos, no people, no hands. Realistic, appetizing colors.`.trim();

  const dishLine = (() => {
    switch(dishType){
      case "rice": return "Prominent rice base ONLY if rice is in the list.";
      case "soup": return "Served in a bowl with visible broth.";
      case "salad": return "Fresh chopped ingredients, no heavy sauces.";
      case "pasta": return "Recognizable pasta shapes coated with sauce.";
      case "sandwich": return "Clear sandwich/wrap/burger presentation.";
      case "stew": return "Thick rich stew consistency.";
      case "grill": return "Grilled/charred visual cues.";
      case "baked": return "Oven-baked presentation.";
      case "dessert": return "Dessert styling.";
      default: return "Proper main-dish plating.";
    }
  })();

  const ingLine = (ingredients && ingredients.length) ? `Key ingredients: ${ingredients.join(", ")}.` : "";
  const stepsLine = (steps && steps.length) ? `Preparation summary: ${steps.join(" then ")}.` : "";

  return [base, dishLine, ingLine, stepsLine].filter(Boolean).join("\n");
}
function negativePrompt(meta){
  const { allowedSet, protein } = meta;
  const disallowed = COMMON_VISUAL_ING
    .map(t=>t.replace(/s$/,""))
    .filter(t=>!allowedSet.has(t));
  const base = [
    "text","watermark","logo","people","person","hands","fingers","portrait","selfie",
    "cartoon","unrealistic","clutter","low quality","lowres","blurry","artifacts",
    ...disallowed
  ];
  if (protein === "veg"){
    base.push(...TOK.chicken, ...TOK.meat, ...TOK.fish);
  } else if (protein === "chicken"){
    base.push(...TOK.fish);
  } else if (protein === "fish"){
    base.push(...TOK.chicken, ...TOK.meat);
  }
  return uniq(base).join(", ");
}
async function validateImageByTags(imageUrl, meta){
  try{
    const version = await replicateLatestVersion(REPLICATE_VALIDATOR.owner, REPLICATE_VALIDATOR.name);
    const input = { image: imageUrl, mode: "fast" };
    const result = await replicatePredict(version, input);
    let tagsText = "";
    if(typeof result === "string" && /^https?:/.test(result)){
      const r = await fetch(result); tagsText = await r.text();
    }else{
      tagsText = JSON.stringify(result||{});
    }
    const text = tagsText.toLowerCase();
    for(const b of ["person","people","hand","hands","finger","portrait","selfie","man","woman","girl","boy"]) {
      if (text.includes(b)) return { ok:false, reason:`validator_person_${b}`, score: -50 };
    }
    // حساب درجة تقارب بسيطة
    let score = 0;
    score += scoreCandidateText(text, meta);
    return { ok: score >= 10, score };
  }catch(_){ return { ok:true, soft:true, score: 11 }; }
}
async function tryReplicateStrict(meta, seed){
  if(!REPLICATE_KEY) return { pass:false, reason:"no_replicate_key" };
  const prompt = buildReplicatePrompt(meta);
  const neg = negativePrompt(meta);
  const seeds = [seed, seed+1337, seed+7777];

  for(const model of REPLICATE_MODEL_CANDIDATES){
    let versionId = null;
    try{ versionId = await replicateLatestVersion(model.owner, model.name); }
    catch(_){ continue; }
    for(const sd of seeds){
      try{
        const input = (model.name === "sdxl")
          ? { prompt, negative_prompt: neg, width: 832, height: 624, scheduler:"K_EULER", num_inference_steps: 28, guidance_scale: 7.5, seed: sd }
          : { prompt, negative_prompt: neg, width: 832, height: 624, num_inference_steps: 12, seed: sd };
        const url = await replicatePredict(versionId, input);
        const check = await validateImageByTags(url, meta);
        if(check.ok){
          const { dataUrl, mime } = await fetchAsDataURL(url, 22000);
          return { pass:true, data:{ dataUrl, mime: mime||"image/png", mode:"inline" } };
        }
      }catch(_){}
    }
  }
  return { pass:false, reason:"replicate_failed" };
}

/* =============== Placeholder =============== */
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

/* =============== HTTP Handler =============== */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };

  if (event.httpMethod === "GET") {
    return ok({
      info: "generateRecipeImage (AI → StrictSVG fallback → Free sources) alive. Use POST to generate an image.",
      providers_available: { replicate: !!REPLICATE_KEY, google_models: !!GEMINI_KEY, wikimedia: true, wikipedia: true, wikidata: true, openverse: true, pexels: !!PEXELS_KEY }
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

  const protein  = detectProtein({ title, ingredients });
  const dishType = detectDishType({ title, ingredients, steps });
  const allowedSet = ingredientsAllowedTokens(ingredients);

  const meta = { title, ingredients, steps, cuisine, lang, protein, dishType, allowedSet };

  // 1) Replicate (محاولات + Validator)
  let usedStrict = false;
  try{
    const seed = stableSeedFrom(`${title}|${ingredients.join(",")}|${cuisine}|${protein}|${dishType}`);
    const r = await tryReplicateStrict(meta, seed);
    if(r.pass){
      return ok({ image:{ ...r.data } });
    }else{
      // توليد صورة مضمونة SVG لتفادي الخلط
      const svg = buildStrictSVG(meta);
      usedStrict = true;
      return ok({ image:{ mime: svg.mime, mode: svg.mode, data_url: svg.dataUrl } });
    }
  }catch(_){}

  // 2) Google: إن وُجد، لكن سنستخدم StrictSVG لو تعذر أو أخفق
  try{
    const g = await tryGoogleImage(meta);
    if(g && g.dataUrl) return ok({ image:{ mime: g.mime || "image/png", mode: g.mode || "inline", data_url: g.dataUrl } });
  }catch(_){}
  // عند الفشل أو عدم توفر نموذج — ننتج StrictSVG لضمان الدقة
  if(!usedStrict){
    const svg = buildStrictSVG(meta);
    // قبل المصادر المجانية: نُفضّل المضمون على صورة قد تخلط
    return ok({ image:{ mime: svg.mime, mode: svg.mode, data_url: svg.dataUrl } });
  }

  // 3) Wikimedia Commons
  try{
    const w = await tryWikimedia(meta);
    if(w && w.dataUrl) return ok({ image:{ mime: w.mime || "image/jpeg", mode: w.mode || "inline", data_url: w.dataUrl } });
  }catch(_){}

  // 4) Wikipedia PageImages
  try{
    const pi = await tryWikipediaPageImage(meta);
    if(pi && pi.dataUrl) return ok({ image:{ mime: pi.mime || "image/jpeg", mode: pi.mode || "inline", data_url: pi.dataUrl } });
  }catch(_){}

  // 5) Wikidata (P18)
  try{
    const wd = await tryWikidataP18(meta);
    if(wd && wd.dataUrl) return ok({ image:{ mime: wd.mime || "image/jpeg", mode: wd.mode || "inline", data_url: wd.dataUrl } });
  }catch(_){}

  // 6) Openverse
  try{
    const ov = await tryOpenverse(meta);
    if(ov && ov.dataUrl) return ok({ image:{ mime: ov.mime || "image/jpeg", mode: ov.mode || "inline", data_url: ov.dataUrl } });
  }catch(_){}

  // 7) Pexels
  try{
    const p = await tryPexels(meta);
    if(p && p.dataUrl) return ok({ image:{ mime: p.mime || "image/jpeg", mode: p.mode || "inline", data_url: p.dataUrl } });
  }catch(_){}

  // 8) Placeholder
  return ok({ image:{ mime:"image/svg+xml", mode:"inline", data_url: placeholderDataURL() } });
};
