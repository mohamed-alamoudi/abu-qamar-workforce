-- An explicit audited reopen may return an unpaid period to draft.
CREATE OR REPLACE FUNCTION aq_protect_closed_period() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CLOSED' THEN
    IF TG_OP = 'UPDATE'
      AND NEW."status" = 'DRAFT'
      AND current_setting('aq.reopen_period', true) = OLD."id"::text
      AND NEW."approvedById" IS NULL AND NEW."approvedAt" IS NULL
      AND NEW."closedById" IS NULL AND NEW."closedAt" IS NULL
      AND (to_jsonb(NEW) - ARRAY['status','approvedById','approvedAt','closedById','closedAt','updatedAt'])
        = (to_jsonb(OLD) - ARRAY['status','approvedById','approvedAt','closedById','closedAt','updatedAt'])
      AND NOT EXISTS (
        SELECT 1
        FROM payroll_entries e
        WHERE e."periodId" = OLD.id AND (
          e."paidAmount" <> 0
          OR EXISTS (SELECT 1 FROM financial_transactions t WHERE t."payrollEntryId" = e.id)
          OR EXISTS (SELECT 1 FROM settlement_allocations a WHERE a."payrollEntryId" = e.id)
          OR EXISTS (SELECT 1 FROM payroll_adjustments a WHERE a."targetEntryId" = e.id)
        )
      )
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'فترة الرواتب مغلقة ولا يمكن تغييرها مباشرة'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
