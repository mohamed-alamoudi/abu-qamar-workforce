'use client';

import { useState } from 'react';
import { Button, Card, Input } from '@abu-qamar/ui';
import { AdminOnlyPage, PageHeader } from '@/components/page';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { EmployeeSelect, Feedback, Submit, useMutation, useResource, type Employee } from '@/features/attendance/shared';

const labels: Record<string, string> = { DETECTED: 'مكتشف', PENDING_APPROVAL: 'بانتظار الاعتماد', APPROVED: 'معتمد', REJECTED: 'مرفوض' };
type Entry = { id: string; employee: { fullName: string }; workDate: string; minutes: number; status: string; multiplier: string; specialHourlyRate: string | null };
type Policy = { id: string; employeeId: string | null; effectiveFrom: string; effectiveTo: string | null; multiplier: string;
  dailyThresholdMinutes: number | null; weeklyThresholdMinutes: number | null; specialHourlyRate: string | null };
const numbers = [
  ['dailyThresholdMinutes', 'الحد اليومي بالدقائق', '1', '1440', '1'],
  ['weeklyThresholdMinutes', 'الحد الأسبوعي بالدقائق', '1', '10080', '1'],
  ['multiplier', 'المعامل', '0.001', '99.999', '0.001'],
  ['specialHourlyRate', 'سعر الساعة الخاص', '0', '9999999999.99', '0.01'],
] as const;

function Overtime() {
  const { revision, busy, feedback, run } = useMutation();
  const list = useResource<Entry[]>('/overtime', revision);
  const policies = useResource<Policy[]>('/overtime/policies', revision);
  const employees = useResource<Employee[]>('/attendance/employees');
  const [form, setForm] = useState({ employeeId: '', effectiveFrom: '', dailyThresholdMinutes: '', weeklyThresholdMinutes: '', multiplier: '', specialHourlyRate: '' });
  return <div className="space-y-4">
    <PageHeader title="العمل الإضافي" />
    <Feedback {...feedback} />
    <Card className="space-y-4 p-4">
      <h2 className="font-semibold">سياسات الإضافي</h2>
      <Feedback error={employees.error ?? policies.error} />
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => {
        event.preventDefault();
        void run(() => api.post('/overtime/policies', { employeeId: form.employeeId || undefined, effectiveFrom: form.effectiveFrom,
          ...Object.fromEntries(numbers.map(([key]) => [key, form[key] === '' ? undefined : Number(form[key])])) }));
      }}>
        <div><EmployeeSelect employees={employees.data ?? []} value={form.employeeId} onChange={employeeId => setForm({ ...form, employeeId })} />
          <p className="text-sm text-muted">اترك اختيار الموظف فارغًا للسياسة العامة.</p></div>
        <Input label="بداية السريان" type="date" required value={form.effectiveFrom} onChange={e => setForm({ ...form, effectiveFrom: e.target.value })} />
        {numbers.map(([key, label, min, max, step]) => <Input key={key} label={label} type="number" min={min} max={max} step={step}
          value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} />)}
        <div><Submit busy={busy}>حفظ السياسة</Submit></div>
      </form>
      {policies.data?.map(row => <article key={row.id} className="rounded-lg border border-line p-3 text-sm">
        <p className="font-semibold">{row.employeeId ? employees.data?.find(employee => employee.id === row.employeeId)?.fullName : 'السياسة العامة'}</p>
        <p>{row.effectiveFrom.slice(0, 10)} – {row.effectiveTo?.slice(0, 10) ?? 'مستمرة'} · معامل ×{row.multiplier}</p>
        <p>الحد اليومي {row.dailyThresholdMinutes ?? '—'} · الحد الأسبوعي {row.weeklyThresholdMinutes ?? '—'} · سعر الساعة {row.specialHourlyRate ?? '—'}</p>
      </article>)}
    </Card>
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">سجلات الإضافي</h2>
      <Feedback error={list.error} />
      {list.loading && <p role="status">جارٍ التحميل…</p>}
      {list.data?.length === 0 && <p>لا توجد سجلات إضافي.</p>}
      {list.data?.map(row => <article key={row.id} className="space-y-2 rounded-lg border border-line p-3">
        <h3 className="font-semibold">{row.employee.fullName} · {row.workDate.slice(0, 10)}</h3>
        <p>{formatDuration(row.minutes)} · {labels[row.status]}</p>
        <div className="flex flex-wrap gap-2">
          {(row.status === 'DETECTED' ? [['PENDING_APPROVAL', 'إرسال للاعتماد']]
            : row.status === 'PENDING_APPROVAL' ? [['APPROVED', 'اعتماد'], ['REJECTED', 'رفض']] : []).map(([status, label]) =>
            <Button key={status} loading={busy} onClick={() => void run(() => api.post('/overtime/' + row.id + '/decision', { status }))}>{label}</Button>)}
        </div>
      </article>)}
    </Card>
  </div>;
}

export default function OvertimePage() {
  return <AdminOnlyPage><Overtime /></AdminOnlyPage>;
}
