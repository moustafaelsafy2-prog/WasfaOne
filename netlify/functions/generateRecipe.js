// /netlify/functions/generateRecipe.js
// Netlify Function V1 — Proxy to Gemini API securely (API key hidden in server)

const GEMINI_API_URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function resp(status, obj) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

async function callGemini(payload) {
  const url = GEMINI_API_URL_BASE + encodeURIComponent(GEMINI_API_KEY);
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204 };
    if (event.httpMethod !== "POST") return resp(405, { ok: false, error: "method_not_allowed" });

    if (!GEMINI_API_KEY) return resp(500, { ok: false, error: "gemini_key_missing" });

    const body = event.body ? JSON.parse(event.body) : null;
    if (!body) return resp(400, { ok: false, error: "missing_body" });

    const { mealType, cuisine, dietType, calorieTarget, commonAllergy, customAllergy, focus } = body;
    if (!mealType || !cuisine || !calorieTarget) {
      return resp(400, { ok: false, error: "missing_fields" });
    }

    // Build constraints
    let dietConstraints = "";
    if (dietType === "نظام د. محمد سعيد") {
      dietConstraints = `
        **يجب أن تلتزم بدقة بمتطلبات نظام د. محمد سعيد (نظام كيتوني معدّل):**
        - خالية تماماً من الكربوهيدرات المرتفعة والسكريات.
        - خالية تماماً من الجلوتين، اللاكتوز، الليكتين، والبقوليات.
        - خالية تماماً من الزيوت المهدرجة.
        - مسموح فقط بالدهون الصحية (مثل زيت الزيتون، الأفوكادو).
        - مسموح فقط بالأجبان الدسمة من أصل حيواني والزبادي اليوناني.
      `;
    } else {
      dietConstraints = `تناسب النظام الغذائي "${dietType}".`;
    }

    let allergyConstraint = "";
    if ((commonAllergy && commonAllergy !== "لا يوجد") || (customAllergy && customAllergy.trim())) {
      const allergies = [];
      if (commonAllergy && commonAllergy !== "لا يوجد") allergies.push(commonAllergy);
      if (customAllergy && customAllergy.trim()) allergies.push(customAllergy.trim());
      allergyConstraint = `**ويجب أن تكون خالية تمامًا من المكونات التالية (حساسية):** ${allergies.join(' و ')}.`;
    }

    const systemPrompt = `أنت شيف خبير في التغذية. مهمتك هي إنشاء وصفة طعام كاملة ومفصلة باللغة العربية بناءً على طلب المستخدم. يجب أن تتضمن الوصفة اسم الوجبة، وقت التحضير، عدد الحصص، قائمة المكونات، طريقة التحضير خطوة بخطوة، والماكروز (السعرات الحرارية، البروتين، الكربوهيدرات، الدهون). يجب أن يكون الرد بتنسيق JSON حصراً. **يجب أن تلتزم بدقة بالسعرات الحرارية المطلوبة والقيود الغذائية والحساسيات المذكورة.**`;

    const userQuery = `
      أريد وصفة لوجبة "${mealType}"، من المطبخ "${cuisine}".
      ${dietConstraints}
      **يجب أن تكون السعرات الحرارية للوجبة الواحدة حوالي ${calorieTarget} سعرة حرارية.**
      ${allergyConstraint}
      مع التركيز الإضافي على: "${focus || ""}".

      **ملحوظة هامة للمكونات:** يجب أن تكون الكميات في حقل 'quantity' دقيقة، باستخدام **وحدات الميزان (جرام أو مل)**، متبوعة بالقياس المعتاد بين قوسين لسهولة التنفيذ. مثال: '250 جرام (1 كوب)' أو '120 مل (نصف كوب)'.
    `;

    const payload = {
      contents: [{ parts: [{ text: userQuery }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            time: { type: "STRING" },
            servings: { type: "STRING" },
            macros: {
              type: "OBJECT",
              properties: {
                calories: { type: "STRING" },
                protein: { type: "STRING" },
                carbs: { type: "STRING" },
                fats: { type: "STRING" }
              }
            },
            ingredients: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  quantity: { type: "STRING" }
                }
              }
            },
            preparation: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  title: { type: "STRING" },
                  instruction: { type: "STRING" }
                }
              }
            }
          },
          required: ["title", "time", "servings", "macros", "ingredients", "preparation"]
        }
      }
    };

    // Retry logic
    const maxRetries = 3;
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await callGemini(payload);
        if (!res.ok) {
          const status = res.status;
          const text = await res.text();
          if ((status === 429 || status >= 500) && attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          return resp(502, { ok: false, error: "gemini_error", status, body: text.slice(0,200) });
        }
        const result = await res.json();
        const jsonString = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonString) return resp(502, { ok: false, error: "no_model_output", raw: result });
        let parsed;
        try {
          parsed = JSON.parse(jsonString);
        } catch (e) {
          return resp(502, { ok: false, error: "parse_failed", message: e.message, sample: jsonString.slice(0,500) });
        }
        return resp(200, { ok: true, recipe: parsed });
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
    }

    return resp(500, { ok: false, error: "exception", message: lastErr?.message || "unknown" });

  } catch (err) {
    return resp(500, { ok: false, error: "exception", message: err.message });
  }
};
