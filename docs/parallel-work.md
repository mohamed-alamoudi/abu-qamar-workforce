# العمل المتوازي على المراحل المتبقية

أربعة أقسام تُنفَّذ بالتوازي، كل قسم في git worktree وفرع خاص به. هذه القواعد تمنع تصادم الأقسام على الجهاز نفسه.

## الأقسام

| القسم | المحتوى | قاعدة الاختبار | قاعدة التطوير | منفذ الخادم / الواجهة |
|---|---|---|---|---|
| 1 `attendance` | الحضور والانصراف والاستراحات والجداول والإجازات والإضافي | `abu_qamar_test_attendance` | `abu_qamar_dev_attendance` | 4010 / 3010 |
| 2 `finance` | حساب الأجور، فترات الرواتب، الدفعات، السلف، الديون، التسويات | `abu_qamar_test_finance` | `abu_qamar_dev_finance` | 4020 / 3020 |
| 3 `reports` | التقارير الأربعة، الرسوم، تصدير PDF و Excel | `abu_qamar_test_reports` | `abu_qamar_dev_reports` | 4030 / 3030 |
| 4 `platform` | الأوفلاين والمزامنة، النسخ الاحتياطي، ESLint، Playwright، تجهيز الإطلاق | `abu_qamar_test_platform` | `abu_qamar_dev_platform` | 4040 / 3040 |

## تجهيز الـ worktree (مرة واحدة)

الـ worktree لا يحتوي `node_modules` ولا `.env` (كلاهما خارج git).

```bash
# 1) pnpm: الأمر غير موجود على PATH؛ أنشئ shim في مجلد مؤقت وأضفه إلى PATH في كل أمر
corepack enable --install-directory "<مجلد مؤقت>" pnpm
export PATH="<مجلد مؤقت>:$PATH"

# 2) الحزم (المخزن المحلي ممتلئ، فالتثبيت سريع)
pnpm install --prefer-offline

# 3) البيئة: انسخ ملف المستودع الأصلي ثم عدّل الروابط والمنافذ لقسمك
cp /c/xampp/htdocs/project/abu-qamar-workforce/.env .env
#   DATABASE_URL       → .../abu_qamar_dev_<القسم>     (المنفذ 5432)
#   DATABASE_URL_TEST  → .../abu_qamar_test_<القسم>    (المنفذ 5433)
#   PORT, API_URL, APP_URL, CORS_ORIGIN → منافذ قسمك من الجدول

# 4) قاعدتا القسم داخل الحاويتين المشتركتين
docker exec abu-qamar-db-1 createdb -U abuqamar abu_qamar_dev_<القسم>
docker exec abu-qamar-db-test-1 createdb -U abuqamar abu_qamar_test_<القسم>

pnpm build:packages && pnpm db:deploy
```

لا تطبع محتوى `.env` ولا تنسخ أسراره إلى أي ملف داخل git.

## قواعد إلزامية

- **لا تستخدم** القاعدتين `abu_qamar_dev` و `abu_qamar_test` ولا المنفذين 3000 و4000 (للمستودع الأصلي).
- **لا توقف ولا تعيد إنشاء** حاويتي Docker (مشتركتان). الحاوية `db-test` تخزينها في الذاكرة: إن أُعيد تشغيلها فأعد `createdb`.
- **لا push ولا نشر.** commit على فرع القسم فقط.
- **الـ migrations:** إضافة فقط، بملف جديد اسمه يبدأ بطابع زمني بعد `20261110000200` ويحمل اسم القسم
  (مثل `20261112090000_attendance_...`). لا تعدّل ملفات migration موجودة. راجع SQL المولَّد واحذف منه أي سطر
  يمس قيدًا من `advanced_constraints` أو القيمة الافتراضية لـ `employees.code` (ضجيج معروف).
- **الملفات المشتركة** (`schema.prisma`، `app.module.ts`، `apps/web/src/lib/nav.ts`، `packages/shared/src/permissions.ts`،
  `apps/web/src/lib/types.ts`): أضف فقط ولا تعِد ترتيب أو تنسيق ما هو موجود، حتى يسهل الدمج.
- **لا بيانات وهمية** في الكود. بيانات الاختبار تُنشأ داخل الاختبارات فقط.
- اتبع أنماط الكود القائمة: `SecurityGuard` والـ decorators (الافتراضي «للأدمن فقط»)، `AuditService.log` داخل معاملة العملية،
  `Errors.*` برسائل عربية، التواريخ عبر `common/utils/dates.ts`، والمبالغ `Decimal` دائمًا (لا `number` في الحساب).
- اختبارات التكامل في `tests/integration/*.int-spec.ts` على نمط `helpers.ts`.

## مزالق معروفة في هذه البيئة (Windows + Git Bash)

- لا تستعمل `python` في الأوامر (يتعلق). استعمل `node -e` أو أدوات التحرير.
- لا تضع backticks داخل نص `node -e "..."` في Bash (تُنفَّذ كأوامر). اكتب الملف بأداة الكتابة بدل ذلك.
- `nest build` مع `incremental` ينتج `dist` ناقصًا — الخيار مُزال من `tsconfig`، فلا تُعده.
- أي حزمة يستوردها الخادم مباشرة يجب أن تكون في `apps/api/package.json` (pnpm لا يرفع الحزم العابرة).
- الشبكة بطيئة أحيانًا: استعمل `--prefer-offline` وتجنّب حزمًا جديدة لا لزوم لها.

## تعريف «تم»

فحص الأنواع نظيف · اختبارات الوحدة والتكامل (القديمة والجديدة) ناجحة · بناء الخادم والواجهة ناجح ·
التحقق من الواجهة في المتصفح · تحديث `docs/` و `README.md` · commit على فرع القسم ·
تقرير صادق بما أُنجز وما لم يُنجز وما افتُرض.
