'use client';

import { useState } from 'react';
import { can } from '@abu-qamar/shared';
import { Button, Card, Input, Select } from '@abu-qamar/ui';
import { PageHeader } from '@/components/page';
import { api, toQuery } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { DepartmentSelect, EmployeeSelect, Feedback, localTime, Submit, useMutation, useResource, type Department, type Employee } from '@/features/attendance/shared';

const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const kinds: Record<string, string> = { FLEXIBLE: 'مرن', FIXED: 'ثابت أسبوعيًا', VARIABLE: 'متغير' };
type Pattern = { day: number; start: string; end: string };
type Schedule = { id: string; kind: string; name: string | null; effectiveFrom: string; effectiveTo: string | null; weeklyPattern: Pattern[] };
type Shift = { id: string; date: string; startAt: string; endAt: string; origin: 'WEEKLY' | 'DATED'; department: Department | null };

export default function SchedulesPage() {
  const { user } = useAuth();
  const view = Boolean(user && can(user, 'attendance.view'));
  const admin = user?.role === 'ADMIN';
  const { revision, busy, feedback, run } = useMutation();
  const [employeeId, setEmployeeId] = useState('');
  const [schedule, setSchedule] = useState({ name: '', kind: 'FLEXIBLE', effectiveFrom: '' });
  const [pattern, setPattern] = useState<Pattern[]>([]);
  const [shift, setShift] = useState({ startAt: '', endAt: '', departmentId: '' });
  const [range, setRange] = useState({ from: '', to: '' });
  const [endDate, setEndDate] = useState('');
  const [query, setQuery] = useState('');
  const employees = useResource<Employee[]>(view ? '/attendance/employees' : null);
  const departments = useResource<Department[]>(admin ? '/departments' : null);
  const history = useResource<Schedule[]>(view && employeeId ? '/schedules' + toQuery({ employeeId }) : null, revision);
  const zone = useResource<{ timezone: string }>(view ? '/attendance?status=OPEN&pageSize=1' : null);
  const planned = useResource<Shift[]>(query ? '/schedules/planned' + query : null, revision);
  const missed = useResource<(Shift & { employee: Employee })[]>(query ? '/schedules/missed' + query : null, revision);
  const dated = useResource<Shift[]>(admin && query ? '/schedules/shifts' + query : null, revision);
  const timezone = zone.data?.timezone ?? 'Asia/Gaza';

  return <div className="space-y-4">
    <PageHeader title="جداول العمل" />
    <Feedback {...feedback} />
    {!view && <p>ليست لديك صلاحية عرض الجداول.</p>}
    {view && <Card className="space-y-3 p-4">
      <Feedback error={employees.error ?? history.error} />
      <EmployeeSelect employees={employees.data ?? []} value={employeeId} onChange={id => { setEmployeeId(id); setQuery(''); }} required />
      {history.loading && <p role="status">جارٍ تحميل الجداول…</p>}
      {history.data?.length === 0 && <p>لا يوجد جدول لهذا الموظف.</p>}
      {history.data?.map(row => <article key={row.id} className="space-y-2 rounded-lg border border-line p-3">
        <h2 className="font-semibold">{row.name || kinds[row.kind]} · {row.effectiveFrom} – {row.effectiveTo ?? 'مستمر'}</h2>
        {row.weeklyPattern.map(entry => <p key={entry.day + entry.start}>{days[entry.day]} · {entry.start} – {entry.end}</p>)}
        {admin && !row.effectiveTo && <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
          event.preventDefault();
          void run(() => api.post('/schedules/' + row.id + '/end', { effectiveTo: endDate }));
        }}>
          <Input label="نهاية السريان" type="date" min={row.effectiveFrom} required value={endDate} onChange={e => setEndDate(e.target.value)} />
          <Submit busy={busy}>إنهاء الجدول</Submit>
        </form>}
      </article>)}
    </Card>}
    {admin && employeeId && <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">تحديد جدول معتمد</h2>
        <form className="space-y-3" onSubmit={event => {
          event.preventDefault();
          void run(() => api.post('/schedules', { employeeId, ...schedule, effectiveFrom: schedule.effectiveFrom || undefined,
            weeklyPattern: schedule.kind === 'FIXED' ? pattern : undefined }));
        }}>
          <Input label="اسم الجدول" maxLength={100} value={schedule.name} onChange={e => setSchedule({ ...schedule, name: e.target.value })} />
          <Select label="نوع الجدول" value={schedule.kind} onChange={e => setSchedule({ ...schedule, kind: e.target.value })}>
            {Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
          <Input label="بداية السريان" type="date" value={schedule.effectiveFrom} onChange={e => setSchedule({ ...schedule, effectiveFrom: e.target.value })} />
          {schedule.kind === 'FIXED' && <>
            {pattern.map((row, index) => {
              const update = (changes: Partial<Pattern>) => setPattern(pattern.map((entry, i) => i === index ? { ...entry, ...changes } : entry));
              return <div key={index} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
                <Select label="اليوم" value={row.day} onChange={e => update({ day: Number(e.target.value) })}>
                  {days.map((day, i) => <option key={day} value={i}>{day}</option>)}
                </Select>
                <Input label="البداية" type="time" required value={row.start} onChange={e => update({ start: e.target.value })} />
                <Input label="النهاية" type="time" required value={row.end} onChange={e => update({ end: e.target.value })} />
                <Button type="button" variant="ghost" onClick={() => setPattern(pattern.filter((_, i) => i !== index))}>إزالة</Button>
              </div>;
            })}
            <Button type="button" variant="secondary" disabled={pattern.length >= 28}
              onClick={() => setPattern([...pattern, { day: 6, start: '', end: '' }])}>إضافة وردية أسبوعية</Button>
          </>}
          <div><Submit busy={busy}>حفظ الجدول</Submit></div>
        </form>
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">إضافة وردية مؤرخة</h2>
        <Feedback error={departments.error} />
        <p className="text-sm text-muted">الأوقات حسب منطقة النظام ({timezone}).</p>
        <form className="space-y-3" onSubmit={event => {
          event.preventDefault();
          void run(() => api.post('/schedules/shifts', { ...shift, employeeId, departmentId: shift.departmentId || undefined }));
        }}>
          <Input label="البداية" type="datetime-local" required value={shift.startAt} onChange={e => setShift({ ...shift, startAt: e.target.value })} />
          <Input label="النهاية" type="datetime-local" required value={shift.endAt} onChange={e => setShift({ ...shift, endAt: e.target.value })} />
          <DepartmentSelect departments={(departments.data ?? []).filter(row => row.isActive)} value={shift.departmentId}
            onChange={departmentId => setShift({ ...shift, departmentId })} />
          <Submit busy={busy}>حفظ الوردية</Submit>
        </form>
      </Card>
    </div>}
    {view && employeeId && <Card className="space-y-3 p-4">
      <h2 className="font-semibold">الورديات المجدولة</h2>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setQuery(toQuery({ employeeId, ...range })); }}>
        <Input label="من تاريخ" type="date" required value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} />
        <Input label="إلى تاريخ" type="date" required min={range.from} value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} />
        <Submit busy={planned.loading}>عرض الورديات</Submit>
      </form>
      <Feedback error={planned.error ?? dated.error ?? missed.error} />
      {planned.data?.length === 0 && <p>لا توجد ورديات في الفترة.</p>}
      {planned.data?.map(row => <div key={row.id} className="rounded-lg border border-line p-3">
        {localTime(row.startAt, timezone)} – {localTime(row.endAt, timezone)} {row.department && '· ' + row.department.name}
        {admin && dated.data?.some(item => item.id === row.id) && <Button variant="ghost" loading={busy}
          onClick={() => { if (window.confirm('إزالة هذه الوردية المجدولة؟')) void run(() => api.delete('/schedules/shifts/' + row.id)); }}>إزالة</Button>}
      </div>)}
      {missed.data && <div className="space-y-2 border-t border-line pt-3">
        <h3 className="font-semibold">ورديات فائتة للمراجعة</h3>
        {missed.data.length === 0 && <p className="text-sm text-muted">لا توجد ورديات فائتة.</p>}
        {missed.data.map(row => <p key={row.id} className="text-sm text-muted">
          {row.employee.fullName} · {localTime(row.startAt, timezone)} – {localTime(row.endAt, timezone)}
        </p>)}
      </div>}
    </Card>}
  </div>;
}
