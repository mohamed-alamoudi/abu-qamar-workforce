'use client';

import { Lock } from 'lucide-react';
import { Badge } from '@abu-qamar/ui';
import { formatMoney } from '@/lib/format';
import type { Employee } from '@/lib/types';
import { PAY_UNIT_LABELS } from './pay';

export function EmployeeStatusBadge({ status }: { status: Employee['status'] }) {
  return status === 'ACTIVE' ? <Badge tone="success">نشط</Badge> : <Badge tone="danger">متوقف</Badge>;
}

/** الأجر الحالي: «محجوب» لمن لا يملك الصلاحية المالية، وتنبيه إن لم يُحدَّد بعد. */
export function PayCell({ employee, currency }: { employee: Employee; currency: string }) {
  if (!employee.payVisible) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted">
        <Lock className="size-3.5" />
        محجوب
      </span>
    );
  }
  if (!employee.currentPay) return <Badge tone="warning">لم يُحدَّد الأجر</Badge>;
  return (
    <span className="tabular">
      {formatMoney(employee.currentPay.amount, currency)}{' '}
      <span className="text-xs text-muted">{PAY_UNIT_LABELS[employee.currentPay.payType]}</span>
    </span>
  );
}
