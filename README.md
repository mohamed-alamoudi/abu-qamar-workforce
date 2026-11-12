# نظام إدارة موظفي سوبر ماركت أبو قمر

نظام ويب لإدارة الموظفين والحضور والانصراف والرواتب — عربي RTL، للجوال والكمبيوتر، بوضع فاتح وداكن.

## حالة المشروع

| المرحلة | الحالة |
|---|---|
| 1 — التأسيس والمصادقة والصلاحيات وسجل التدقيق | **مكتملة ومختبرة محليًا** |
| 2 — الموظفون والأقسام وتاريخ الأجور | **مكتملة ومختبرة محليًا** |
| 3 — الحضور والانصراف | التسجيل والمراجعة والاستراحات والجداول والإجازات والإضافي |
| 4 — المحرك المالي | الرواتب والدفعات والسلف والديون والتسويات |
| 5 — التقارير | لم تبدأ |
| 6 — العمل دون إنترنت والنسخ الاحتياطي | تنفيذ فرع platform، وربط إجراءات الحضور عند الدمج |
| 7 — الإطلاق | إعدادات تشغيل موثقة، والنشر بانتظار الدمج والتحقق على Staging |



## المتطلبات

Node.js 20.11+ (جُرِّب على 24) · pnpm 10 عبر `corepack enable` · Docker لقاعدة PostgreSQL المحلية

## التشغيل لأول مرة

```bash
corepack enable
pnpm install

cp .env.example .env
# املأ في .env: POSTGRES_PASSWORD (وضعها مكان CHANGE_ME في الرابطين) و SESSION_SECRET و DATA_ENCRYPTION_KEY و SETUP_TOKEN
# توليد قيمة عشوائية: node infra/scripts/generate-secret.mjs

pnpm db:up          # حاويتا PostgreSQL: التطوير (5432) والاختبار (5433)
pnpm build:packages
pnpm db:deploy      # تطبيق الـ migrations
pnpm dev            # الواجهة http://localhost:3000 — الخادم http://localhost:4000 — التوثيق http://localhost:4000/docs
```

**إنشاء الأدمن الأول** (مرة واحدة): افتح `http://localhost:3000/setup` وأدخل قيمة `SETUP_TOKEN`،
أو نفّذ `pnpm admin:create` من الطرفية.

## الأوامر

| الأمر | الوظيفة |
|---|---|
| `pnpm dev` | تشغيل الخادم والواجهة معًا |
| `pnpm build` | بناء الخادم والواجهة |
| `pnpm lint` | فحص ESLint للتطبيقات والحزم والاختبارات |
| `pnpm typecheck` | فحص الأنواع في كل الحزم |
| `pnpm test:unit` | اختبارات الوحدة (لا تحتاج قاعدة بيانات) |
| `pnpm test:integration` | اختبارات التكامل على قاعدة الاختبار (تُمسح بياناتها) |
| `pnpm test:e2e` | Playwright (يحتاج النظام مشغَّلًا و`pnpm --filter @abu-qamar/e2e install:browsers`) |
| `pnpm db:migrate` / `db:deploy` / `db:seed` | إدارة قاعدة البيانات |
| `pnpm admin:create` | إنشاء الأدمن الأول من الطرفية |
| `pnpm --filter @abu-qamar/api backup scheduled` | تشغيل النسخ المجدولة وتنظيف النسخ المنتهية بعد بناء الخادم |

## نتائج الاختبارات (آخر تشغيل محلي)

| المجموعة | النتيجة |
|---|---|
| وحدة — `packages/shared` | 9 / 9 |
| وحدة — `apps/web` | 13 / 13 |
| وحدة — `apps/api` | 37 / 37 |
| تكامل (PostgreSQL 16 حقيقية) | 76 / 76، منها الاسترداد إلى قاعدة منفصلة |
| بناء الخادم والواجهة | ناجح |
| E2E (Chromium عبر Playwright) | 15 نجحت، وتُخطّي سيناريو الجوال في مشروع سطح المكتب |

## التوثيق

[البنية](docs/architecture.md) · [قاعدة البيانات](docs/database.md) · [الصلاحيات](docs/permissions.md) ·
[قواعد الرواتب](docs/payroll-rules.md) · [المحرك المالي](docs/finance.md) · [الاختبارات](docs/testing.md) · [النشر](docs/deployment.md) ·
[النسخ الاحتياطي](docs/backup-restore.md)
[قواعد الرواتب](docs/payroll-rules.md) · [الاختبارات](docs/testing.md) · [النشر](docs/deployment.md) ·
[النسخ الاحتياطي](docs/backup-restore.md) · [المزامنة دون اتصال](docs/offline-sync.md)

## ملاحظات معروفة

- `prisma migrate dev` سيقترح دائمًا تعديلًا شكليًا على القيمة الافتراضية لـ `employees.code`
  (PostgreSQL يعيد صياغة التعبير). التعديل بلا أثر؛ احذفه من الـ migration المولَّد أو اتركه.
- جدول عمل الموظف يُدار من صفحة جداول العمل ضمن الحضور والانصراف.
- لا يوجد إعداد ESLint بعد؛ الاعتماد حاليًا على فحص الأنواع والاختبارات.
- رمز TOTP يمكن استخدامه أكثر من مرة خلال نافذته الزمنية (≈90 ثانية)؛ منع إعادة الاستخدام مؤجل.
