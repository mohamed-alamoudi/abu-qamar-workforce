# قاعدة البيانات

PostgreSQL 16 + Prisma. المخطط: `packages/database/prisma/schema.prisma`.

## القواعد العامة

- المعرفات `UUID`، المبالغ `Decimal(12,2)`، الأوقات `timestamptz` (UTC)، والتواريخ المحلية `date`.
- أسماء الجداول snake_case، والأعمدة camelCase (افتراضي Prisma) — انتبه لعلامات الاقتباس في SQL اليدوي.
- لا حذف للسجلات المرتبطة: كل المفاتيح الأجنبية للسجلات التاريخية `ON DELETE RESTRICT`.

## الـ migrations

| المجلد | المحتوى |
|---|---|
| `20261110000000_prerequisites` | إضافة `btree_gist` وتسلسل كود الموظف |
| `20261110000100_init` | كل الجداول والفهارس والمفاتيح (مولَّد من Prisma) |
| `20261110000200_advanced_constraints` | قيود EXCLUDE و CHECK والـ triggers (SQL يدوي) |

```bash
pnpm db:migrate    # تطوير: إنشاء/تطبيق migration جديد
pnpm db:deploy     # إنتاج/اختبار: تطبيق ما لم يُطبَّق فقط
pnpm db:seed       # مزامنة البيانات المرجعية (الصلاحيات والإعدادات الافتراضية) — بلا بيانات وهمية
```

> عند تعديل المخطط لاحقًا: راجع ملف الـ migration المولَّد قبل تطبيقه، وتأكد أنه لا يحذف قيدًا من
> `advanced_constraints` (Prisma لا يعرف هذه القيود).

## الجداول

**المستخدمون والأمان:** `users`, `permissions`, `user_permissions`, `sessions`, `user_recovery_codes`, `login_attempts`, `audit_logs`

**الموظفون:** `departments`, `employees`, `employee_department_history`, `pay_rates`, `employee_pay_policies`, `employee_schedules`, `schedule_shifts`

**الدوام:** `work_sessions`, `work_breaks`, `attendance_corrections`, `attendance_approvals`, `leave_records`, `overtime_policies`, `overtime_entries`

**المالية:** `payroll_periods`, `payroll_entries`, `payroll_entry_components`, `payroll_adjustments`, `financial_transactions`, `advance_accounts`, `debt_accounts`, `debt_movements`, `settlement_allocations`

**النظام:** `sync_operations`, `notifications`, `system_settings`, `backup_records`

## القيود المتقدمة (خط الدفاع الأخير)

### منع التداخل (EXCLUDE)

| الجدول | القاعدة |
|---|---|
| `pay_rates` | لا تتداخل فترات الأجر للموظف نفسه |
| `employee_pay_policies`, `employee_schedules`, `employee_department_history` | لا تتداخل فترات السريان للموظف |
| `overtime_policies` | لا تتداخل لكل موظف، ولا للسياسة العامة |
| `work_sessions` | لا تتداخل ورديات الموظف؛ الوردية المفتوحة تمنع حضورًا جديدًا؛ الملغاة مستثناة |
| `schedule_shifts` | لا تتداخل الورديات المجدولة للموظف |
| `leave_records` | لا تتداخل الإجازات القائمة (المعلقة/المعتمدة) |
| `payroll_entries` | لا تتداخل فترات الرواتب للموظف — يمنع احتساب المستحق مرتين |
| `users` | أدمن واحد فقط |

### منع التكرار (UNIQUE)

`financial_transactions.idempotencyKey` · `financial_transactions.reversesId` (عكس واحد لكل عملية) ·
`work_sessions.clientOperationId` · `sync_operations.operationId` · `payroll_periods(frequency, startDate, endDate)` ·
`payroll_entries(periodId, employeeId)`.

### السجلات غير القابلة للتعديل (triggers)

| الجدول | المسموح |
|---|---|
| `audit_logs`, `debt_movements`, `settlement_allocations`, `attendance_corrections` | إضافة فقط |
| `financial_transactions` | إضافة، وتغيير الحالة `POSTED → REVERSED` فقط. لا حذف ولا تعديل |
| `payroll_periods` المغلقة | تُحمى من التعديل والحذف. يسمح الخادم بفتحها إلى مسودة بعد إعادة التحقق إذا لم ترتبط بحركة مالية أو فرق راتب، مع حفظ الحساب السابق في التدقيق |
| `payroll_entries` في فترة مغلقة | تغيير `paidAmount` فقط (تسجيل الدفعات) |
| `payroll_entry_components` في فترة مغلقة | لا إضافة ولا تعديل ولا حذف |

### قيود CHECK (أمثلة)

الانصراف بعد الحضور · حالة الوردية تطابق أوقاتها · المبالغ موجبة · رصيد السلفة/الدين بين 0 والأصل ·
المدفوع لا يتجاوز الصافي · الأجر اليومي النسبي يتطلب ساعات مرجعية صريحة · كل توزيع تسوية يرتبط بالتزام واحد مطابق لنوعه ·
العملية العكسية تشير إلى أصلها.

كل هذه القيود مغطاة باختبارات في `tests/integration/database-constraints.int-spec.ts`.
