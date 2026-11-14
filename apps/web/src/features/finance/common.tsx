'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Input, Modal, Select } from '@abu-qamar/ui';
import { can } from '@abu-qamar/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

export const frequencies = { WEEKLY: 'أسبوعية', SEMI_MONTHLY: 'نصف شهرية', MONTHLY: 'شهرية' };
export const statuses = { DRAFT: 'مسودة', IN_REVIEW: 'قيد المراجعة', READY_FOR_APPROVAL: 'جاهزة للاعتماد', CLOSED: 'مغلقة' };
export const ledgerLinks = {
  advances: 'السلف', debts: 'الديون', settlements: 'التسويات', 'financial-transactions': 'سجل العمليات',
  adjustments: 'تعديلات الرواتب',
};
export const methods = { CASH: 'نقدي', BANK_TRANSFER: 'تحويل بنكي', E_WALLET: 'محفظة إلكترونية' };

export type EmployeeSummary = { id: string; code: string; fullName: string };
export type Period = {
  id: string; label: string; startDate: string; endDate: string;
  frequency: keyof typeof frequencies; status: keyof typeof statuses; _count?: { entries: number };
};
export type Entry = {
  id: string; employee: EmployeeSummary; netAmount: string; grossAmount: string; deductionsAmount: string; paidAmount: string;
  snapshot?: { needsRefresh?: boolean } | null;
  components: { id: string; description: string; amount: string; workDate: string | null }[];
};
export type PeriodDetail = Period & { entries: Entry[] };
export type Blocker = { code: string; employeeId?: string; employeeName?: string; recordId?: string; message: string };
export type PageResult<T> = { items: T[]; page: number; totalPages: number; total: number };

export function FinanceAccess({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return can(user, 'finance.view') ? <>{children}</> : <Alert>ليست لديك صلاحية عرض المعلومات المالية</Alert>;
}

export function FinanceLinks() {
  return <details className="mb-5 rounded-lg border border-line bg-surface p-3">
    <summary className="cursor-pointer text-sm font-semibold">الحسابات المالية</summary>
    <nav aria-label="الحسابات المالية" className="mt-3 flex flex-wrap gap-2">
    <Link className="rounded-lg border border-line px-3 py-2 text-sm" href="/payroll">فترات الرواتب</Link>
    {Object.entries(ledgerLinks).map(([key, label]) =>
      <Link key={key} className="rounded-lg border border-line px-3 py-2 text-sm" href={`/payroll/accounts/${key}`}>{label}</Link>)}
    </nav>
  </details>;
}

export function useFinanceData<T>(path: string | null) {
  const [result, setResult] = useState<{ path: string; data: T } | null>(null);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    if (!path) return;
    setError('');
    api.get<T>(path).then((value) => {
      if (current) setResult({ path, data: value });
    }).catch((cause) => {
      if (current) setError(errorMessage(cause));
    });
    return () => { current = false; };
  }, [path, generation]);
  return { data: result?.path === path ? result.data : null, error, reload };
}

export function financialPost<T>(path: string, body?: unknown, idempotencyKey?: string) {
  if (!navigator.onLine) throw new ApiError(0, 'NETWORK', 'تتطلب العمليات المالية اتصالًا بالخادم');
  return api.post<T>(path, body, { idempotencyKey });
}

export function ActionForm<T = unknown>({ title, path, idempotent = false, children, onClose, onSaved, transform }: {
  title: string; path: string; idempotent?: boolean; children: ReactNode;
  onClose: () => void; onSaved: (result: T) => void;
  transform?: (body: Record<string, string>) => unknown;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ key: string; body: string } | null>(null);

  return <Modal open title={title} onClose={() => { if (!busy) onClose(); }}>
    <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      const fields = Object.fromEntries(Array.from(new FormData(event.currentTarget))
        .filter(([, value]) => value !== '')) as Record<string, string>;
      if (fields.occurredAt) fields.occurredAt = new Date(fields.occurredAt).toISOString();
      const body = transform ? transform(fields) : fields;
      const serialized = JSON.stringify(body);
      if (idempotent && attempt.current?.body !== serialized) {
        attempt.current = { key: crypto.randomUUID(), body: serialized };
      }
      setBusy(true);
      setError('');
      try {
        const result = await financialPost<T>(path, body, attempt.current?.key);
        onSaved(result);
        onClose();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    }}>
      {error && <Alert>{error}</Alert>}
      {children}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy}>تأكيد</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>إلغاء</Button>
      </div>
    </form>
  </Modal>;
}

export function MoneyFields({ cash = false, signed = false, defaultAmount }: { cash?: boolean; signed?: boolean; defaultAmount?: string }) {
  return <>
    <Input label="المبلغ" name="amount" required type="text" inputMode="decimal" dir="ltr" defaultValue={defaultAmount}
      pattern={signed ? '-?[0-9]{1,10}(\\.[0-9]{1,2})?' : '[0-9]{1,10}(\\.[0-9]{1,2})?'} />
    {cash && <>
      <Select label="طريقة الدفع" name="method" required>
        {Object.entries(methods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
      <Input label="وقت الدفع (اختياري، بتوقيت جهازك)" name="occurredAt" type="datetime-local" dir="ltr" />
      <Input label="اسم المستلم" name="receivedBy" required maxLength={150} />
      <Input label="المرجع أو رقم الإيصال" name="reference" required maxLength={100} />
    </>}
  </>;
}
