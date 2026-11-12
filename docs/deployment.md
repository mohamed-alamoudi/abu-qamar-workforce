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

اجعل المستودع خاصًا. ملف `.github/workflows/ci.yml` يشغّل ESLint وفحص الأنواع والاختبارات (وحدة + تكامل على PostgreSQL) والبناء عند كل دفع.

## 2) الخادم وقاعدة البيانات على Render

1. من Render افتح **New → Blueprint** واختر المستودع. ينشئ `render.yaml` خدمة `abu-qamar-api` بعملية واحدة، وقاعدة `abu-qamar-db` باتصال داخلي، ومهمة النسخ `abu-qamar-backups`. أضف إعدادات التخزين إلى مجموعة البيئة بعد إنشائها، ثم أعد تشغيل الخدمة إن تعذر بدء التشغيل الأول.
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
   فعّل **Include source files outside of the Root Directory** ليتمكن البناء من قراءة حزم مساحة العمل وملف القفل في الجذر.
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

## إعداد النسخ المجدولة على Render

تستعمل خدمة API ومهمة `abu-qamar-backups` صورة Docker نفسها المزودة بعميل PostgreSQL 16. أضف القيم التالية إلى مجموعة البيئة `abu-qamar-backup-storage` في لوحة Render ليتشارك الخادم والمهمة المفتاح وموقع التخزين.

- `BACKUP_ENCRYPTION_KEY` مفتاح مستقل وعشوائي
- `BACKUP_STORAGE_BUCKET` و`BACKUP_STORAGE_REGION` لتحديد الحاوية والمنطقة
- `BACKUP_STORAGE_ACCESS_KEY` و`BACKUP_STORAGE_SECRET_KEY` لبيانات اعتماد الحساب
- `BACKUP_STORAGE_ENDPOINT` عند استخدام مزود متوافق مع S3 بعنوان HTTPS مستقل
- `BACKUP_STORAGE_PREFIX` بادئة اختيارية ضمن الحاوية

استخدم مجموعة أسرار وحاوية أو بادئة منفصلة لبيئة الاختبار. جدول Cron مضبوط على 01:00 UTC. راجع سجل المهمة ونتيجة الاسترداد التجريبي قبل استخدام بيانات حقيقية.

## مراجعة الأمان

راجعت حماية الجلسات وArgon2id وCSRF وCORS وحد المعدل وصلاحيات الخادم ومسارات التدقيق. أضيف حقل زمني لمنع إعادة استخدام رمز TOTP بتحديث مشروط في قاعدة البيانات. تقتصر أحداث المراقبة عند ضبط `SENTRY_DSN` على حالة الخطأ الداخلية وبيئة التشغيل ورمز Prisma الآمن. تُستبعد بيانات الطلب والترويسات والكوكيز ونص الاستثناء. تتطلب الاستعادة نسخة موقعة مطابقة للبصمة والمخطط، وإعادة المصادقة، وإيقاف الكتابة في نسخة API الواحدة. يستخدم CLI والخادم قفلًا في PostgreSQL لمنع تزامن النسخ المجدولة والاستعادة.

قبل الإطلاق اختبر HTTPS والكوكيز و`TRUST_PROXY` عبر مسار Vercel وRender الفعلي، وتحقق من صلاحيات حساب التخزين واسترداد نسخة على Staging. يدعم وضع الصيانة الحالي تشغيل نسخة API واحدة.
