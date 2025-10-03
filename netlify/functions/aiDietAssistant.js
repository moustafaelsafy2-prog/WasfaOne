// /netlify/functions/aiDietAssistant.js

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// الإعدادات العامة
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// تم تحديث قائمة النماذج لضمان أعلى توافر وسرعة
const MODEL_POOL = [
  "gemini-1.5-pro-latest",
  "gemini-1.5-pro",
  "gemini-1.5-pro-001",
  "gemini-pro",
  "gemini-1.0-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-1.5-flash",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash-latest"
];

// حد أقصى لحجم الذاكرة النصية (حروف)
const MAX_MEMORY_CHARS = 14000;

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// أدوات محلية (Tooling) قابلة للنداء من النموذج عبر function calling
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
const Tools = {
  calculateCalories: {
    name: "calculateCalories",
    description:
      "احسب BMR وTDEE وتوزيع الماكروز وفق الهدف (خسارة دهون/ثبات/زيادة)، مع دعم الجنس والعمر والطول والوزن ومستوى النشاط ونِسَب الماكروز.",
    parameters: {
      type: "OBJECT",
      properties: {
        sex: { type: "STRING", description: "male | female" },
        age: { type: "NUMBER", description: "بالسنوات" },
        height_cm: { type: "NUMBER", description: "الطول بالسنتمتر" },
        weight_kg: { type: "NUMBER", description: "الوزن بالكيلوغرام" },
        activity_level: {
          type: "STRING",
          description:
            "sedentary|light|moderate|high|athlete — لتحديد معامل النشاط"
        },
        goal: {
          type: "STRING",
          description: "cut|recomp|bulk (خسارة|ثبات/إعادة تركيب|زيادة)"
        },
        macro_pref: {
          type: "OBJECT",
          description:
            "اختياري: تخصيص نسب الماكروز {protein_ratio, fat_ratio, carb_ratio}",
          properties: {
            protein_ratio: { type: "NUMBER" },
            fat_ratio: { type: "NUMBER" },
            carb_ratio: { type: "NUMBER" }
          }
        },
        protein_per_kg: {
          type: "NUMBER",
          description: "جرام بروتين/كجم (إن أُعطي، يُغلِّب على النسب)"
        },
        deficit_or_surplus_pct: {
          type: "NUMBER",
          description:
            "نسبة العجز/الفائض من TDEE (سالب للخسارة، موجب للزيادة). اختياري."
        }
      },
      required: ["sex", "age", "height_cm", "weight_kg", "activity_level", "goal"]
    }
  },

  parseFoods: {
    name: "parseFoods",
    description:
      "حلّل قائمة أطعمة/وجبات بصياغة حرّة وأخرج تقديرًا للسعرات والبروتين والدهون والكارب لكل عنصر، بالاعتماد على جدول داخلي مبسّط.",
    parameters: {
      type: "OBJECT",
      properties: {
        items: {
          type: "ARRAY",
          description: "مصُفوفة عناصر طعام بنصوص طبيعية",
          items: { type: "STRING" }
        },
        locale: { type: "STRING", description: "ar|en لتفضيل وحدات العرض" }
      },
      required: ["items"]
    }
  },

  correctText: {
    name: "correctText",
    description:
      "تصحيح إملائي/لهجي للجمل العربية (ودعم أخطاء بسيطة بالإنجليزية) دون تغيير المعنى. يُعيد النص المصحّح فقط.",
    parameters: {
      type: "OBJECT",
      properties: {
        text: { type: "STRING" }
      },
      required: ["text"]
    }
  }
};

// قواعد حسابية مساعدة
function activityFactor(level) {
  switch ((level || "").toLowerCase()) {
    case "sedentary":
      return 1.2;
    case "light":
      return 1.375;
    case "moderate":
      return 1.55;
    case "high":
      return 1.725;
    case "athlete":
      return 1.9;
    default:
      return 1.4; // قيمة وسطية آمنة
  }
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

// تنفيذ الأدوات محليًا
const LocalToolExecutors = {
  calculateCalories: (args) => {
    const {
      sex,
      age,
      height_cm,
      weight_kg,
      activity_level,
      goal,
      macro_pref,
      protein_per_kg,
      deficit_or_surplus_pct
    } = args;

    // Mifflin–St Jeor
    const s = sex && sex.toLowerCase() === "female" ? -161 : 5;
    const BMR = 10 * weight_kg + 6.25 * height_cm - 5 * age + s;

    const TDEE_base = BMR * activityFactor(activity_level);
    const adjPct =
      typeof deficit_or_surplus_pct === "number"
        ? deficit_or_surplus_pct
        : goal === "cut"
        ? -15
        : goal === "bulk"
        ? 12
        : 0;

    const TDEE = TDEE_base * (1 + adjPct / 100);

    // بروتين
    const protein =
      typeof protein_per_kg === "number" && protein_per_kg > 0
        ? protein_per_kg * weight_kg
        : clamp(1.6 * weight_kg, 1.4 * weight_kg, 2.2 * weight_kg); // 1.6–2.2 جم/كجم

    const protein_kcal = protein * 4;

    // نسب الماكروز (إن لم تُحدَّد)
    let fat_ratio = 0.35;
    let carb_ratio = 0.35;
    if (goal === "cut") {
      fat_ratio = 0.40;
      carb_ratio = 0.25;
    } else if (goal === "bulk") {
      fat_ratio = 0.30;
      carb_ratio = 0.45;
    }
    if (macro_pref) {
      fat_ratio = macro_pref.fat_ratio ?? fat_ratio;
      carb_ratio = macro_pref.carb_ratio ?? carb_ratio;
    }

    // المحتوى الدهني والكارب من المتبقي بعد البروتين
    const rem_kcal = Math.max(0, TDEE - protein_kcal);
    let fat_kcal = rem_kcal * fat_ratio;
    let carb_kcal = rem_kcal * carb_ratio;

    // تحويل إلى جرامات
    const fat = fat_kcal / 9;
    const carbs = carb_kcal / 4;

    return {
      BMR: roundAll(BMR),
      TDEE_base: roundAll(TDEE_base),
      TDEE: roundAll(TDEE),
      protein_g: roundAll(protein),
      fat_g: roundAll(fat),
      carbs_g: roundAll(carbs),
      notes:
        "القيم تقديرية وليست وصفًا طبيًا. اضبط أسبوعيًا بحسب الوزن والمحيط ونشاطك."
    };
  },

  parseFoods: (args) => {
    const db = {
      // قاعدة مبسطة (يمكن توسعتها لاحقًا)
      "بيضة كبيرة": { kcal: 72, p: 6, f: 5, c: 0.4, unit: "حبة" },
      "100g صدر دجاج": { kcal: 165, p: 31, f: 3.6, c: 0, unit: "100g" },
      "100g لحم بقري خالي": { kcal: 170, p: 26, f: 7, c: 0, unit: "100g" },
      "100g تونة مصفاة": { kcal: 132, p: 29, f: 1, c: 0, unit: "100g" },
      "100g ارز مطبوخ": { kcal: 130, p: 2.7, f: 0.3, c: 28, unit: "100g" },
      "100g شوفان": { kcal: 389, p: 17, f: 7, c: 66, unit: "100g" },
      "100g افوكادو": { kcal: 160, p: 2, f: 15, c: 9, unit: "100g" },
      "ملعقة زيت زيتون": { kcal: 119, p: 0, f: 13.5, c: 0, unit: "ملعقة" },
      "100g جبنه قريش": { kcal: 98, p: 11, f: 4.3, c: 3.4, unit: "100g" },
      "100g زبادي يوناني": { kcal: 59, p: 10, f: 0.4, c: 3.6, unit: "100g" },
      "حبة موز": { kcal: 105, p: 1.3, f: 0.4, c: 27, unit: "حبة" },
      "تفاحة": { kcal: 95, p: 0.5, f: 0.3, c: 25, unit: "حبة" }
    };

    const items = (args.items || []).map((s) => (s || "").trim()).filter(Boolean);

    const mapped = items.map((raw) => {
      const key = normalizeArabic(raw);
      // تبسيط مطابقات تقريبية
      let match = Object.keys(db).find((k) => key.includes(normalizeArabic(k)));
      if (!match) {
        return {
          item: raw,
          approx: true,
          kcal: 0,
          protein_g: 0,
          fat_g: 0,
          carbs_g: 0,
          note: "لم يتم التعرف بدقة — يرجى تحديد الوزن/الكمية."
        };
      }
      const r = db[match];
      return {
        item: raw,
        approx: false,
        kcal: r.kcal,
        protein_g: r.p,
        fat_g: r.f,
        carbs_g: r.c,
        ref_unit: r.unit
      };
    });

    const totals = mapped.reduce(
      (acc, x) => {
        acc.kcal += x.kcal || 0;
        acc.p += x.protein_g || 0;
        acc.f += x.fat_g || 0;
        acc.c += x.carbs_g || 0;
        return acc;
      },
      { kcal: 0, p: 0, f: 0, c: 0 }
    );

    return {
      items: mapped,
      totals: {
        kcal: roundAll(totals.kcal),
        protein_g: roundAll(totals.p),
        fat_g: roundAll(totals.f),
        carbs_g: roundAll(totals.c)
      }
    };
  },

  correctText: (args) => {
    const t = (args.text || "").trim();
    if (!t) return { corrected: "" };
    // تصحيح عربي مبسّط شائع + إزالة التشكيل + مسافات
    let x = normalizeArabic(t);
    x = x
      .replace(/\bبتستطبع\b/g, "بتستطيع")
      .replace(/\bريجيم\b/g, "نظام غذائي")
      .replace(/\bبروتين\b/g, "بروتين")
      .replace(/\bكارب\b/g, "كربوهيدرات")
      .replace(/\bكالوري\b/g, "سعرات")
      .replace(/\bجو\b/g, "جوّ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return { corrected: x };
  }
};

function roundAll(n) {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

function normalizeArabic(s) {
  return (s || "")
    .replace(/[\u064B-\u0652]/g, "") // إزالة التشكيل
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^0-9\u0600-\u06FFa-zA-Z\s.%]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toLowerCase();
}

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// توجيه النظام (System Instruction) — شخصية المساعد
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
const SYSTEM_PROMPT_AR = `
أنت مساعد تغذية احترافي يعمل كإنسان: مرن، متفهم، لبق، ويكتب بالعربية الفصحى المبسطة أو بلهجة المستخدم إن لزم.
المهام:
- الإجابة على كل الاستفسارات المتعلقة بالتغذية فقط: حساب السعرات والماكروز، تحليل الوجبات، اقتراح وجبات، تنظيم توقيت الأكل، حساسية/عدم تحمل مكونات، موازنة الألياف والماء والإلكترولايت، نصائح نمط حياة مرتبطة بالتغذية (غير طبية).
- التصحيح الذكي للأخطاء الإملائية واللهجات وفهم المقصود حتى مع صياغة ناقصة.
- تذكر سياق المحادثة وعدم تكرار الأسئلة. اسأل أسئلة قصيرة وقت الحاجة فقط لتخصيص أدق.
- أسلوب موجز، مباشر، بلا حشو، مع نقاط واضحة وخيارات قابلة للتنفيذ.
- لا طب ولا تشخيص ولا أدوية ولا نصائح علاجية: إن طلب المستخدم ما هو طبي/دوائي فوضّح القيود وابقِ ضمن التغذية.
- إن كان السؤال خارج التغذية: اعتذر باحترام وأعد توجيه الحديث لما يفيد في التغذية.

معايير الجودة:
- أجب بلغة المستخدم تلقائيًا (افتراضي العربية)، وصحّح بلطف إن كان هناك خطأ واضح ثم تابع الإجابة.
- أعطِ أرقامًا دقيقة قدر الإمكان، واذكر أنها تقديرية وليست وصفًا طبيًا.
- لا تكرر ما سُئلت عنه سابقًا داخل نفس المحادثة.
- عند الغموض، اسأل سؤالًا واحدًا صغيرًا يُزيل الالتباس ثم قدّم أفضل توصية عملية.
`;

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// تهيئة تعريفات الأدوات للنموذج
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
function geminiToolsSpec() {
  return [
    {
      functionDeclarations: Object.values(Tools).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }))
    }
  ];
}

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// استدعاء Gemini مع تتابع تنفيذ الأدوات (function calling loop)
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
async function callGeminiWithTools({ model, messages, memoryBlob }) {
  // تحويل الرسائل لصيغة Gemini
  const contents = [];

  if (memoryBlob) {
    contents.push({
      role: "user",
      parts: [{ text: `سياق سابق مختصر للمحادثة:\n${memoryBlob}` }]
    });
  }

  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : m.role; // user|system|model
    if (role === "system") continue; // سنستخدم system_instruction بدلاً من ذلك
    contents.push({ role, parts: [{ text: m.content }] });
  }

  // حلقة تنفيذ الأدوات — حتى 4 خطوات
  let loop = 0;
  let lastResponse = null;
  let toolInvocations = [];
  let currentContents = contents.slice();

  while (loop < 4) {
    loop++;

    const body = {
      contents: currentContents,
      tools: geminiToolsSpec(),
      systemInstruction: { role: "system", parts: [{ text: SYSTEM_PROMPT_AR }] }
    };

    const resp = await fetch(`${BASE}/${model}:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini error (${model}): ${resp.status} — ${errText}`);
    }

    const data = await resp.json();
    lastResponse = data;

    const candidate = data?.candidates?.[0];
    if (!candidate) break;

    const parts = candidate.content?.parts || [];
    const functionCalls = parts
      .map((p) => p.functionCall)
      .filter(Boolean);

    if (!functionCalls?.length) {
      // لا يوجد نداء أداة — إجابة نهائية
      break;
    }

    // نفّذ كل نداء أداة محليًا ثم أعد النتائج كـ tool response
    for (const fc of functionCalls) {
      const name = fc.name;
      const args = safeParseJSON(fc.args || "{}");
      const exec = LocalToolExecutors[name];
      let result;
      if (exec) {
        try {
          result = exec(args);
        } catch (e) {
          result = { error: `tool-exec-failed: ${e.message}` };
        }
      } else {
        result = { error: `tool-not-found: ${name}` };
      }

      toolInvocations.push({ name, args, result });

      // أضف ردّ الأداة لمحتوى المحادثة
      currentContents.push({
        role: "tool",
        parts: [
          {
            functionResponse: {
              name,
              response: { name, content: result }
            }
          }
        ]
      });
    }

    // بعد تغذية ردود الأدوات، سيكرر الدور لإنتاج رد نهائي
  }

  return { lastResponse, toolInvocations };
}

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// اختيار نموذج مع السقوط الاحتياطي (Fallback)
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
async function generateWithFallback(payload) {
  const errors = [];
  for (const model of MODEL_POOL) {
    try {
      const out = await callGeminiWithTools({ model, ...payload });
      const text =
        out.lastResponse?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text)
          ?.filter(Boolean)
          ?.join("\n")
          ?.trim() || "";

      if (text) {
        return {
          model,
          text,
          toolInvocations: out.toolInvocations
        };
      } else {
        errors.push(`empty-response:${model}`);
      }
    } catch (e) {
      errors.push(`${model}:${e.message}`);
      continue;
    }
  }
  throw new Error("All models failed: " + errors.join(" | "));
}

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// ذاكرة المحادثة (خفيفة) — تُحفظ وتُعاد للعميل ليُرسلها معنا لاحقًا
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
function makeMemoryBlob(prevBlob, newTurn) {
  const joined = `${(prevBlob || "").slice(-MAX_MEMORY_CHARS / 2)}\n${newTurn}`.slice(
    -MAX_MEMORY_CHARS
  );
  return joined;
}

// تقسيم أمني: منع الخروج عن نطاق التغذية
function isOutOfDomain(txt) {
  const t = normalizeArabic(txt);
  const banned = [
    "دواء",
    "تشخيص",
    "سرطان",
    "مضاد حيوي",
    "جرعه",
    "عمليه",
    "مرض نفسي",
    "صور اشعه",
    "تحاليل تفسير طبي",
    "سياسه",
    "ماليات شخصيه",
    "اختراق",
    "برمجه خبيثه",
    "سلاح"
  ];
  return banned.some((k) => t.includes(k));
}

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// معالج Netlify Function
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
exports.handler = async (event) => {
  try {
    // CORS
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: ""
      };
    }

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Method Not Allowed" })
      };
    }

    if (!GEMINI_API_KEY) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Missing GEMINI_API_KEY" })
      };
    }

    const req = JSON.parse(event.body || "{}");

    const {
      messages = [],
      memory = "",
      user = {}, // {name, sex, age, height_cm, weight_kg, activity_level, goal, preferences, allergies}
      locale = "ar"
    } = req;

    const lastUserMsg =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    if (isOutOfDomain(lastUserMsg)) {
      const reply =
        "أقدّر سؤالك، لكن دوري محصور في **التغذية فقط**. أخبرني بما يفيد تغذيتك: هدفك (خسارة/ثبات/زيادة)، طولك، وزنك، نشاطك، وحساسيّاتك الغذائية لأضبط لك السعرات والماكروز وخطة يومية عملية.";
      const mem = makeMemoryBlob(memory, `user:${lastUserMsg}\nassistant:${reply}`);
      return ok({
        reply,
        memory: mem,
        meta: { model: null, tools: [], guard: "out-of-domain" }
      });
    }

    // تحضير ذاكرة مختصرة تُمرّر للنموذج
    const memoryBlob = (memory || "").slice(-MAX_MEMORY_CHARS);

    // حقن بطاقة تعريف المستخدم (لتخصيص الإجابة عند الحاجة)
    const userCard = compactUserCard(user, locale);
    const decoratedMessages = [
      {
        role: "user",
        content:
          `بطاقة تعريف المستخدم (للتخصيص لا للعرض):\n${userCard}\n—\n` +
          `تعليمات عامة: كن مرنًا، صحّح لغويًا بلطف، لا تكرر الأسئلة، تذكّر السياق، ` +
          `واسأل سؤالًا واحدًا فقط عند الحاجة لقرار دقيق.`
      },
      ...messages
    ];

    // توليد
    const { model, text, toolInvocations } = await generateWithFallback({
      messages: decoratedMessages,
      memoryBlob
    });

    const responseText = postProcess(text, locale);

    // تحديث الذاكرة
    const newMemory = makeMemoryBlob(
      memory,
      `user:${lastUserMsg}\nassistant:${responseText}`
    );

    return ok({
      reply: responseText,
      memory: newMemory,
      meta: {
        model,
        tools: toolInvocations,
        tokens_hint: approxTokens(decoratedMessages, responseText)
      }
    });
  } catch (e) {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        reply:
          "حدث خلل غير متوقع. حاول إعادة الإرسال بصياغة مختصرة. إن استمر، أرسل: العمر/الطول/الوزن/النشاط/الهدف لنحسب لك السعرات فورًا.",
        error: String(e && e.message ? e.message : e)
      })
    };
  }
};

// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
// توابع مساعدة
// ــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــــ
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function ok(payload) {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(payload)
  };
}

function approxTokens(msgs, out) {
  const inLen =
    (msgs || [])
      .map((m) => (m.content || "").length)
      .reduce((a, b) => a + b, 0) || 0;
  const outLen = (out || "").length;
  return Math.round((inLen + outLen) / 4); // تقدير تقريبي
}

function safeParseJSON(s, fallback = {}) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function compactUserCard(u = {}, locale = "ar") {
  const lines = [];
  if (u.name) lines.push(`الاسم: ${u.name}`);
  if (u.sex) lines.push(`الجنس: ${u.sex}`);
  if (typeof u.age === "number") lines.push(`العمر: ${u.age}`);
  if (typeof u.height_cm === "number") lines.push(`الطول: ${u.height_cm} سم`);
  if (typeof u.weight_kg === "number")
    lines.push(`الوزن: ${u.weight_kg} كجم`);
  if (u.activity_level) lines.push(`النشاط: ${u.activity_level}`);
  if (u.goal) lines.push(`الهدف: ${u.goal}`);
  if (u.preferences) lines.push(`تفضيلات: ${Array.isArray(u.preferences) ? u.preferences.join(", ") : u.preferences}`);
  if (u.allergies) lines.push(`حساسيات: ${Array.isArray(u.allergies) ? u.allergies.join(", ") : u.allergies}`);
  lines.push(`اللغة: ${locale || "ar"}`);
  return lines.join(" | ");
}

function postProcess(text, locale) {
  let t = (text || "").trim();

  // تنظيف تحذيرات زائدة إن وُجدت من النموذج
  t = t.replace(/\n{3,}/g, "\n\n");

  // ضمان عربية افتراضيًا
  if (locale === "ar") {
    // لا شيء إضافي حاليًا — مكان مخصص لأي تحويلات مستقبلية
  }
  return t;
}
