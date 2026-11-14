'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Select } from '@abu-qamar/ui';
import { PageHeader, Pagination } from '@/components/page';
import { api, errorMessage, toQuery } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useSettings } from '@/hooks/use-settings';
import { useAuth } from '@/providers/auth-provider';
import { ActionForm, FinanceAccess, FinanceLinks, frequencies, statuses, useFinanceData, type PageResult, type Period } from '@/features/finance/common';

function Periods() {
  const { user } = useAuth();
  const currency = useSettings()['general.currency'];
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [create, setCreate] = useState(false);
  const [prepareError, setPrepareError] = useState('');
  const { data, error, reload } = useFinanceData<PageResult<Period>>(`/payroll/periods${toQuery({ page, status })}`);
  const admin = user?.role === 'ADMIN';
  useEffect(() => {
    if (!admin || !navigator.onLine) return;
    let active = true;
    void api.post('/payroll/periods/prepare-current').then(() => { if (active) reload(); })
      .catch(error => { if (active) setPrepareError(errorMessage(error)); });
    return () => { active = false; };
  }, [admin, reload]);
  return <>
    <PageHeader title="فترات الرواتب" actions={admin && <Button variant="secondary" onClick={() => setCreate(true)}>إنشاء فترة مخصصة</Button>} />
    <FinanceLinks />
    <div className="mb-4 max-w-xs">
      <Select label="الحالة" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
        <option value="">كل الحالات</option>
        {Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
    </div>
    {(error || prepareError) && <Alert>{error || prepareError}</Alert>}
    {!data && !error && <p className="text-muted">جارٍ تحميل الفترات…</p>}
    {data && <Card>
      {data.items.length === 0 && <p className="p-4 text-muted">لا توجد فترات رواتب</p>}
      {data.items.map((period) => <Link key={period.id} href={`/payroll/${period.id}`}
        className="flex flex-wrap justify-between gap-3 border-b border-line p-4 hover:bg-surface-alt">
        <div><p className="font-semibold">{period.label}</p>
          <p className="mt-1 text-sm text-muted">{formatDate(period.startDate, 'UTC')} — {formatDate(period.endDate, 'UTC')}</p></div>
        <p className="text-sm">{frequencies[period.frequency]} · {statuses[period.status]} · {period._count?.entries ?? 0} مستحق</p>
        {period.payout && <p className="text-sm font-semibold">جاهزة للصرف · {period.payout.employees} موظف · {formatMoney(period.payout.remaining, currency)}</p>}
      </Link>)}
      <Pagination {...data} onChange={setPage} />
    </Card>}
    {create && <ActionForm title="إنشاء فترة رواتب" path="/payroll/periods" onSaved={() => { setPage(1); reload(); }} onClose={() => setCreate(false)}>
      <Select label="تكرار الصرف" name="frequency" defaultValue="MONTHLY">
        {Object.entries(frequencies).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </Select>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="من تاريخ" name="from" type="date" required />
        <Input label="إلى تاريخ" name="to" type="date" required />
      </div>
    </ActionForm>}
  </>;
}

export default function PayrollPage() {
  return <FinanceAccess><Periods /></FinanceAccess>;
}
