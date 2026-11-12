'use client';

import { can } from '@abu-qamar/shared';
import { Alert, Button, Card, Input, Select, Spinner } from '@abu-qamar/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Pagination, PageHeader } from '@/components/page';
import { useDebounced, usePersistedState } from '@/hooks/use-persisted-state';
import { api, errorMessage, toApiError } from '@/lib/api';
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format';
import { useAuth } from '@/providers/auth-provider';

export const reports = {
  attendance: 'تقرير الدوام',
  absence: 'تقرير الغياب والإجازات',
  financial: 'التقرير المالي',
  payments: 'تقرير الدفعات',
} as const;
type Report = keyof typeof reports;
type Value = string | number | null;
type Kind = 'text' | 'enum' | 'date' | 'datetime' | 'minutes' | 'money' | 'int' | 'days';
type Column = { key: string; label: string; type: Kind; labels?: Record<string, string> };
type Row = Record<string, Value>;
type Result = {
  range: { from: string; to: string }; currency: string; timezone: string;
  columns: Column[]; availableColumns: Column[]; items: Row[]; total: number; totalPages: number;
  totals: Row; summary: (Column & { value: Value })[]; notes: string[];
  charts: { title: string; unit: Kind; points: { label: string; value: string | number }[] }[];
};
type Options = {
  employees: { id: string; code: string; fullName: string }[];
  departments: { id: string; name: string }[];
};
const views: Record<Report, Record<string, string>> = {
  attendance: { sessions: 'تفصيل الورديات', employees: 'ملخص حسب الموظف' },
  absence: { records: 'تفصيل السجلات', employees: 'ملخص حسب الموظف' },
  financial: { employees: 'ملخص حسب الموظف', entries: 'مستحقات الفترات', advances: 'السلف', debts: 'الديون', settlements: 'التسويات' },
  payments: { payments: 'كل الدفعات', byEmployee: 'حسب الموظف', byPeriod: 'حسب الفترة', byMethod: 'حسب طريقة الدفع', byExecutor: 'حسب من نفّذ' },
};
type Filter = [string, string, Record<string, string>];
const flags = { true: 'نعم' };
const filters: Record<Report, Filter[]> = {
  attendance: [
    ['status', 'حالة الوردية', { OPEN: 'مفتوحة', CLOSED: 'مغلقة' }],
    ['approvalStatus', 'الاعتماد', { DRAFT: 'مسودة', IN_REVIEW: 'قيد المراجعة', APPROVED: 'معتمدة' }],
    ['lateOnly', 'المتأخرون فقط', flags],
  ],
  absence: [
    ['type', 'النوع', { PAID_LEAVE: 'إجازة مدفوعة', UNPAID_LEAVE: 'إجازة غير مدفوعة', PAID_EXCUSED_ABSENCE: 'غياب بعذر مدفوع', UNPAID_ABSENCE: 'غياب غير مدفوع' }],
    ['status', 'الحالة', { ALL: 'كل الحالات', PENDING: 'معلقة', APPROVED: 'معتمدة', REJECTED: 'مرفوضة', CANCELLED: 'ملغاة' }],
    ['pay', 'الأجر', { paid: 'مدفوع', unpaid: 'غير مدفوع' }],
  ],
  financial: [
    ['periodStatus', 'حالة الفترة', { ALL: 'كل الحالات', CLOSED: 'مغلقة', DRAFT: 'مسودة', IN_REVIEW: 'قيد المراجعة', READY_FOR_APPROVAL: 'جاهزة للاعتماد' }],
    ['accountStatus', 'حالة الحساب', { OPEN: 'قائم', SETTLED: 'مسدد', CANCELLED: 'ملغى' }],
    ['outstandingOnly', 'الأرصدة المتبقية فقط', flags],
    ['targetType', 'وجهة التسوية', { PAYROLL_ENTRY: 'مستحق راتب', ADVANCE: 'سلفة', DEBT: 'دين', ADJUSTMENT: 'فرق راتب' }],
  ],
  payments: [
    ['method', 'طريقة الدفع', { CASH: 'نقدي', BANK_TRANSFER: 'تحويل بنكي', E_WALLET: 'محفظة إلكترونية' }],
    ['type', 'النوع', { ALL: 'كل الأنواع', SALARY_PAYMENT: 'دفعة راتب', ADVANCE_DISBURSEMENT: 'صرف سلفة' }],
    ['status', 'الحالة', { ALL: 'كل الحالات', POSTED: 'مسجّلة', REVERSED: 'معكوسة' }],
  ],
};

function visibleFilters(report: Report, view: string) {
  if (report !== 'financial') return filters[report];
  const keys = view === 'settlements' ? ['targetType'] : view === 'advances' || view === 'debts'
    ? ['accountStatus', 'outstandingOnly'] : ['periodStatus', 'outstandingOnly'];
  return filters.financial.filter(([key]) => keys.includes(key));
}

function display(value: Value | undefined, type: Kind, result: Result, labels?: Record<string, string>) {
  if (value == null || value === '') return '—';
  if (type === 'money') return `${value} ${result.currency}`;
  if (type === 'minutes') return formatDuration(Number(value));
  if (type === 'datetime') return formatDateTime(String(value), result.timezone);
  if (typeof value === 'number') return formatNumber(value);
  return labels?.[value] ?? value;
}

function Choice({ label, value, choices, onChange, empty }: {
  label: string; value: string; choices: Record<string, string>; onChange: (value: string) => void; empty?: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {empty && <option value="">{empty}</option>}
        {Object.entries(choices).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </Select>
    </label>
  );
}

export function ReportsHub({ employeeId }: { employeeId?: string }) {
  const { user } = useAuth();
  const allowed = (Object.keys(reports) as Report[]).filter((report) => can(user, `reports.${report}`));
  const [current, setCurrent] = useState<Report>();
  const selected = current && allowed.includes(current) ? current : allowed[0];
  if (!allowed.length) return <p className="text-muted">لا تملك صلاحية عرض التقارير.</p>;
  return (
    <div className="space-y-4">
      {!employeeId && <PageHeader title="التقارير" />}
      <nav aria-label="أنواع التقارير" className="flex flex-wrap gap-2">
        {allowed.map((report) => employeeId ? (
          <Button key={report} variant={selected === report ? 'primary' : 'secondary'} onClick={() => setCurrent(report)}>{reports[report]}</Button>
        ) : (
          <Link key={report} href={`/reports/${report}`} className="rounded-xl border border-line bg-surface px-4 py-3 font-medium hover:bg-subtle">{reports[report]}</Link>
        ))}
      </nav>
      {employeeId && selected && <ReportPanel key={`${employeeId}-${selected}`} report={selected} employeeId={employeeId} />}
    </div>
  );
}

export function ReportPage({ report }: { report: Report }) {
  const { user } = useAuth();
  if (!can(user, `reports.${report}`)) return <p className="text-muted">لا تملك صلاحية عرض هذا التقرير.</p>;
  return (
    <>
      <Link href="/reports" className="mb-3 inline-block text-sm text-muted underline">جميع التقارير</Link>
      <PageHeader title={reports[report]} />
      <ReportPanel key={report} report={report} />
    </>
  );
}

function ReportPanel({ report, employeeId }: { report: Report; employeeId?: string }) {
  const { user } = useAuth();
  const [state, setState, reset] = usePersistedState<Record<string, string>>(
    `reports:${user?.id}:${report}:${employeeId ?? 'all'}`, {},
  );
  const [page, setPage] = useState(1);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [options, setOptions] = useState<Options>();
  const [optionsError, setOptionsError] = useState('');
  const [result, setResult] = useState<{ query: string; data: Result }>();
  const [failure, setFailure] = useState<{ query: string; message: string }>();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [columnsOpen, setColumnsOpen] = useState(false);
  const search = useDebounced(state.search ?? '');
  const lookup = useDebounced(employeeSearch);
  const view = state.view || Object.keys(views[report])[0];
  const active = visibleFilters(report, view);
  const columnKey = `columns:${view}`;
  const savedEmployeeId = state.employeeId || '';
  const update = (key: string, value: string) => {
    setState((old) => ({ ...old, [key]: value }));
    setPage(1);
    setExportError('');
  };

  useEffect(() => {
    if (employeeId) return;
    let live = true;
    const optionQuery = new URLSearchParams({ search: lookup, selectedId: savedEmployeeId });
    api.get<Options>(`/reports/options?${optionQuery}`).then(
      (data) => { if (live) { setOptions(data); setOptionsError(''); } },
      (error: unknown) => { if (live) setOptionsError(errorMessage(error)); },
    );
    return () => { live = false; };
  }, [employeeId, lookup, savedEmployeeId]);

  const params = new URLSearchParams({ view, page: String(page) });
  const selectedEmployee = employeeId || (state.scope === 'employee' ? state.employeeId : '');
  const selectedDepartment = !employeeId && state.scope === 'department' ? state.departmentId : '';
  const incomplete = !employeeId && ((state.scope === 'employee' && !selectedEmployee) || (state.scope === 'department' && !selectedDepartment));
  for (const [key, value] of [
    ['from', state.from], ['to', state.to], ['search', search], ['sortDir', state.sortDir],
    ['columns', state[columnKey]], ['employeeId', selectedEmployee], ['departmentId', selectedDepartment || ''],
    ...active.map(([key]) => [key, state[key]]),
  ]) if (value) params.set(key, value);
  const query = params.toString();

  useEffect(() => {
    if (incomplete) return;
    let live = true;
    setFailure(undefined);
    api.get<Result>(`/reports/${report}?${query}`).then(
      (data) => { if (live) setResult({ query, data }); },
      (error: unknown) => { if (live) setFailure({ query, message: errorMessage(error) }); },
    );
    return () => { live = false; };
  }, [incomplete, report, query]);

  const data = !incomplete && result?.query === query ? result.data : undefined;
  const error = failure?.query === query ? failure.message : '';
  async function download(format: 'pdf' | 'xlsx') {
    setExportError('');
    setExporting(true);
    try {
      const response = await fetch(`/api/reports/${report}?${query}&format=${format}`, { cache: 'no-store' });
      if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null));
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = href;
      link.download = response.headers.get('Content-Disposition')?.match(/filename="([\w.-]+)"/)?.[1] ?? `${report}.${format}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (cause) {
      setExportError(errorMessage(cause));
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="space-y-4">
      <Card className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Choice label="طريقة العرض" value={view} choices={views[report]} onChange={(value) => update('view', value)} />
          {!employeeId && <Choice label="النطاق" value={state.scope || 'all'} choices={{ all: 'الجميع', employee: 'موظف واحد', department: 'قسم واحد' }} onChange={(value) => update('scope', value)} />}
          {!employeeId && state.scope === 'employee' && <>
            <label className="grid gap-1 text-sm">البحث عن موظف<Input value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} /></label>
            <Choice label="الموظف" value={savedEmployeeId} empty="اختر موظفًا"
              choices={Object.fromEntries((options?.employees ?? []).map((e) => [e.id, `${e.fullName} (${e.code})`]))}
              onChange={(value) => update('employeeId', value)} />
          </>}
          {!employeeId && state.scope === 'department' && <Choice label="القسم" value={state.departmentId || ''} empty="اختر قسمًا" choices={Object.fromEntries((options?.departments ?? []).map((d) => [d.id, d.name]))} onChange={(value) => update('departmentId', value)} />}
          <label className="grid gap-1 text-sm">من تاريخ<Input dir="ltr" type="date" value={state.from || ''} onChange={(e) => update('from', e.target.value)} /></label>
          <label className="grid gap-1 text-sm">إلى تاريخ<Input dir="ltr" type="date" value={state.to || ''} onChange={(e) => update('to', e.target.value)} /></label>
          <label className="grid gap-1 text-sm">بحث في النتائج<Input value={state.search || ''} maxLength={100} onChange={(e) => update('search', e.target.value)} /></label>
          <Choice label="الترتيب" value={state.sortDir || ''} empty="الافتراضي" choices={{ asc: 'تصاعدي', desc: 'تنازلي' }} onChange={(value) => update('sortDir', value)} />
          {active.map(([key, label, choices]) => <Choice key={key} label={label} value={state[key] || ''} empty="الافتراضي" choices={choices} onChange={(value) => update(key, value)} />)}
        </div>
        {optionsError && <p role="alert" className="text-danger-600">{optionsError}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => { reset(); setPage(1); setEmployeeSearch(''); setExportError(''); }}>مسح الفلاتر</Button>
          <Button variant="secondary" disabled={!data || exporting || search !== (state.search ?? '')} onClick={() => void download('xlsx')}>تصدير Excel</Button>
          <Button variant="secondary" disabled={!data || exporting || search !== (state.search ?? '')} onClick={() => void download('pdf')}>تصدير PDF</Button>
          {exporting && <span role="status">جارٍ تجهيز الملف…</span>}
        </div>
        {exportError && <p role="alert" className="text-danger-600">{exportError}</p>}
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
      {incomplete && <p className="text-muted">اختر الموظف أو القسم لعرض التقرير.</p>}
      {!incomplete && !data && !error && <p role="status" className="flex gap-2"><Spinner /> جارٍ تحميل التقرير…</p>}
      {data && <>
        <Card className="space-y-3 p-4">
          <p className="text-sm text-muted">الفترة <bdi>{data.range.from}</bdi> إلى <bdi>{data.range.to}</bdi> · {data.timezone}</p>
          <details open={columnsOpen} onToggle={(event) => setColumnsOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer font-medium">اختيار الأعمدة</summary>
            <div className="mt-3 flex flex-wrap gap-3">
              {data.availableColumns.map((column) => {
                const selected = data.columns.map((c) => c.key);
                const checked = selected.includes(column.key);
                return <label key={column.key} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={checked} disabled={checked && selected.length === 1} onChange={() => {
                    update(columnKey, (checked ? selected.filter((key) => key !== column.key) : [...selected, column.key]).join(','));
                  }} />
                  {column.label}
                </label>;
              })}
            </div>
          </details>
        </Card>
        <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[...data.columns.filter((c) => Object.hasOwn(data.totals, c.key)).map((c) => ({ ...c, label: `إجمالي ${c.label}`, value: data.totals[c.key] })), ...data.summary].map((item) => (
            <Card key={item.key} className="p-3"><dt className="text-sm text-muted">{item.label}</dt><dd className="font-semibold"><bdi>{display(item.value, item.type, data, item.labels)}</bdi></dd></Card>
          ))}
        </dl>
        {data.charts.map((chart) => <Chart key={chart.title} chart={chart} data={data} />)}
        <Card className="overflow-hidden">
          {data.items.length === 0 && <p className="p-4 text-muted">لا توجد نتائج مطابقة.</p>}
          {data.items.length > 0 && <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-start text-sm">
                <thead className="bg-subtle"><tr>{data.columns.map((column) => <th key={column.key} scope="col" className="whitespace-nowrap p-3 text-start">{column.label}</th>)}</tr></thead>
                <tbody>{data.items.map((row, index) => <tr key={String(row.id ?? index)} className="border-t border-line">
                  {data.columns.map((column) => <td key={column.key} className="min-w-24 p-3"><bdi>{display(row[column.key], column.type, data, column.labels)}</bdi></td>)}
                </tr>)}</tbody>
              </table>
            </div>
            <div className="divide-y divide-line md:hidden">{data.items.map((row, index) => <dl key={String(row.id ?? index)} className="grid grid-cols-2 gap-3 p-4">
              {data.columns.map((column) => <div key={column.key} className="break-words"><dt className="text-xs text-muted">{column.label}</dt><dd><bdi>{display(row[column.key], column.type, data, column.labels)}</bdi></dd></div>)}
            </dl>)}</div>
          </>}
          <Pagination page={page} totalPages={Math.max(1, data.totalPages)} total={data.total} onChange={setPage} />
        </Card>
        {data.notes.map((note) => <p key={note} className="text-sm text-muted">{note}</p>)}
      </>}
    </section>
  );
}

function Chart({ chart, data }: { chart: Result['charts'][number]; data: Result }) {
  const scale = Math.max(1, ...chart.points.map((point) => Math.abs(Number(point.value))));
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">{chart.title}</h2>
      <ul className="space-y-2">{chart.points.map((point, index) => (
        <li key={`${point.label}-${index}`} className="grid grid-cols-[minmax(5rem,2fr)_minmax(3rem,4fr)_auto] items-center gap-2 text-sm">
          <bdi className="break-words">{point.label}</bdi>
          <svg aria-hidden="true" className="h-3 w-full rounded bg-subtle text-brand-600 dark:text-brand-300" viewBox="0 0 100 8" preserveAspectRatio="none">
            <rect x={100 - Math.abs(Number(point.value)) / scale * 100} width={Math.abs(Number(point.value)) / scale * 100} height="8" fill="currentColor" />
          </svg>
          <bdi>{display(point.value, chart.unit, data)}</bdi>
        </li>
      ))}</ul>
    </Card>
  );
}
