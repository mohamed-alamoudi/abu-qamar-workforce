'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, Input } from '@abu-qamar/ui';
import { PageHeader } from '@/components/page';
import { ActionForm, FinanceAccess, FinanceLinks, MoneyFields, financialPost, statuses, useFinanceData, type Blocker, type Entry, type PeriodDetail } from '@/features/finance/common';
import { useSettings } from '@/hooks/use-settings';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useAuth } from '@/providers/auth-provider';

type RefreshResult = { added: number; updated: number; protected: number; blockers: Blocker[] };

function Details({ id }: { id: string }) {
  const { user } = useAuth();
  const settings = useSettings();
  const currency = settings['general.currency'];
  const periodPath = `/payroll/periods/${id}`;
  const period = useFinanceData<PeriodDetail>(periodPath);
  const checklist = useFinanceData<{ blockers: Blocker[] }>(`${periodPath}/checklist`);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [payment, setPayment] = useState<Entry | null>(null);
  const [refreshClosed, setRefreshClosed] = useState(false);
  const [refreshResult, setRefreshResult] = useState<RefreshResult | null>(null);
  const [reopen, setReopen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Blocker[] | null>(null);
  const reload = () => { period.reload(); checklist.reload(); setIssues(null); };
  const run = async (action: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await financialPost<PeriodDetail & { blockers: Blocker[] }>(`${periodPath}/${action}`);
      reload();
      setIssues(result.blockers);
      setConfirmClose(false);
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError) {
        const detail = cause.details as { blockers?: Blocker[] } | undefined;
        if (detail?.blockers) setIssues(detail.blockers);
      }
    } finally {
      setBusy(false);
    }
  };

  const row = period.data;
  const admin = user?.role === 'ADMIN';
  const blockers = issues ?? checklist.data?.blockers;
  const search = employeeSearch.trim().toLowerCase();
  const entries = row?.entries.filter(entry => (entry.employee.fullName + ' ' + entry.employee.code).toLowerCase().includes(search)) ?? [];
  return <>
    <PageHeader title={row?.label ?? 'تفاصيل فترة الرواتب'}
      description={row && `${statuses[row.status]} · ${formatDate(row.startDate, 'UTC')} — ${formatDate(row.endDate, 'UTC')}` || undefined} />
    <FinanceLinks />
    {(error || period.error || checklist.error) && <Alert className="mb-4">{error || period.error || checklist.error}</Alert>}
    {row && row.status !== 'CLOSED' && <Card className="mb-5 space-y-3 p-4">
      <h2 className="font-bold">قائمة التحقق قبل الإغلاق</h2>
      {blockers === undefined ? <p className="text-muted">جارٍ فحص الفترة…</p> : blockers.length === 0
        ? <p>لا توجد موانع للإغلاق</p>
        : <ul className="list-inside list-disc space-y-1 text-sm">
          {blockers.map((item, index) => <li key={`${item.code}-${index}`}>
            {row.entries.find((entry) => entry.employee.id === item.employeeId)?.employee.fullName &&
              <strong>{row.entries.find((entry) => entry.employee.id === item.employeeId)?.employee.fullName} · </strong>}
            {item.message}
          </li>)}
        </ul>}
      {admin && <div className="flex flex-wrap gap-2">
        <Button disabled={busy} variant="secondary" onClick={() => run('calculate')}>حساب المستحقات</Button>
        {row.status === 'DRAFT' && <Button disabled={busy} onClick={() => run('review')}>بدء المراجعة</Button>}
        {row.status === 'IN_REVIEW' && <Button disabled={busy || blockers?.length !== 0} onClick={() => run('approve')}>اعتماد الحساب</Button>}
        {row.status === 'READY_FOR_APPROVAL' && <Button disabled={busy || blockers?.length !== 0} onClick={() => setConfirmClose(true)}>إغلاق الفترة</Button>}
      </div>}
    </Card>}
    {admin && row?.status === 'CLOSED' && <Card className="mb-5 space-y-2 p-4">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setRefreshClosed(true)}>تحديث المستحقات غير المصروفة</Button>
        <Button variant="secondary" onClick={() => setReopen(true)}>إعادة فتح الفترة</Button>
      </div>
      <p className="text-sm text-muted">التحديث يشمل الموظفين الجدد والمستحقات بلا دفعات أو تسويات مرتبطة. إعادة فتح الفترة بالكامل متاحة إذا لم تُسجَّل عليها حركات مالية.</p>
    </Card>}
    {refreshResult && row?.status === 'CLOSED' && <Card className="mb-5 space-y-2 p-4">
      <p role="status">أُضيف {refreshResult.added} مستحق · حُدّث {refreshResult.updated} · محفوظ كما هو بسبب ارتباط مالي: {refreshResult.protected}</p>
      {refreshResult.blockers.length > 0 && <>
        <p className="font-semibold">سجلات تحتاج مراجعة</p>
        <ul className="list-inside list-disc text-sm">{refreshResult.blockers.map((issue, i) =>
          <li key={i}>{issue.employeeName && issue.employeeName + ' · '}{issue.message}</li>)}</ul>
      </>}
    </Card>}
    {refreshClosed && <ActionForm<RefreshResult> title="تحديث المستحقات غير المصروفة" path={periodPath + '/refresh-unpaid'}
      onSaved={result => { reload(); setRefreshResult(result); }} onClose={() => setRefreshClosed(false)}>
      <p>تظل الفترة مغلقة. يضيف التحديث المستحقات الجديدة بعد اعتماد الدوام، ويعيد حساب المستحقات غير المصروفة ويحفظ الحساب السابق في سجل التدقيق.</p>
      <Input label="سبب التحديث" name="reason" required minLength={2} maxLength={255} />
    </ActionForm>}
    {reopen && <ActionForm title="إعادة فتح فترة الرواتب" path={periodPath + '/reopen'} onSaved={reload} onClose={() => setReopen(false)}>
      <p>تعود الفترة إلى مسودة ويُحفظ حسابها السابق في سجل التدقيق. بعد تصحيح الأجور والدوام احسب المستحقات من جديد.</p>
      <Input label="سبب إعادة الفتح" name="reason" required minLength={2} maxLength={255} />
    </ActionForm>}
    {!row && !period.error && <p className="text-muted">جارٍ تحميل الفترة…</p>}
    {row?.entries.length === 0 && <p className="text-muted">لا توجد مستحقات محسوبة</p>}
    {!!row?.entries.length && <div className="mb-3 max-w-md">
      <Input label="بحث عن موظف بالاسم أو الكود" value={employeeSearch} onChange={e => setEmployeeSearch(e.target.value)} />
      {!entries.length && <p className="mt-2 text-sm text-muted">لا يوجد موظف يطابق البحث في هذه الفترة.</p>}
    </div>}
    <div className="space-y-3">{row && entries.map((entry) => <Card className="p-4" key={entry.id}>
      <div className="flex flex-wrap justify-between gap-3">
        <h2 className="font-bold">{entry.employee.fullName} <span className="text-sm text-muted">{entry.employee.code}</span></h2>
        {admin && row.status === 'CLOSED' && !entry.snapshot?.needsRefresh && Number(entry.paidAmount) < Number(entry.netAmount) &&
          <Button size="sm" onClick={() => setPayment(entry)}>تسجيل دفعة</Button>}
      </div>
      {entry.snapshot?.needsRefresh && <p className="mt-2 text-sm text-danger-600">تغيّر الأجر. حدّث هذا المستحق قبل الصرف.</p>}
      <dl className="my-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {Object.entries({ 'الإجمالي': entry.grossAmount, 'الخصومات': entry.deductionsAmount, 'الصافي': entry.netAmount,
          'المسدّد بالدفعات والتسويات': entry.paidAmount }).map(([label, amount]) =>
          <div key={label}><dt className="text-muted">{label}</dt><dd>{formatMoney(amount, currency)}</dd></div>)}
      </dl>
      <details>
        <summary className="cursor-pointer text-sm font-semibold">تفاصيل البنود</summary>
        {entry.components.length === 0 && <p className="py-2 text-sm text-muted">لا توجد بنود لهذا المستحق</p>}
        <ul className="mt-2 divide-y divide-line text-sm">{entry.components.map((component) => <li key={component.id}
          className="flex flex-wrap justify-between gap-2 py-2">
          <span>{component.description}{component.workDate && ` · ${formatDate(component.workDate, 'UTC')}`}</span>
          <span>{formatMoney(component.amount, currency)}</span>
        </li>)}</ul>
      </details>
    </Card>)}</div>
    {payment && <ActionForm title={`دفعة راتب · ${payment.employee.fullName}`} path="/payments" idempotent
      onSaved={reload} onClose={() => setPayment(null)} transform={(body) => ({ ...body, payrollEntryId: payment.id })}>
      <MoneyFields cash />
    </ActionForm>}
    {confirmClose && <ActionForm title="تأكيد إغلاق فترة الرواتب" path={`${periodPath}/close`} onSaved={reload} onClose={() => setConfirmClose(false)}>
      <p>يُثبّت الإغلاق مبالغ الرواتب وبنودها. يمكن تسجيل الدفعات وتسوية المستحقات بعده.</p>
    </ActionForm>}
  </>;
}

export default function PeriodPage() {
  const { id } = useParams<{ id: string }>();
  return <FinanceAccess><Details key={id} id={id} /></FinanceAccess>;
}
