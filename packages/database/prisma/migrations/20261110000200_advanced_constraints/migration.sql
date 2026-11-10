-- ═══════════════════════════════════════════════════════════════════════════
-- قيود متقدمة لا يدعمها Prisma مباشرة: منع التداخل (EXCLUDE)، قيود CHECK،
-- وحماية السجلات غير القابلة للتعديل (triggers).
-- هذه القيود خط الدفاع الأخير: تبقى سارية حتى لو أخطأ كود التطبيق.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────── المستخدمون ─────────────

-- أدمن رئيسي واحد فقط (يصمد أمام طلبين متزامنين لإعداد الأدمن الأول).
ALTER TABLE "users" ADD CONSTRAINT "users_single_admin"
  EXCLUDE USING btree ("role" WITH =) WHERE ("role" = 'ADMIN');

ALTER TABLE "users" ADD CONSTRAINT "users_username_lowercase_chk"
  CHECK ("username" = lower("username"));

-- الأدمن الرئيسي لا يُعطَّل
ALTER TABLE "users" ADD CONSTRAINT "users_admin_always_active_chk"
  CHECK ("role" <> 'ADMIN' OR "isActive" = true);

-- ───────────── منع تداخل الفترات (تواريخ سريان) ─────────────

ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("effectiveFrom", "effectiveTo", '[]') WITH &&);
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_dates_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");
ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_amount_chk" CHECK ("amount" >= 0);

ALTER TABLE "employee_pay_policies" ADD CONSTRAINT "employee_pay_policies_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("effectiveFrom", "effectiveTo", '[]') WITH &&);
ALTER TABLE "employee_pay_policies" ADD CONSTRAINT "employee_pay_policies_dates_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");
ALTER TABLE "employee_pay_policies" ADD CONSTRAINT "employee_pay_policies_reference_hours_chk"
  CHECK ("referenceDailyHours" IS NULL OR ("referenceDailyHours" > 0 AND "referenceDailyHours" <= 24));
ALTER TABLE "employee_pay_policies" ADD CONSTRAINT "employee_pay_policies_fixed_days_chk"
  CHECK ("fixedMonthDays" IS NULL OR ("fixedMonthDays" BETWEEN 1 AND 31));
-- الأجر اليومي النسبي يتطلب ساعات مرجعية صريحة، وطريقة FIXED_DAYS تتطلب عدد الأيام
ALTER TABLE "employee_pay_policies" ADD CONSTRAINT "employee_pay_policies_proportional_chk"
  CHECK ("dailyPayMode" IS DISTINCT FROM 'PROPORTIONAL' OR "referenceDailyHours" IS NOT NULL);
ALTER TABLE "employee_pay_policies" ADD CONSTRAINT "employee_pay_policies_fixed_method_chk"
  CHECK ("absenceDeductionMethod" IS DISTINCT FROM 'FIXED_DAYS' OR "fixedMonthDays" IS NOT NULL);

ALTER TABLE "employee_department_history" ADD CONSTRAINT "employee_department_history_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("effectiveFrom", "effectiveTo", '[]') WITH &&);
ALTER TABLE "employee_department_history" ADD CONSTRAINT "employee_department_history_dates_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("effectiveFrom", "effectiveTo", '[]') WITH &&);
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_dates_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

ALTER TABLE "schedule_shifts" ADD CONSTRAINT "schedule_shifts_times_chk" CHECK ("endAt" > "startAt");
ALTER TABLE "schedule_shifts" ADD CONSTRAINT "schedule_shifts_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, tstzrange("startAt", "endAt", '[)') WITH &&);

-- السياسة العامة (employeeId = NULL) تُعامل كموظف وهمي واحد حتى لا تتداخل فتراتها أيضًا
ALTER TABLE "overtime_policies" ADD CONSTRAINT "overtime_policies_no_overlap"
  EXCLUDE USING gist (
    (COALESCE("employeeId", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange("effectiveFrom", "effectiveTo", '[]') WITH &&
  );
ALTER TABLE "overtime_policies" ADD CONSTRAINT "overtime_policies_dates_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");
ALTER TABLE "overtime_policies" ADD CONSTRAINT "overtime_policies_values_chk"
  CHECK ("multiplier" > 0 AND ("specialHourlyRate" IS NULL OR "specialHourlyRate" >= 0));

-- ───────────── الدوام ─────────────

-- لا تتداخل ورديات الموظف نفسه. الوردية المفتوحة تمتد إلى ما لا نهاية حتى تُغلق،
-- فلا يمكن تسجيل حضور جديد قبل الانصراف. الورديات الملغاة مستثناة.
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_no_overlap"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    tstzrange("checkInAt", COALESCE("checkOutAt", 'infinity'::timestamptz), '[)') WITH &&
  ) WHERE ("status" <> 'VOIDED');
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_times_chk"
  CHECK ("checkOutAt" IS NULL OR "checkOutAt" > "checkInAt");
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_status_chk"
  CHECK (
    ("status" = 'OPEN' AND "checkOutAt" IS NULL)
    OR ("status" = 'CLOSED' AND "checkOutAt" IS NOT NULL)
    OR "status" = 'VOIDED'
  );
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_worked_minutes_chk"
  CHECK ("workedMinutes" IS NULL OR "workedMinutes" >= 0);

ALTER TABLE "work_breaks" ADD CONSTRAINT "work_breaks_times_chk"
  CHECK ("endAt" IS NULL OR "endAt" > "startAt");

ALTER TABLE "leave_records" ADD CONSTRAINT "leave_records_dates_chk" CHECK ("endDate" >= "startDate");
-- لا تتداخل إجازات/غيابات الموظف القائمة (المرفوضة والملغاة مستثناة)
ALTER TABLE "leave_records" ADD CONSTRAINT "leave_records_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("startDate", "endDate", '[]') WITH &&)
  WHERE ("status" IN ('PENDING', 'APPROVED'));

ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_values_chk"
  CHECK ("minutes" > 0 AND "multiplier" > 0);

-- ───────────── الرواتب ─────────────

ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_dates_chk" CHECK ("endDate" >= "startDate");

-- لا تتداخل فترات الرواتب للموظف نفسه (يمنع احتساب المستحق مرتين)
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_no_overlap"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("periodStart", "periodEnd", '[]') WITH &&);
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_dates_chk" CHECK ("periodEnd" >= "periodStart");
-- المدفوع لا يكون سالبًا ولا يتجاوز الصافي المستحق
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_paid_chk"
  CHECK ("paidAmount" >= 0 AND "paidAmount" <= GREATEST("netAmount", 0));

ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_amount_chk" CHECK ("amount" <> 0);

-- ───────────── العمليات المالية ─────────────

ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_amount_chk" CHECK ("amount" > 0);
-- العملية العكسية يجب أن تشير إلى أصلها، وغير العكسية لا تشير
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_reversal_chk"
  CHECK (("type" = 'REVERSAL') = ("reversesId" IS NOT NULL));

ALTER TABLE "advance_accounts" ADD CONSTRAINT "advance_accounts_balance_chk"
  CHECK ("principalAmount" > 0 AND "remainingBalance" >= 0 AND "remainingBalance" <= "principalAmount");
ALTER TABLE "debt_accounts" ADD CONSTRAINT "debt_accounts_balance_chk"
  CHECK ("principalAmount" > 0 AND "remainingBalance" >= 0 AND "remainingBalance" <= "principalAmount");
ALTER TABLE "debt_movements" ADD CONSTRAINT "debt_movements_values_chk"
  CHECK ("amount" > 0 AND "balanceAfter" >= 0);

ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_amount_chk" CHECK ("amount" > 0);
-- كل توزيع يرتبط بالتزام أصلي واحد بالضبط، مطابق لنوعه
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_target_chk"
  CHECK (
    num_nonnulls("payrollEntryId", "advanceAccountId", "debtAccountId", "adjustmentId") = 1
    AND (
      ("targetType" = 'PAYROLL_ENTRY' AND "payrollEntryId" IS NOT NULL)
      OR ("targetType" = 'ADVANCE' AND "advanceAccountId" IS NOT NULL)
      OR ("targetType" = 'DEBT' AND "debtAccountId" IS NOT NULL)
      OR ("targetType" = 'ADJUSTMENT' AND "adjustmentId" IS NOT NULL)
    )
  );

-- ───────────── سجلات للإضافة فقط ─────────────

CREATE OR REPLACE FUNCTION aq_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'السجلات في % للإضافة فقط ولا يمكن تعديلها أو حذفها', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- سجل التدقيق: لا تعديل ولا حذف
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION aq_forbid_change();

-- حركات الديون وتوزيعات التسويات وسجل تصحيحات الدوام: لا تعديل ولا حذف
CREATE TRIGGER debt_movements_append_only
  BEFORE UPDATE OR DELETE ON "debt_movements"
  FOR EACH ROW EXECUTE FUNCTION aq_forbid_change();
CREATE TRIGGER settlement_allocations_append_only
  BEFORE UPDATE OR DELETE ON "settlement_allocations"
  FOR EACH ROW EXECUTE FUNCTION aq_forbid_change();
CREATE TRIGGER attendance_corrections_append_only
  BEFORE UPDATE OR DELETE ON "attendance_corrections"
  FOR EACH ROW EXECUTE FUNCTION aq_forbid_change();

-- العمليات المالية: لا تُحذف، ولا يتغير فيها شيء سوى الحالة POSTED → REVERSED
-- (والتصحيح يكون بعملية عكسية جديدة تشير إلى الأصل).
CREATE OR REPLACE FUNCTION aq_protect_financial_transaction() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'لا يمكن حذف العمليات المالية؛ استخدم عملية عكسية'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'لا يمكن تعديل عملية مالية مسجلة؛ استخدم عملية عكسية ثم عملية صحيحة'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED') THEN
    RAISE EXCEPTION 'تغيير حالة العملية المالية غير مسموح'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER financial_transactions_protect
  BEFORE UPDATE OR DELETE ON "financial_transactions"
  FOR EACH ROW EXECUTE FUNCTION aq_protect_financial_transaction();

-- ───────────── حماية الفترات المغلقة ─────────────

-- الفترة المغلقة لا يُعاد فتحها ولا تتغير تواريخها ولا تُحذف
CREATE OR REPLACE FUNCTION aq_protect_closed_period() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'فترة الرواتب مغلقة ولا يمكن تعديلها أو حذفها؛ عالج الفروقات بتسوية في فترة مفتوحة'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_periods_protect_closed
  BEFORE UPDATE OR DELETE ON "payroll_periods"
  FOR EACH ROW EXECUTE FUNCTION aq_protect_closed_period();

-- مستحقات الفترة المغلقة: يُسمح فقط بتغيير paidAmount (تسجيل الدفعات المرتبطة بالفترة)
CREATE OR REPLACE FUNCTION aq_protect_closed_entry() RETURNS trigger AS $$
DECLARE
  period_status "PayrollPeriodStatus";
BEGIN
  SELECT "status" INTO period_status FROM "payroll_periods" WHERE "id" = OLD."periodId";
  IF period_status = 'CLOSED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'لا يمكن حذف مستحق من فترة رواتب مغلقة' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (to_jsonb(NEW) - 'paidAmount' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'paidAmount' - 'updatedAt') THEN
      RAISE EXCEPTION 'لا يمكن تعديل مستحق في فترة رواتب مغلقة' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_entries_protect_closed
  BEFORE UPDATE OR DELETE ON "payroll_entries"
  FOR EACH ROW EXECUTE FUNCTION aq_protect_closed_entry();

-- بنود مستحق في فترة مغلقة: لا إضافة ولا تعديل ولا حذف
CREATE OR REPLACE FUNCTION aq_protect_closed_component() RETURNS trigger AS $$
DECLARE
  period_status "PayrollPeriodStatus";
  target_entry uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN target_entry := NEW."entryId"; ELSE target_entry := OLD."entryId"; END IF;
  SELECT p."status" INTO period_status
    FROM "payroll_entries" e JOIN "payroll_periods" p ON p."id" = e."periodId"
    WHERE e."id" = target_entry;
  IF period_status = 'CLOSED' THEN
    RAISE EXCEPTION 'لا يمكن تغيير بنود مستحق في فترة رواتب مغلقة' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payroll_entry_components_protect_closed
  BEFORE INSERT OR UPDATE OR DELETE ON "payroll_entry_components"
  FOR EACH ROW EXECUTE FUNCTION aq_protect_closed_component();
