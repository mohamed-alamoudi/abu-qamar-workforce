'use client';

import { Alert, Card } from '@abu-qamar/ui';
import Link from 'next/link';
import { formatMoney } from '@/lib/format';
import { useFinanceData } from './common';

type Balances = {
  provisional: string;
  gross: string; net: string; paid: string; settled: string; outstanding: string; advances: string; debts: string;
  entries: { id: string; periodId: string; period: { label: string }; outstanding: string }[];
};

const labels = {
  provisional: 'مستحق مبدئي للفترات المفتوحة',
  gross: 'إجمالي الأجور', net: 'صافي المستحق', paid: 'المدفوع', settled: 'المسوّى',
  outstanding: 'المتبقي للصرف', advances: 'السلف القائمة', debts: 'الديون القائمة',
} as const;

export function EmployeeBalances({ employeeId, currency }: { employeeId: string; currency: string }) {
  const { data, error } = useFinanceData<Balances>(`/employees/${employeeId}/financial-balances`);
  if (error) return <Alert>{error}</Alert>;
  return <Card className="space-y-4 p-5">
    <h2 className="font-semibold">الأرصدة المالية</h2>
    {!data ? <p className="text-sm text-muted">جارٍ تحميل الأرصدة…</p> : <>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => <div key={key}>
          <dt className="text-sm text-muted">{labels[key]}</dt><dd className="font-semibold">{formatMoney(data[key], currency)}</dd>
        </div>)}
      </dl>
      <h3 className="text-sm font-semibold">المستحقات المتبقية بحسب الفترة الأصلية</h3>
      {!data.entries.some((entry) => Number(entry.outstanding) > 0) && <p className="text-sm text-muted">لا توجد مستحقات متبقية</p>}
      <ul className="divide-y divide-line text-sm">
        {data.entries.filter((entry) => Number(entry.outstanding) > 0).map((entry) => <li key={entry.id} className="py-2">
          <Link href={`/payroll/${entry.periodId}`} className="flex flex-wrap justify-between gap-2 underline">
            <span>{entry.period.label}</span><span>{formatMoney(entry.outstanding, currency)}</span>
          </Link>
        </li>)}
      </ul>
    </>}
  </Card>;
}
