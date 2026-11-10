# النشر

> **الحالة:** المشروع مجهَّز للنشر (ملفات الإعداد موجودة) لكنه **لم يُنشر بعد** على أي رابط.
> الخطوات التالية تنفَّذ بحساباتك على GitHub و Render و Vercel.

## البيئات

| البيئة | قاعدة البيانات | الأسرار | ملاحظات |
|---|---|---|---|
| Development | Docker محلي (`pnpm db:up`) | `.env` محلي | توثيق API على `/docs` |
| Staging | قاعدة Render مستقلة | مولَّدة مستقلة | `NODE_ENV=staging` — بلا بيانات إنتاج، ورابط محمي |
| Production | قاعدة Render مستقلة | مولَّدة مستقلة | `NODE_ENV=production` |

لا تُشارك قاعدة بيانات أو سر بين بيئتين.

## 1) GitHub

```bash
git remote add origin git@github.com:<الحساب>/abu-qamar-workforce.git
git push -u origin main
```

اجعل المستودع خاصًا. ملف `.github/workflows/ci.yml` يشغّل فحص الأنواع والاختبارات (وحدة + تكامل على PostgreSQL) والبناء عند كل دفع.

## 2) الخادم وقاعدة البيانات على Render

1. من Render: **New → Blueprint** واختر المستودع. الملف `render.yaml` ينشئ الخدمة `abu-qamar-api` والقاعدة `abu-qamar-db`.
2. `SESSION_SECRET` و `DATA_ENCRYPTION_KEY` يولَّدان تلقائيًا. أدخل يدويًا:

| المتغير | القيمة |
|---|---|
| `APP_URL` | رابط الواجهة على Vercel، مثل `https://abu-qamar.vercel.app` |
| `CORS_ORIGIN` | الرابط نفسه (وأي نطاق مخصص، مفصولة بفواصل) |
| `SETUP_TOKEN` | رمز عشوائي ≥ 32 حرفًا (للإعداد الأول فقط) |
| `SETUP_TOKEN_EXPIRES_AT` | وقت قريب، مثل بعد ساعة: `2026-12-01T12:00:00Z` |

توليد رمز: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

3. أمر التشغيل يطبّق الـ migrations ثم يقلع الخادم. فحص الصحة: `GET /health`.
4. تأكد: `https://<api>.onrender.com/health` يعيد `{"status":"ok","database":"up"}`.

**ملاحظات:**
- `TRUST_PROXY=2` (Vercel ← موازن Render). إن خاطبت الخادم مباشرة دون Vercel اجعله `1`.
- رابط Render المباشر يبقى متاحًا للعموم؛ الحماية بالجلسات و CORS وفحص Origin. تحديد المعدل لكل IP يعتمد على
  `X-Forwarded-For`، والحظر المؤقت لكل اسم مستخدم يعمل بمعزل عنه.
- الخطة المجانية تنام عند الخمول فيتأخر أول طلب؛ استخدم خطة مدفوعة للإنتاج.

## 3) الواجهة على Vercel

1. **Add New → Project** واختر المستودع. **Root Directory:** `apps/web` (الملف `vercel.json` يضبط أوامر التثبيت والبناء).
2. متغير البيئة (لكل من Production و Preview بقيمته):

| المتغير | القيمة |
|---|---|
| `API_URL` | رابط الخادم على Render، مثل `https://abu-qamar-api.onrender.com` |

`API_URL` يُقرأ **وقت البناء** (rewrites)، فأعد النشر بعد تغييره.

3. بعد النشر عُد إلى Render وحدّث `APP_URL` و `CORS_ORIGIN` برابط Vercel النهائي.

## 4) إنشاء الأدمن الأول

افتح `https://<الواجهة>/setup` وأدخل `SETUP_TOKEN`. بعد النجاح **احذف** `SETUP_TOKEN` و `SETUP_TOKEN_EXPIRES_AT` من Render.
(البديل: `pnpm admin:create` من Render Shell.)

## 5) Staging

كرر الخطوات بـ Blueprint ثانٍ (اسم خدمة وقاعدة مختلفان، `NODE_ENV=staging`) ومشروع Vercel ثانٍ أو بيئة Preview.
احمِ الرابط بـ Vercel Deployment Protection. لا تنسخ بيانات الإنتاج إليها.

## قائمة التحقق قبل اعتماد الإنتاج

- [ ] CI أخضر على `main`.
- [ ] `/health` يعمل، و`/docs` مغلق (`ENABLE_API_DOCS=false`).
- [ ] الدخول يعمل من نطاق الواجهة والكوكي `__Host-aq_session` تظهر `Secure; HttpOnly; SameSite=Lax`.
- [ ] حُذف `SETUP_TOKEN` بعد إنشاء الأدمن.
- [ ] فُعِّلت المصادقة الثنائية لحساب الأدمن.
- [ ] تنبيهات فشل النشر والخدمة مفعّلة في Render، والسجلات تُراجع.
- [ ] **النسخ الاحتياطي والاسترداد مبنيان ومختبران (المرحلة السادسة)** — شرط قبل إدخال بيانات حقيقية.

## المتبقي لمرحلة الإطلاق (السابعة)

مراقبة الأخطاء (مثل Sentry)، مهام النسخ المجدولة، اختبار الاسترداد، ومراجعة أمنية شاملة.
