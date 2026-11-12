'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, Input, Select } from '@abu-qamar/ui';
import { PageHeader, Pagination } from '@/components/page';
import { ActionForm, FinanceAccess, FinanceLinks, MoneyFields, ledgerLinks, methods, useFinanceData, type EmployeeSummary, type PageResult } from '@/features/finance/common';
import { useSettings } from '@/hooks/use-settings';
import { toQuery } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useAuth } from '@/providers/auth-provider';

type Kind = keyof typeof ledgerLinks;
type Row = {
  id: string; employeeId: string; employee?: EmployeeSummary; type?: string; status: string;
  amount?: string; principalAmount?: string; remainingBalance?: string;
  occurredAt?: string; incurredAt?: string; disbursedAt?: string; createdAt?: string;
  reason?: string; note?: string; correctionReason?: string; reference?: string; receivedBy?: string;
  method?: keyof typeof methods;
};
const transactionTypes: Record<string, string> = {
  SALARY_PAYMENT: 'دفعة راتب', ADVANCE_DISBURSEMENT: 'صرف سلفة', ADVANCE_REPAYMENT: 'سداد سلفة',
  DEBT_REPAYMENT: 'سداد دين', SETTLEMENT: 'تسوية', REFUND: 'استرداد', REVERSAL: 'عكس عملية',
  BONUS: 'مكافأة', DEDUCTION: 'خصم', WAGE_DIFFERENCE: 'فرق راتب',
};
const ledgerStatuses: Record<string, string> = {
  OPEN: 'قائم', SETTLED: 'مسدد', CANCELLED: 'ملغى', POSTED: 'مسجل', REVERSED: 'معكوس',
  PENDING: 'بانتظار الاعتماد', APPROVED: 'معتمد', APPLIED: 'مطبق',
};
type Action = { type: 'create' } | { type: 'repay' | 'approve' | 'cancel'; id: string } | { type: 'reverse'; id: string; canRecover: boolean };

function EmployeeFields({ onSelect }: { onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const { data, error } = useFinanceData<PageResult<EmployeeSummary>>(`/employees${toQuery({ search, pageSize: 50 })}`);
  return <>
    <Input label="بحث عن موظف بالاسم أو الكود" value={search} onChange={(event) => setSearch(event.target.value)} />
    {error && <Alert>{error}</Alert>}
    <Select label="الموظف" name="employeeId" defaultValue="" required onChange={(event) => onSelect(event.target.value)}>
      <option value="" disabled>اختر موظفًا</option>
      {data?.items.map((employee) => <option key={employee.id} value={employee.id}>{employee.fullName} · {employee.code}</option>)}
    </Select>
  </>;
}

function CreateOperation({ kind, currency, onClose, onSaved }: { kind: Kind; currency: string; onClose: () => void; onSaved: () => void }) {
  const [employeeId, setEmployeeId] = useState('');
  const [target, setTarget] = useState<'ADVANCE' | 'DEBT'>('ADVANCE');
  const [adjustment, setAdjustment] = useState('BONUS');
  const needsEntries = kind === 'settlements' || (kind === 'adjustments' && adjustment === 'WAGE_DIFFERENCE');
  const balances = useFinanceData<{ entries: { id: string; period: { label: string }; outstanding: string }[] }>(
    employeeId && needsEntries ? `/employees/${employeeId}/financial-balances` : null,
  );
  const obligations = useFinanceData<PageResult<Row>>(employeeId && kind === 'settlements'
    ? `/${target === 'ADVANCE' ? 'advances' : 'debts'}?employeeId=${employeeId}&pageSize=100` : null);
  const title = { advances: 'صرف سلفة', debts: 'تسجيل دين', settlements: 'تسوية مستحق راتب',
    adjustments: 'إنشاء تعديل راتب', 'financial-transactions': 'تسجيل عملية' }[kind];
  const transform = (fields: Record<string, string>) => {
    if (kind === 'settlements') {
      const { employeeId: _employee, ...rest } = fields;
      return rest;
    }
    return fields;
  };
  return <ActionForm title={title} path={kind === 'adjustments' ? '/payroll/adjustments' : `/${kind}`}
    idempotent={kind === 'advances' || kind === 'settlements'} transform={transform} onClose={onClose} onSaved={onSaved}>
    <EmployeeFields onSelect={setEmployeeId} />
    {kind === 'adjustments' && <Select label="نوع التعديل" name="type" value={adjustment}
      onChange={(event) => setAdjustment(event.target.value)}>
      <option value="BONUS">مكافأة</option><option value="DEDUCTION">خصم</option><option value="WAGE_DIFFERENCE">فرق راتب</option>
    </Select>}
    {needsEntries && <>
      {balances.error && <Alert>{balances.error}</Alert>}
      <Select key={employeeId} name={kind === 'settlements' ? 'payrollEntryId' : 'targetEntryId'} defaultValue=""
        label="المستحق من فترة مغلقة" required>
        <option value="" disabled>اختر المستحق</option>
        {employeeId && balances.data?.entries.filter((entry) => kind !== 'settlements' || Number(entry.outstanding) > 0).map((entry) =>
          <option key={entry.id} value={entry.id}>{entry.period.label} · {formatMoney(entry.outstanding, currency)}</option>)}
      </Select>
    </>}
    {kind === 'settlements' && <>
      <Select label="نوع الالتزام" name="targetType" value={target}
        onChange={(event) => setTarget(event.target.value as 'ADVANCE' | 'DEBT')}>
        <option value="ADVANCE">سلفة</option><option value="DEBT">دين</option>
      </Select>
      {obligations.error && <Alert>{obligations.error}</Alert>}
      <Select key={`${employeeId}-${target}`} label="الالتزام الأصلي" name="targetId" defaultValue="" required>
        <option value="" disabled>اختر الالتزام</option>
        {employeeId && obligations.data?.items.filter((row) => row.status === 'OPEN').map((row) =>
          <option key={row.id} value={row.id}>{formatMoney(row.remainingBalance ?? '0', currency)} · {formatDateTime(row.disbursedAt ?? row.incurredAt)} · {row.reason ?? row.note}</option>)}
      </Select>
    </>}
    <MoneyFields cash={kind === 'advances'} signed={kind === 'adjustments' && adjustment === 'WAGE_DIFFERENCE'} />
    {kind !== 'advances' && <Input label="السبب" name="reason" required={kind !== 'debts'} minLength={kind !== 'debts' ? 2 : undefined} maxLength={kind === 'adjustments' ? 230 : 255} />}
  </ActionForm>;
}

function Accounts({ kind }: { kind: Kind }) {
  const { user } = useAuth();
  const settings = useSettings();
  const currency = settings['general.currency'];
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<Action | null>(null);
  const admin = user?.role === 'ADMIN';
  const path = kind === 'adjustments' ? '/payroll/adjustments' : `/${kind}`;
  const { data, error, reload } = useFinanceData<PageResult<Row>>(`${path}?page=${page}`);
  const close = () => setAction(null);
  return <>
    <PageHeader title={ledgerLinks[kind]} actions={admin && kind !== 'financial-transactions' &&
      <Button onClick={() => setAction({ type: 'create' })}>إضافة</Button>} />
    <FinanceLinks />
    {error && <Alert>{error}</Alert>}
    {!error && !data && <p className="text-muted">جارٍ التحميل…</p>}
    {data && <Card>
      {!data.items.length && <p className="p-4 text-muted">لا توجد سجلات</p>}
      {data.items.map((row) => <article key={row.id} className="flex flex-wrap justify-between gap-3 border-b border-line p-4 text-sm">
        <div className="space-y-1">
          <h2 className="font-bold">{row.employee?.fullName} {row.type && transactionTypes[row.type]}</h2>
          <p>{formatMoney(row.amount ?? row.principalAmount ?? '0', currency)} · {ledgerStatuses[row.status]}</p>
          {row.remainingBalance != null && <p>الرصيد المتبقي {formatMoney(row.remainingBalance, currency)}</p>}
          <p className="text-muted">{formatDateTime(row.occurredAt ?? row.disbursedAt ?? row.incurredAt ?? row.createdAt, settings['general.timezone'])}</p>
          <p>{row.reason ?? row.note ?? row.correctionReason}</p>
          {row.method && <p>{methods[row.method]} · {row.receivedBy} · {row.reference}</p>}
        </div>
        {admin && <div className="flex flex-wrap items-start gap-2">
          {row.status === 'OPEN' && <Button size="sm" variant="secondary" onClick={() => setAction({ type: 'repay', id: row.id })}>تسجيل سداد</Button>}
          {kind === 'financial-transactions' && row.status === 'POSTED' && row.type !== 'REVERSAL' && row.type !== 'REFUND' &&
            <Button size="sm" variant="secondary" onClick={() => setAction({ type: 'reverse', id: row.id, canRecover: row.type === 'SALARY_PAYMENT' || row.type === 'ADVANCE_DISBURSEMENT' })}>عكس العملية</Button>}
          {kind === 'adjustments' && row.status === 'PENDING' &&
            <Button size="sm" onClick={() => setAction({ type: 'approve', id: row.id })}>اعتماد</Button>}
          {kind === 'adjustments' && (row.status === 'PENDING' || row.status === 'APPROVED') &&
            <Button size="sm" variant="secondary" onClick={() => setAction({ type: 'cancel', id: row.id })}>إلغاء التعديل</Button>}
        </div>}
      </article>)}
      <Pagination {...data} onChange={setPage} />
    </Card>}
    {action?.type === 'create' && <CreateOperation kind={kind} currency={currency} onClose={close} onSaved={reload} />}
    {action?.type === 'repay' && <ActionForm title="تسجيل سداد" path={`${path}/${action.id}/repay`} idempotent onClose={close} onSaved={reload}>
      <MoneyFields cash />
    </ActionForm>}
    {action?.type === 'reverse' && <ActionForm title="عكس العملية المالية" path={`${path}/${action.id}/reverse`} idempotent onClose={close} onSaved={reload}>
      <p>سيُضاف قيد عكسي مرتبط بالعملية الأصلية وتُعاد الأرصدة.</p>
      <Input name="reason" label="سبب العكس" required minLength={2} maxLength={255} />
      {action.canRecover && <Input name="recoverableAmount" label="المبلغ الذي استلمه الموظف ولم يُعِده (اختياري)"
        inputMode="decimal" dir="ltr" pattern={'[0-9]{1,10}(\\.[0-9]{1,2})?'} />}
    </ActionForm>}
    {action && (action.type === 'approve' || action.type === 'cancel') && <ActionForm
      title={action.type === 'approve' ? 'اعتماد تعديل الراتب' : 'إلغاء تعديل الراتب'} path={`${path}/${action.id}/${action.type}`}
      onClose={close} onSaved={reload}>
      <p>{action.type === 'approve' ? 'سيُطبّق التعديل عند حساب فترة مفتوحة مؤهلة للموظف.' : 'سيُسجّل إلغاء التعديل.'}</p>
    </ActionForm>}
  </>;
}

export default function LedgerPage() {
  const { kind } = useParams<{ kind: string }>();
  return <FinanceAccess>{Object.hasOwn(ledgerLinks, kind)
    ? <Accounts key={kind} kind={kind as Kind} />
    : <Alert>صفحة الحساب المطلوبة غير موجودة</Alert>}</FinanceAccess>;
}
