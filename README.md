# WasfaOne

**تطبيق ويب جاهز للنشر على Netlify** لتوليد وصفات طعام باستخدام **Gemini API**، بدون قاعدة بيانات — التخزين عبر ملفات GitHub فقط.

---

## النشر (واجهة فقط — بلا أوامر)

1) أنشئ مستودع GitHub جديد وارفع جميع الملفات كما هي (حافظ على المسارات).
2) في Netlify: **Add new site → Import from Git →** اختر المستودع.
3) أضف متغيرات البيئة في Netlify (**Site settings → Environment variables**):

- `GEMINI_API_KEY`
- `GITHUB_TOKEN`
- `GITHUB_REPO_OWNER`
- `GITHUB_REPO_NAME`
- `GITHUB_REF` = `main`
- `ADMIN_PASSWORD`

ثم **Deploy**.

---

## الاختبار

- `/` صفحة الهبوط (AR/EN + حركات + دعم داكن/فاتح + خطوط Cairo/Inter واضحة + تباعد مضبوط).
- `/login.html` دخول demo:
  - Email: `demo@example.com`
  - Password: `123456`
  - يتحقق من نافذة الاشتراك (`start_date`/`end_date`) والحالة.
  - إنشاء وربط بصمة جهاز واحد تلقائيًا.
- `/app.html` تعرض **آخر حالة تلقائيًا** وتولّد وصفة (AR/EN) ببنية JSON ثابتة.
- `/admin.html` إدارة:
  - **Users**: CRUD + ضبط تواريخ البداية/النهاية + **إعادة ربط الجهاز** (تصغير `device_fingerprint` و`session_nonce` و`auth_token`).
  - **Settings**: الشعار/التواصل/الأنظمة الغذائية.
  - **Images**: روابط جميع الصور + نص بديل AR/EN + معاينة فورية + تحقق روابط.
- `/.netlify/functions/health` ترجع `{ ok: true }` عند تكامل الوصول إلى GitHub.

> ملاحظة: كل الاستدعاءات حتمية الإخراج (Gemini مضبوط على `temperature=0, topP=1, topK=1, maxOutputTokens=1024`) مع **ذاكرة مستمرة لكل مستخدم** عبر ملفات `data/history`.

---

## البنية

- **واجهة**: HTML ثابت + Vanilla JS + Tailwind (CDN) + AOS (حركات) + خطوط Google + دعم RTL/LTR كامل.
- **وظائف Netlify**:
  - `login.js`: تحقق المستخدم + نافذة الاشتراك + قفل جهاز واحد + جلسة واحدة (`session_nonce`, `auth_token`).
  - `adminUsers.js`: CRUD للمستخدمين + إعادة ربط الجهاز.
  - `adminSettings.js`: إعدادات عامة وصور + تحقق روابط.
  - `userState.js`: جلب/تحديث آخر حالة للمستخدم.
  - `generateRecipe.js`: استدعاء Gemini + Cache بالهاش + تحقق Schema صارم.
  - `health.js`: فحص التكامل.
- **البيانات**: `data/users.json`, `data/settings.json`, وملفات `data/history/<email>.json` تُنشأ تلقائيًا عند الاستخدام.

---

## معايير الالتزام

- **جهاز واحد فقط** لكل حساب.
- **جلسة واحدة** وتتطلب إرسال `x-auth-token` و`x-session-nonce`.
- **بنية JSON ثابتة**:
