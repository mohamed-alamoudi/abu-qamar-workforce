'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card, Input, Modal, Select } from '@abu-qamar/ui';
import { can } from '@abu-qamar/shared';
import { LogIn, LogOut } from 'lucide-react';
import { Pagination } from '@/components/page';
import { api, toQuery } from '@/lib/api';
import { ATTENDANCE_SYNCED, enqueueAttendance, QUEUE_CHANGED, readQueue, type AttendanceInput, type QueueItem } from '@/lib/attendance-queue';
import { formatDuration } from '@/lib/format';
import { useAuth } from '@/providers/auth-provider';
import { DepartmentSelect, EmployeeSelect, Feedback, localTime, Submit, useMutation, useResource, type Department, type Employee, type Page } from './shared';

type Session = {
  id: string; employeeId: string; departmentId: string; version: number;
  checkInAt: string; checkOutAt: string | null; originalCheckInAt: string; originalCheckOutAt: string | null;
  workDate: string; workedMinutes: number | null; status: string; approvalStatus: string;
  employee: Employee; department: Department; breaks: { id: string; startAt: string; endAt: string | null; isPaid: boolean }[];
  missingCheckOut: boolean;
  deviation: { lateMinutes: number; earlyLeaveMinutes: number | null } | null;
};
const reviewLabels: Record<string, string> = { DRAFT: 'مسودة', IN_REVIEW: 'قيد المراجعة', APPROVED: 'معتمدة' };
type PayrollWarning = { employeeId: string; message: string };

export function AttendancePanel({ employeeId, quick = true }: { employeeId?: string; quick?: boolean }) {
  const { user } = useAuth();
  const subject = user ?? { role: 'SUPERVISOR' as const, permissions: [] };
  const view = can(subject, 'attendance.view');
  const checkIn = can(subject, 'attendance.check_in');
  const checkOut = can(subject, 'attendance.check_out');
  const correct = can(subject, 'attendance.correct');
  const admin = user?.role === 'ADMIN';
  const { revision, busy, feedback, run, refresh } = useMutation();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    const update = () => void readQueue(user.id).then(items => {
      if (active) setQueue(items);
    }).catch(() => {});
    update();
    window.addEventListener(QUEUE_CHANGED, update);
    window.addEventListener(ATTENDANCE_SYNCED, refresh);
    return () => {
      active = false;
      window.removeEventListener(QUEUE_CHANGED, update);
      window.removeEventListener(ATTENDANCE_SYNCED, refresh);
    };
  }, [user?.id, refresh]);
  const [selected, setSelected] = useState('');
  const [section, setSection] = useState<'record' | 'review' | 'history'>('record');
  const [showTime, setShowTime] = useState(false);
  const [payrollWarnings, setPayrollWarnings] = useState<PayrollWarning[]>([]);
  const [staffSearch, setStaffSearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [department, setDepartment] = useState('');
  const [quickArrival, setQuickArrival] = useState('');
  const [quickDeparture, setQuickDeparture] = useState('');
  const [filter, setFilter] = useState({ employeeId: '', departmentId: '', from: '', to: '', status: '', approvalStatus: '' });
  useEffect(() => {
    if (!quick || !view || window.location.hash !== '#review') return;
    setSection('review');
    setFilter(current => ({ ...current, status: 'CLOSED', approvalStatus: 'IN_REVIEW' }));
  }, [quick, view]);
  const [page, setPage] = useState(1);
  const [openPage, setOpenPage] = useState(1);
  const [dialog, setDialog] = useState<{ kind: 'manual' | 'correct' | 'void' | 'history'; row?: Session } | null>(null);
  const [times, setTimes] = useState({ checkInAt: '', checkOutAt: '', departmentId: '', reason: '' });
  const staff = useResource<Employee[]>(quick && (view || checkIn || correct) ? '/attendance/employees' : null);
  const departments = useResource<Department[]>((quick && (checkIn || view)) || correct ? '/departments' : null);
  const offlineRoster = useResource<Employee[]>(quick && checkOut && !checkIn && !view && !correct ? '/attendance/employees' : null);
  const open = useResource<Page<Session>>(quick && (view || checkIn || checkOut) ? '/attendance/open' + toQuery({ page: openPage, pageSize: 20 }) : null, revision);
  const list = useResource<Page<Session>>(view ? '/attendance' + toQuery({ ...filter, employeeId: employeeId ?? filter.employeeId, page, pageSize: 20 }) : null, revision);
  const [offlineReady, setOfflineReady] = useState(false);
  useEffect(() => {
    const roster = staff.data ?? offlineRoster.data;
    if (!quick || !user || !roster || !(checkIn || checkOut || correct) || ((checkIn || checkOut) && !open.data) || !navigator.onLine) return;
    try {
      localStorage.setItem('aq-offline-attendance', JSON.stringify({
        userId: user.id, preparedAt: Date.now(), checkIn, checkOut, correct,
        timezone: open.data?.timezone ?? list.data?.timezone ?? 'Asia/Gaza',
        departments: departments.data?.filter(item => item.isActive).map(({ id, name }) => ({ id, name })) ?? [],
        employees: roster.filter(item => item.status === 'ACTIVE').map(({ id, fullName, code }) => ({ id, fullName, code })),
        open: (open.data?.items ?? []).filter(item => item.employee.status === 'ACTIVE').map(item => ({
          id: item.id, employeeId: item.employeeId, version: item.version, checkInAt: item.checkInAt,
          onBreak: item.breaks.some(breakItem => !breakItem.endAt),
        })),
      }));
      setOfflineReady(true);
    } catch { setOfflineReady(false); }
  }, [quick, user, checkIn, checkOut, correct, staff.data, offlineRoster.data, open.data, list.data?.timezone, departments.data]);
  const zone = list.data?.timezone ?? open.data?.timezone ?? 'Asia/Gaza';
  const history = useResource<{ id: string; createdAt: string; reason: string; correctedBy: { fullName: string };
    before: Pick<Session, 'checkInAt' | 'checkOutAt'>; after: Pick<Session, 'checkInAt' | 'checkOutAt'> }[]>(
    dialog?.kind === 'history' ? '/attendance/' + dialog.row?.id + '/corrections' : null);
  const employees = staff.data ?? [];
  const matches = (row: Employee, query: string) => (row.fullName + ' ' + row.code).toLowerCase().includes(query.trim().toLowerCase());
  const activeEmployees = employees.filter(row => row.status === 'ACTIVE');
  const registrationEmployees = checkIn || correct ? activeEmployees : (offlineRoster.data ?? staff.data ?? []).filter(row => row.status === 'ACTIVE');
  const activeSelection = registrationEmployees.some(row => row.id === selected) ? selected : '';
  const availableOpenShifts = open.data?.items.filter(row => row.employee.status === 'ACTIVE') ?? [];
  useEffect(() => {
    if (!quick || section !== 'record' || !open.data || !window.location.hash.startsWith('#shift-')) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }, [quick, section, open.data]);
  const availableDepartments = departments.data ?? [];
  const pending = queue.filter(item => ['LOCAL', 'PENDING', 'SENDING'].includes(item.state));
  const queuedOpen = pending.find(({ operation }) => operation.employeeId === selected &&
    (operation.action === 'CHECK_IN' || (operation.action === 'MANUAL' && !operation.checkOutAt)) &&
    !pending.some(item => item.operation.sessionId === operation.operationId && item.operation.action === 'CHECK_OUT'));
  const pendingCheckout = (id: string) => pending.some(({ operation }) => operation.sessionId === id && operation.action === 'CHECK_OUT');
  function storeOffline(operation: AttendanceInput) {
    if (!user) return Promise.resolve(false);
    return run(() => enqueueAttendance(user.id, operation), 'محفوظ محليًا · بانتظار تأكيد الخادم');
  }
  const chosenOpen = availableOpenShifts.find(row => row.employeeId === activeSelection);
  const changeFilter = (key: keyof typeof filter, value: string) => {
    setFilter(current => ({ ...current, [key]: value }));
    setPage(1);
  };
  function showDialog(kind: NonNullable<typeof dialog>['kind'], row?: Session) {
    setTimes({ checkInAt: row ? localTime(row.checkInAt, zone).replace(' ', 'T') : '',
      checkOutAt: row?.checkOutAt ? localTime(row.checkOutAt, zone).replace(' ', 'T') : '',
      departmentId: row?.departmentId ?? department, reason: '' });
    setDialog({ kind, row });
  }
  function action(row: Session, path: string, extra: object = {}) {
    return run(async () => {
      const result = await api.post<{ payrollWarnings?: PayrollWarning[] }>('/attendance/' + row.id + '/' + path, { version: row.version, ...extra });
      if (path === 'approve') setPayrollWarnings(result.payrollWarnings ?? []);
    });
  }
  async function bulkTransition(action: 'review' | 'approve') {
    const { departmentId, from, to } = filter;
    const scope = {
      employeeId: employeeId || filter.employeeId || undefined,
      departmentId: departmentId || undefined, from: from || undefined, to: to || undefined,
    };
    if (action === 'approve') {
      let preview: { ready: number; needsReview: number } | undefined;
      await run(async () => { preview = await api.post('/attendance/bulk/approve/preview', scope); }, '');
      if (!preview || !window.confirm(`جاهزة للاعتماد: ${preview.ready} · انصراف ناقص أو مسودة: ${preview.needsReview}. متابعة؟`) || !preview.ready) return;
    }
    return run(() => api.post<{ updated: number; skipped: number; payrollWarnings?: PayrollWarning[] }>('/attendance/bulk/' + action, scope), ({ updated, skipped, payrollWarnings }) => {
      if (action === 'approve') setPayrollWarnings(payrollWarnings ?? []);
      if (!updated && !skipped) return 'لا توجد سجلات مؤهلة لهذا الإجراء في النطاق المحدد.';
      const label = action === 'review' ? 'أُرسلت للمراجعة' : 'اعتُمدت';
      return label + ' · عدد السجلات: ' + updated +
        (skipped ? ' · تعذّر تغيير ' + skipped + ' سجل. راجع حالة السجلات أو فترة الرواتب.' : '');
    });
  }
  function checkout(row: Session) {
    if (!navigator.onLine) return storeOffline({
      action: 'CHECK_OUT', sessionId: row.id, baseVersion: row.version, checkOutAt: quickDeparture || new Date().toISOString(),
    });
    return run(() => api.post('/attendance/check-out', { employeeId: row.employeeId, sessionId: row.id, baseVersion: row.version,
      at: quickDeparture || undefined }), 'تم تسجيل الانصراف');
  }
  const time = (at: string | null) => at ? localTime(at, zone) : 'غير مسجّل';
  if (!view && (!quick || (!checkIn && !checkOut && !correct))) return <p className="text-muted">ليست لديك صلاحية عرض سجلات الدوام.</p>;

  return <div className="space-y-5">
    {quick && view && <nav aria-label="أقسام الدوام" className="flex flex-wrap gap-2">
      {([['record', 'التسجيل'], ['review', 'المراجعة'], ['history', 'السجل']] as const).map(([key, label]) =>
        <Button key={key} aria-pressed={section === key} variant={section === key ? 'primary' : 'secondary'} onClick={() => {
          setSection(key);
          setPage(1);
          setFilter(current => ({ ...current, status: key === 'review' ? 'CLOSED' : '', approvalStatus: key === 'review' ? 'IN_REVIEW' : '' }));
        }}>{label}</Button>)}
    </nav>}
    <Feedback {...feedback} />
    {payrollWarnings.length > 0 && <Card className="space-y-2 p-4">
      <p className="font-semibold">مستحقات تحتاج مراجعة</p>
      <ul className="list-inside list-disc text-sm">{payrollWarnings.map(({ employeeId, message }) =>
        <li key={employeeId + message}>{message} · <Link className="underline" href={`/employees/${employeeId}#finance`}>فتح الحساب المالي</Link></li>)}</ul>
    </Card>}
    <Feedback error={staff.error ?? departments.error} />
    {quick && section === 'record' && <section id="quick-check-in"><Card className="space-y-4 p-4">
      <h2 className="text-lg font-semibold">التسجيل السريع</h2>
      {offlineReady && process.env.NODE_ENV === 'production' && <p className="text-sm text-muted">حُفظت بيانات التسجيل لهذا الجهاز. عند انقطاع الاتصال افتح التطبيق للوصول إلى شاشة الدوام المحلية.</p>}
      {(checkIn || checkOut || correct) && <div className="grid gap-3 sm:grid-cols-2">
        <Input label="بحث عن موظف بالاسم أو الكود" value={staffSearch} onChange={e => setStaffSearch(e.target.value)} />
        <EmployeeSelect employees={registrationEmployees.filter(row => row.id === activeSelection || matches(row, staffSearch))}
          value={activeSelection} onChange={setSelected} required />
        <DepartmentSelect departments={availableDepartments.filter(row => row.isActive)} value={department} onChange={setDepartment} />
      </div>}
      {(checkIn || checkOut) && <Button variant="ghost" aria-expanded={showTime} onClick={() => {
        if (showTime) { setQuickArrival(''); setQuickDeparture(''); }
        setShowTime(!showTime);
      }}>
        {showTime ? 'طي حقول التاريخ والوقت' : 'تحديد التاريخ والوقت'}
      </Button>}
      {(checkIn || checkOut) && showTime && <div className="grid gap-3 sm:grid-cols-2">
        {checkIn && <Input label="وقت الحضور (اختياري)" type="datetime-local" value={quickArrival} onChange={e => setQuickArrival(e.target.value)} />}
        {checkOut && <Input label="وقت الانصراف (اختياري)" type="datetime-local" value={quickDeparture} onChange={e => setQuickDeparture(e.target.value)} />}
        <p className="text-sm text-muted">التوقيت حسب النظام ({zone}). اترك الحقل فارغًا للتسجيل بالوقت الحالي.</p>
      </div>}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {checkIn && !chosenOpen && !queuedOpen && <Button className="min-h-14" disabled={!activeSelection} loading={busy}
          onClick={() => void (navigator.onLine
            ? run(() => api.post('/attendance/check-in', { employeeId: selected, departmentId: department || undefined, at: quickArrival || undefined }), 'تم تسجيل الحضور')
            : storeOffline({ action: 'CHECK_IN', employeeId: selected, departmentId: department || undefined, checkInAt: quickArrival || new Date().toISOString() }))}>
          <LogIn size={20} /> تسجيل الحضور
        </Button>}
        {checkOut && activeSelection && queuedOpen && <Button className="min-h-14" variant="secondary" loading={busy}
          onClick={() => void storeOffline({ action: 'CHECK_OUT', sessionId: queuedOpen.operation.operationId,
            baseVersion: 1, checkOutAt: quickDeparture || new Date().toISOString() })}><LogOut size={20} /> تسجيل الانصراف للوردية المحلية</Button>}
        {checkOut && chosenOpen && <Button disabled={pendingCheckout(chosenOpen.id) || chosenOpen.breaks.some(item => !item.endAt)} className="min-h-14" variant="secondary" loading={busy} onClick={() => void checkout(chosenOpen)}>
          <LogOut size={20} /> تسجيل الانصراف
        </Button>}
        {correct && <Button variant="secondary" className="min-h-14" disabled={!activeSelection} onClick={() => showDialog('manual')}>إدخال يدوي</Button>}
      </div>
      {(view || admin) && <div className="flex flex-wrap gap-4 text-sm">
        {view && <Link className="underline" href="/attendance/schedules">جداول العمل</Link>}
        {admin && <Link className="underline" href="/attendance/overtime">العمل الإضافي</Link>}
      </div>}
    </Card></section>}
    {quick && section === 'record' && (view || checkIn || checkOut) && <section id="quick-check-out"><Card className="space-y-3 p-4">
      <h2 className="text-lg font-semibold">الورديات المفتوحة</h2>
      <Feedback error={open.error} />
      {open.loading && <p role="status">جارٍ تحميل الورديات المفتوحة…</p>}
      {open.data && availableOpenShifts.length === 0 && <p className="text-muted">لا توجد ورديات مفتوحة.</p>}
      {availableOpenShifts.map(row => {
        const activeBreak = row.breaks.find(item => !item.endAt);
        return <div key={row.id} id={`shift-${row.id}`} className="flex scroll-mt-24 flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3 target:ring-2 target:ring-brand-500">
          <div><p className="font-semibold">{row.employee.fullName} · {row.department.name}</p>
            <p className="text-sm text-muted">{time(row.checkInAt)} {activeBreak && '· في استراحة'}</p>
            {row.missingCheckOut && <p className="text-sm font-medium text-danger-600">انصراف ناقص</p>}</div>
          <div className="flex flex-wrap gap-2">
            {activeBreak ? checkOut && <Button variant="secondary" loading={busy} onClick={() => void action(row, 'breaks/end')}>إنهاء الاستراحة</Button>
              : checkIn && <>
                <Button variant="secondary" loading={busy} onClick={() => void action(row, 'breaks/start', { isPaid: false })}>استراحة غير مدفوعة</Button>
                <Button variant="secondary" loading={busy} onClick={() => void action(row, 'breaks/start', { isPaid: true })}>استراحة مدفوعة</Button>
              </>}
            {checkOut && <Button className="min-h-12" loading={busy} disabled={Boolean(activeBreak) || pendingCheckout(row.id)} onClick={() => void checkout(row)}>
              <LogOut size={19} /> تسجيل الانصراف
            </Button>}
          </div>
        </div>;
      })}
      {!!open.data?.total && <Pagination total={open.data.total} page={openPage} totalPages={Math.ceil(open.data.total / 20)} onChange={setOpenPage} />}
    </Card></section>}
    {view && (!quick || section !== 'record') && <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">سجلات الدوام</h2>
        {section !== 'review' && <Button variant="secondary" onClick={() => {
          if (quick) setSection('review');
          setFilter(current => ({ ...current, status: 'CLOSED', approvalStatus: 'IN_REVIEW' }));
          setPage(1);
        }}>قائمة المراجعة</Button>}
        <Button variant="ghost" onClick={() => {
          setFilter({ employeeId: '', departmentId: '', from: '', to: '', status: '', approvalStatus: '' }); setPage(1);
        }}>مسح الفلاتر</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {!employeeId && <>
          <Input label="بحث بالاسم أو الكود في الموظفين" value={historySearch} onChange={e => setHistorySearch(e.target.value)} />
          <EmployeeSelect employees={employees.filter(row => row.id === filter.employeeId || matches(row, historySearch))}
            value={filter.employeeId} onChange={id => changeFilter('employeeId', id)} />
        </>}
        {quick && <Select label="القسم" value={filter.departmentId} onChange={e => changeFilter('departmentId', e.target.value)}>
          <option value="">جميع الأقسام</option>
          {availableDepartments.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </Select>}
        <Input label="من تاريخ" type="date" value={filter.from} onChange={e => changeFilter('from', e.target.value)} />
        <Input label="إلى تاريخ" type="date" value={filter.to} onChange={e => changeFilter('to', e.target.value)} />
        <Select label="حالة الوردية" value={filter.status} onChange={e => changeFilter('status', e.target.value)}>
          <option value="">السجلات القائمة</option><option value="OPEN">مفتوحة</option><option value="CLOSED">مغلقة</option><option value="VOIDED">ملغاة</option>
        </Select>
        <Select label="الاعتماد" value={filter.approvalStatus} onChange={e => changeFilter('approvalStatus', e.target.value)}>
          <option value="">جميع الحالات</option>
          {Object.entries(reviewLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </div>
      {(correct || admin) && <div className="space-y-2 border-t border-line pt-3">
        {section === 'review' && !list.loading && list.data && <p className="text-sm">السجلات المطابقة للفلاتر · {list.data.total}</p>}
        <div className="flex flex-wrap gap-2">
          {correct && <Button variant="secondary" disabled={busy} onClick={() => void bulkTransition('review')}>
            إرسال الكل للمراجعة
          </Button>}
          {admin && <Button disabled={busy} onClick={() => void bulkTransition('approve')}>معاينة الاعتماد الجماعي</Button>}
        </div>
        <p className="text-sm text-muted">يشمل الإجراء الورديات المغلقة المؤهلة عبر كل الصفحات حسب الموظف والقسم والتواريخ المحددة.</p>
      </div>}
      <Feedback error={list.error} />
      {list.loading && <p role="status">جارٍ تحميل السجلات…</p>}
      {list.data?.items.length === 0 && <p className="text-muted">لا توجد سجلات مطابقة.</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        {list.data?.items.map(row => <article key={row.id} className="space-y-2 rounded-lg border border-line p-3">
          <h3 className="font-semibold">{row.employee.fullName} · {row.department.name}</h3>
          <p className="text-sm">{row.workDate} · {row.status === 'VOIDED' ? 'ملغاة' : row.status === 'OPEN' ? 'مفتوحة' : reviewLabels[row.approvalStatus]}</p>
          <p className="text-sm text-muted">الحضور {time(row.checkInAt)} · الانصراف {time(row.checkOutAt)}</p>
          {row.workedMinutes !== null && <p className="text-sm">المدة المستحقة {formatDuration(row.workedMinutes)}</p>}
          {row.deviation && <p className="text-sm">التأخير {formatDuration(row.deviation.lateMinutes)} · الانصراف المبكر {row.deviation.earlyLeaveMinutes == null ? '—' : formatDuration(row.deviation.earlyLeaveMinutes)}</p>}
          {row.breaks.map(item => <p className="text-sm text-muted" key={item.id}>
            استراحة {item.isPaid ? 'مدفوعة' : 'غير مدفوعة'} · {time(item.startAt)} – {time(item.endAt)}
          </p>)}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => showDialog('history', row)}>سجل التصحيحات</Button>
            {row.status !== 'VOIDED' && correct && <Button size="sm" variant="secondary" onClick={() => showDialog('correct', row)}>تصحيح</Button>}
            {row.status === 'CLOSED' && row.approvalStatus === 'DRAFT' && correct &&
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void action(row, 'review')}>إرسال للمراجعة</Button>}
            {row.status === 'CLOSED' && row.approvalStatus === 'IN_REVIEW' && admin &&
              <Button size="sm" loading={busy} onClick={() => void action(row, 'approve')}>اعتماد</Button>}
            {row.status !== 'VOIDED' && admin && <Button size="sm" variant="ghost" onClick={() => showDialog('void', row)}>إلغاء الوردية</Button>}
          </div>
        </article>)}
      </div>
      {list.data && <Pagination total={list.data.total} page={page} totalPages={Math.max(1, Math.ceil(list.data.total / 20))} onChange={setPage} />}
    </Card>}
    {dialog && <Modal open title={{ manual: 'إدخال يدوي', correct: 'تصحيح الدوام', void: 'إلغاء الوردية', history: 'سجل التصحيحات' }[dialog.kind]}
      onClose={() => setDialog(null)}>
      {dialog.kind === 'history' ? <div className="space-y-3">
        <p className="text-sm">الحضور الأصلي {time(dialog.row?.originalCheckInAt ?? null)} · الانصراف الأصلي {time(dialog.row?.originalCheckOutAt ?? null)}</p>
        <Feedback error={history.error} />
        {history.loading && <p role="status">جارٍ تحميل التصحيحات…</p>}
        {history.data?.length === 0 && <p>لا توجد تصحيحات.</p>}
        {history.data?.map(entry => <div key={entry.id} className="rounded-lg border border-line p-3 text-sm">
          <p>{entry.correctedBy.fullName} · {time(entry.createdAt)} · {entry.reason}</p>
          <p>قبل {time(entry.before.checkInAt)} – {time(entry.before.checkOutAt)}</p>
          <p>بعد {time(entry.after.checkInAt)} – {time(entry.after.checkOutAt)}</p>
        </div>)}
      </div> : <form className="space-y-3" onSubmit={async event => {
        event.preventDefault();
        const row = dialog.row;
        const body = {
          checkInAt: row && times.checkInAt === localTime(row.checkInAt, zone).replace(' ', 'T') ? undefined : times.checkInAt || undefined,
          checkOutAt: row?.checkOutAt && times.checkOutAt === localTime(row.checkOutAt, zone).replace(' ', 'T') ? undefined : times.checkOutAt || undefined,
          departmentId: times.departmentId || undefined,
        };
        if (!navigator.onLine && dialog.kind !== 'void') {
          const ok = await storeOffline(dialog.kind === 'manual'
            ? { ...body, action: 'MANUAL', employeeId: selected }
            : { ...body, action: 'CORRECTION', sessionId: row?.id, baseVersion: row?.version, reason: times.reason });
          if (ok) setDialog(null);
          return;
        }
        const ok = await run(() => dialog.kind === 'manual' ? api.post('/attendance/manual', { ...body, employeeId: selected })
          : dialog.kind === 'void' ? api.post('/attendance/' + row?.id + '/void', { version: row?.version, reason: times.reason })
            : api.patch('/attendance/' + row?.id, { ...body, version: row?.version, reason: times.reason }));
        if (ok) setDialog(null);
      }}>
        <Feedback error={feedback.error} />
        {dialog.row && <p className="text-sm">القيم الحالية · الحضور {time(dialog.row.checkInAt)} · الانصراف {time(dialog.row.checkOutAt)} · {dialog.row.department.name}</p>}
        {dialog.kind !== 'void' && <>
          <p className="text-sm text-muted">الأوقات حسب منطقة النظام ({zone}).</p>
          <Input label={dialog.row ? 'الحضور بعد التصحيح' : 'وقت الحضور'} type="datetime-local" required value={times.checkInAt}
            onChange={e => setTimes({ ...times, checkInAt: e.target.value })} />
          <Input label={dialog.row ? 'الانصراف بعد التصحيح' : 'وقت الانصراف'} type="datetime-local" required={Boolean(dialog.row?.checkOutAt)} value={times.checkOutAt}
            onChange={e => setTimes({ ...times, checkOutAt: e.target.value })} />
          <DepartmentSelect departments={availableDepartments} value={times.departmentId} onChange={id => setTimes({ ...times, departmentId: id })} />
        </>}
        {dialog.kind !== 'manual' && <Input label="السبب" required maxLength={255} value={times.reason}
          onChange={e => setTimes({ ...times, reason: e.target.value })} />}
        <Submit busy={busy}>{dialog.kind === 'void' ? 'تأكيد الإلغاء' : 'حفظ'}</Submit>
      </form>}
    </Modal>}
  </div>;
}
