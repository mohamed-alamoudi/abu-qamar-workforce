'use client';

import { useState } from 'react';
import { Button, Card, Input, Select } from '@abu-qamar/ui';
import { can } from '@abu-qamar/shared';
import { PageHeader, Pagination } from '@/components/page';
import { api, toQuery } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { EmployeeSelect, Feedback, Submit, useMutation, useResource, type Employee, type Page } from '@/features/attendance/shared';

const types = { PAID_LEAVE: 'إجازة مدفوعة', UNPAID_LEAVE: 'إجازة غير مدفوعة',
  PAID_EXCUSED_ABSENCE: 'غياب مدفوع ومبرر', UNPAID_ABSENCE: 'غياب غير مدفوع' };
const statuses: Record<string, string> = { PENDING: 'بانتظار الاعتماد', APPROVED: 'معتمدة', REJECTED: 'مرفوضة', CANCELLED: 'ملغاة' };
type Row = { id: string; type: keyof typeof types; startDate: string; endDate: string; affectsPay: boolean;
  status: string; reason?: string; employee: { fullName: string }; recordedBy: { fullName: string } };

export default function LeavesPage() {
  const { user } = useAuth();
  const view = Boolean(user && can(user, 'leaves.view'));
  const record = Boolean(user && can(user, 'leaves.record'));
  const admin = user?.role === 'ADMIN';
  const { revision, busy, feedback, run } = useMutation();
  const [form, setForm] = useState({ employeeId: '', type: 'PAID_LEAVE', startDate: '', endDate: '', reason: '', affectsPay: false });
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const employees = useResource<Employee[]>(record ? '/attendance/employees' : null);
  const list = useResource<Page<Row>>(view ? '/leaves' + toQuery({ status, page, pageSize: 20 }) : null, revision);
  return <div className="space-y-4">
    <PageHeader title="الإجازات والغياب" />
    <Feedback {...feedback} />
    {!view && !record && <p>ليست لديك صلاحية لهذه الصفحة.</p>}
    {record && <Card className="space-y-3 p-4">
      <h2 className="font-semibold">تسجيل إجازة أو غياب</h2>
      <Feedback error={employees.error} />
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={async event => {
        event.preventDefault();
        if (await run(() => api.post('/leaves', form))) setForm({ ...form, reason: '', startDate: '', endDate: '' });
      }}>
        <EmployeeSelect employees={employees.data ?? []} value={form.employeeId} onChange={employeeId => setForm({ ...form, employeeId })} required />
        <Select label="النوع" value={form.type} onChange={event => {
          const type = event.target.value;
          setForm({ ...form, type, affectsPay: type.startsWith('UNPAID') });
        }}>
          {Object.entries(types).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        <Input label="البداية" type="date" required value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} />
        <Input label="النهاية" type="date" required min={form.startDate} value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} />
        <Input label="السبب" maxLength={255} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.affectsPay}
          onChange={e => setForm({ ...form, affectsPay: e.target.checked })} /> تُخصم الأيام من الأجر</label>
        <div><Submit busy={busy}>تسجيل للمراجعة</Submit></div>
      </form>
    </Card>}
    {view && <Card className="space-y-3 p-4">
      <Select label="حالة الاعتماد" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
        <option value="">جميع الحالات</option>
        {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      <Feedback error={list.error} />
      {list.loading && <p role="status">جارٍ التحميل…</p>}
      {list.data?.items.length === 0 && <p>لا توجد سجلات.</p>}
      {list.data?.items.map(row => <article className="space-y-2 rounded-lg border border-line p-3" key={row.id}>
        <h2 className="font-semibold">{row.employee.fullName} · {types[row.type]}</h2>
        <p className="text-sm">{row.startDate.slice(0, 10)} – {row.endDate.slice(0, 10)} · {statuses[row.status]}</p>
        <p className="text-sm text-muted">سجّلها {row.recordedBy.fullName} · {row.affectsPay ? 'تُخصم من الأجر' : 'دون خصم'} {row.reason && '· ' + row.reason}</p>
        {admin && (row.status === 'PENDING' || row.status === 'APPROVED') && <div className="flex flex-wrap gap-2">
          {(row.status === 'PENDING' ? [['APPROVED', 'اعتماد'], ['REJECTED', 'رفض']] : [['CANCELLED', 'إلغاء']]).map(([value, label]) =>
            <Button key={value} variant={value === 'APPROVED' ? 'primary' : 'secondary'} loading={busy}
              onClick={() => void run(() => api.post('/leaves/' + row.id + '/decision', { status: value }))}>{label}</Button>)}
        </div>}
      </article>)}
      {list.data && <Pagination total={list.data.total} page={page} totalPages={Math.max(1, Math.ceil(list.data.total / 20))} onChange={setPage} />}
    </Card>}
  </div>;
}
