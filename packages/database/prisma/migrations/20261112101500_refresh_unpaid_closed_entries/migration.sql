CREATE FUNCTION aq_unlinked_payroll_entry(entry_id uuid) RETURNS boolean AS $$
  SELECT NOT EXISTS (SELECT 1 FROM financial_transactions WHERE "payrollEntryId" = entry_id)
    AND NOT EXISTS (SELECT 1 FROM settlement_allocations WHERE "payrollEntryId" = entry_id)
    AND NOT EXISTS (SELECT 1 FROM payroll_adjustments WHERE "targetEntryId" = entry_id);
$$ LANGUAGE sql VOLATILE;

CREATE OR REPLACE FUNCTION aq_protect_closed_entry() RETURNS trigger AS $$
DECLARE
  period_status "PayrollPeriodStatus";
  prior_snapshot jsonb;
BEGIN
  SELECT "status" INTO period_status FROM payroll_periods WHERE id = OLD."periodId";
  IF period_status = 'CLOSED' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'لا يمكن حذف مستحق في فترة رواتب مغلقة' USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."paidAmount" = 0 AND NEW."paidAmount" = 0 AND aq_unlinked_payroll_entry(OLD.id) THEN
      IF current_setting('aq.refresh_payroll_entry', true) = OLD.id::text
        AND (to_jsonb(NEW) - ARRAY['grossAmount','deductionsAmount','netAmount','snapshot','updatedAt'])
          = (to_jsonb(OLD) - ARRAY['grossAmount','deductionsAmount','netAmount','snapshot','updatedAt'])
      THEN
        RETURN NEW;
      END IF;
      prior_snapshot := CASE WHEN jsonb_typeof(OLD.snapshot) = 'object' THEN OLD.snapshot ELSE '{}'::jsonb END;
      IF current_setting('aq.flag_payroll_entry', true) = OLD.id::text
        AND NEW.snapshot = (prior_snapshot || '{"needsRefresh":true}'::jsonb)
        AND (to_jsonb(NEW) - ARRAY['snapshot','updatedAt']) = (to_jsonb(OLD) - ARRAY['snapshot','updatedAt'])
      THEN
        RETURN NEW;
      END IF;
    END IF;

    IF (to_jsonb(NEW) - ARRAY['paidAmount','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['paidAmount','updatedAt'])
      OR (OLD.snapshot->'needsRefresh' = 'true'::jsonb AND NEW."paidAmount" IS DISTINCT FROM OLD."paidAmount")
    THEN
      RAISE EXCEPTION 'المستحق المغلق محمي أو يحتاج إلى تحديث قبل الصرف' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION aq_protect_closed_component() RETURNS trigger AS $$
DECLARE
  target_entry uuid;
  period_status "PayrollPeriodStatus";
  paid numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN target_entry := NEW."entryId"; ELSE target_entry := OLD."entryId"; END IF;
  IF TG_OP = 'UPDATE' AND NEW."entryId" IS DISTINCT FROM OLD."entryId" AND EXISTS (
    SELECT 1 FROM payroll_entries e JOIN payroll_periods p ON p.id = e."periodId"
    WHERE e.id = NEW."entryId" AND p.status = 'CLOSED'
  ) THEN
    RAISE EXCEPTION 'لا يمكن نقل بند إلى مستحق مغلق' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT p.status, e."paidAmount" INTO period_status, paid
    FROM payroll_entries e JOIN payroll_periods p ON p.id = e."periodId"
    WHERE e.id = target_entry;
  IF period_status = 'CLOSED'
    AND NOT (current_setting('aq.refresh_payroll_entry', true) IS NOT DISTINCT FROM target_entry::text
      AND paid = 0 AND aq_unlinked_payroll_entry(target_entry))
  THEN
    RAISE EXCEPTION 'لا يمكن تغيير بنود مستحق في فترة رواتب مغلقة' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
