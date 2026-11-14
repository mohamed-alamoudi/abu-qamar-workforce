'use client';

import { ArrowRight, Lock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { can } from '@abu-qamar/shared';
import { Alert, Badge, Button, Card, cn, Input, Modal, Select, Spinner } from '@abu-qamar/ui';
import { EmployeeStatusBadge, PayCell } from '@/features/employees/badges';
import {
  buildPayPayload,
  buildPolicyPayload,
  describePolicy,
  EMPTY_PAY_FORM,
  PAY_TYPE_LABELS,
  PAY_UNIT_LABELS,
  PayFields,
  type PayFormState,
} from '@/features/employees/pay';
import { useSettings } from '@/hooks/use-settings';
import { ReportsHub } from '@/features/reports/reports';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import type { Department, DepartmentHistoryRow, Employee, EmployeeChange, PayHistory } from '@/lib/types';
import { AttendancePanel } from '@/features/attendance/attendance';
import { EmployeeBalances } from '@/features/finance/employee-balances';
import { useAuth } from '@/providers/auth-provider';

const TABS = [
  { id: 'basic', label: 'البيانات الأساسية' },
  { id: 'attendance', label: 'الحضور والانصراف' },
  { id: 'finance', label: 'الحساب المالي' },
  { id: 'reports', label: 'التقارير' },
  { id: 'history', label: 'سجل التغييرات' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const dateRange = (from: string, to: string | null) => (
  <span className="tabular" dir="ltr">
    {from} → {to ?? 'الآن'}
  </span>
);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{children}</dd>
    </div>
  );
}

/** نافذة بنموذج بسيط: تعرض الخطأ وتُغلق عند النجاح. */
function ActionModal({
  open,
  title,
  submitLabel,
  danger,
  wide,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  danger?: boolean;
  wide?: boolean;
  onClose: () => void;
  /** يعيد رسالة خطأ للتحقق المحلي، أو لا شيء عند النجاح */
  onSubmit: () => Promise<string | void>;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const problem = await onSubmit();
      if (problem) setError(problem);
      else onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={title} onClose={onClose} wide={wide}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        {children}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────── تبويب البيانات الأساسية ─────────────────────────────

function BasicTab({ employee, currency, onChanged }: { employee: Employee; currency: string; onChanged: (e: Employee) => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const canUpdate = can(user, 'employees.update');
  const [modal, setModal] = useState<'edit' | 'transfer' | 'deactivate' | 'reactivate' | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [history, setHistory] = useState<DepartmentHistoryRow[] | null>(null);
  const [fullName, setFullName] = useState(employee.fullName);
  const [phone, setPhone] = useState(employee.phone ?? '');
  const [departmentId, setDepartmentId] = useState('');
  const [date, setDate] = useState('');

  const loadHistory = useCallback(() => {
    api
      .get<DepartmentHistoryRow[]>(`/employees/${employee.id}/department-history`)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [employee.id]);

  useEffect(() => {
    loadHistory();
    api
      .get<Department[]>('/departments')
      .then(setDepartments)
      .catch(() => undefined);
  }, [loadHistory]);

  const open = (which: NonNullable<typeof modal>) => {
    setFullName(employee.fullName);
    setPhone(employee.phone ?? '');
    setDepartmentId('');
    setDate('');
    setModal(which);
  };
  const done = (updated: Employee) => {
    onChanged(updated);
    loadHistory();
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="كود الموظف">
            <span dir="ltr" className="tabular">
              {employee.code}
            </span>
          </Field>
          <Field label="الاسم الكامل">{employee.fullName}</Field>
          <Field label="رقم الهاتف">
            <span dir="ltr" className="tabular">
              {employee.phone ?? '—'}
            </span>
          </Field>
          <Field label="القسم الحالي">{employee.department.name}</Field>
          <Field label="الحالة">
            <EmployeeStatusBadge status={employee.status} />
          </Field>
          {employee.terminationDate && (
            <Field label="تاريخ إنهاء العمل">
              <span dir="ltr" className="tabular">
                {employee.terminationDate}
              </span>
            </Field>
          )}
          <Field label="الأجر الحالي">
            <PayCell employee={employee} currency={currency} />
          </Field>
          <Field label="تاريخ إنشاء السجل">{formatDateTime(employee.createdAt)}</Field>
          <Field label="آخر تحديث">{formatDateTime(employee.updatedAt)}</Field>
        </dl>
        {(canUpdate || isAdmin) && (
          <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
            {canUpdate && (
              <>
                <Button variant="secondary" onClick={() => open('edit')}>
                  تعديل البيانات
                </Button>
                <Button variant="secondary" onClick={() => open('transfer')}>
                  نقل إلى قسم آخر
                </Button>
              </>
            )}
            {isAdmin &&
              (employee.status === 'ACTIVE' ? (
                <Button variant="danger" onClick={() => open('deactivate')}>
                  إيقاف الموظف
                </Button>
              ) : (
                <Button onClick={() => open('reactivate')}>إعادة التفعيل</Button>
              ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold">تاريخ الأقسام</h2>
        {!history ? (
          <div className="flex justify-center p-6 text-brand-600">
            <Spinner />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {history.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="font-medium">
                  {row.department.name} {row.effectiveTo === null && <Badge tone="brand">الحالي</Badge>}
                </span>
                <span className="text-muted">{dateRange(row.effectiveFrom, row.effectiveTo)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ActionModal
        open={modal === 'edit'}
        title="تعديل بيانات الموظف"
        submitLabel="حفظ"
        onClose={() => setModal(null)}
        onSubmit={async () => {
          if (fullName.trim().length < 2) return 'أدخل الاسم الكامل';
          done(await api.patch<Employee>(`/employees/${employee.id}`, { version: employee.version, fullName, phone }));
        }}
      >
        <Input label="الاسم الكامل" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <Input label="رقم الهاتف" type="tel" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </ActionModal>

      <ActionModal
        open={modal === 'transfer'}
        title="نقل الموظف إلى قسم آخر"
        submitLabel="نقل"
        onClose={() => setModal(null)}
        onSubmit={async () => {
          if (!departmentId) return 'اختر القسم الجديد';
          done(await api.post<Employee>(`/employees/${employee.id}/transfer`, { departmentId, ...(date ? { effectiveFrom: date } : {}) }));
        }}
      >
        <p className="text-sm text-muted">القسم الحالي: {employee.department.name}. يُحفظ تاريخ الانتقال في سجل الأقسام.</p>
        <Select label="القسم الجديد" required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">— اختر القسم —</option>
          {departments
            .filter((d) => d.isActive && d.id !== employee.department.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </Select>
        <Input label="تاريخ الانتقال" type="date" hint="اتركه فارغًا ليكون اليوم" value={date} onChange={(e) => setDate(e.target.value)} />
      </ActionModal>

      <ActionModal
        open={modal === 'deactivate'}
        title="إيقاف الموظف"
        submitLabel="إيقاف"
        danger
        onClose={() => setModal(null)}
        onSubmit={async () => {
          done(await api.post<Employee>(`/employees/${employee.id}/deactivate`, date ? { terminationDate: date } : {}));
        }}
      >
        <p className="text-sm">
          سيُوقف «{employee.fullName}» عن العمل. <strong>لا يُحذف أي من سجلاته</strong> (الدوام، الأجور، المستحقات) ويمكن إعادة تفعيله لاحقًا.
        </p>
        <Input label="تاريخ إنهاء العمل" type="date" hint="اتركه فارغًا ليكون اليوم" value={date} onChange={(e) => setDate(e.target.value)} />
      </ActionModal>

      <ActionModal
        open={modal === 'reactivate'}
        title="إعادة تفعيل الموظف"
        submitLabel="تفعيل"
        onClose={() => setModal(null)}
        onSubmit={async () => {
          done(await api.post<Employee>(`/employees/${employee.id}/reactivate`));
        }}
      >
        <p className="text-sm">سيعود «{employee.fullName}» موظفًا نشطًا ويُمسح تاريخ إنهاء العمل.</p>
      </ActionModal>
    </div>
  );
}

// ───────────────────────────── تبويب الحساب المالي ─────────────────────────────

function FinanceTab({ employee, currency, onChanged }: { employee: Employee; currency: string; onChanged: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [history, setHistory] = useState<PayHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<'rate' | 'policy' | null>(null);
  const [refreshUnpaidPeriods, setRefreshUnpaidPeriods] = useState(false);
  const [form, setForm] = useState<PayFormState>(EMPTY_PAY_FORM);

  const load = useCallback(() => {
    api
      .get<PayHistory>(`/employees/${employee.id}/pay`)
      .then(setHistory)
      .catch((e) => setError(errorMessage(e)));
  }, [employee.id]);

  useEffect(() => {
    if (employee.payVisible) load();
  }, [employee.payVisible, load]);

  if (!employee.payVisible) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <Lock className="size-9 text-muted" />
        <p className="text-sm text-muted">لا تملك صلاحية عرض المعلومات المالية.</p>
      </Card>
    );
  }

  const currentPolicy = history?.policies.find((p) => p.effectiveTo === null) ?? null;
  const openModal = (which: 'rate' | 'policy') => {
    setRefreshUnpaidPeriods(false);
    setForm({
      ...EMPTY_PAY_FORM,
      payType: employee.currentPay?.payType ?? 'HOURLY',
      amount: which === 'rate' ? (employee.currentPay?.amount ?? '') : '',
      payrollFrequency: currentPolicy?.payrollFrequency ?? 'MONTHLY',
      dailyPayMode: currentPolicy?.dailyPayMode ?? '',
      referenceDailyHours: currentPolicy?.referenceDailyHours?.toString() ?? '',
      absenceDeductionMethod: currentPolicy?.absenceDeductionMethod ?? '',
      fixedMonthDays: currentPolicy?.fixedMonthDays?.toString() ?? '',
    });
    setModal(which);
  };
  const applied = (next: PayHistory) => {
    setHistory(next);
    onChanged();
  };

  return (
    <div className="space-y-5">
      {error && <Alert>{error}</Alert>}
      <EmployeeBalances employeeId={employee.id} currency={currency} />
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">الأجر الحالي</h2>
            <p className="mt-2 text-2xl font-bold">
              <PayCell employee={employee} currency={currency} />
            </p>
            {employee.currentPay && (
              <p className="mt-1 text-sm text-muted">
                {PAY_TYPE_LABELS[employee.currentPay.payType]} · ساري منذ <span dir="ltr">{employee.currentPay.effectiveFrom}</span>
              </p>
            )}
            {currentPolicy && <p className="mt-1 text-sm text-muted">{describePolicy(currentPolicy)}</p>}
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => openModal('rate')}>{employee.currentPay ? 'تغيير الأجر' : 'تحديد الأجر'}</Button>
              {employee.currentPay && (
                <Button variant="secondary" onClick={() => openModal('policy')}>
                  تغيير سياسة الاحتساب
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold">تاريخ الأجور</h2>
        {!history ? (
          <div className="flex justify-center p-6 text-brand-600">
            <Spinner />
          </div>
        ) : history.rates.length === 0 ? (
          <p className="mt-3 text-sm text-muted">لم يُحدَّد أجر لهذا الموظف بعد.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {history.rates.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="tabular font-medium">
                  {formatMoney(r.amount, currency)} <span className="text-xs font-normal text-muted">{PAY_UNIT_LABELS[r.payType]}</span>{' '}
                  {r.effectiveTo === null && <Badge tone="brand">الحالي</Badge>}
                </span>
                <span className="text-muted">
                  {dateRange(r.effectiveFrom, r.effectiveTo)} · سجّله <span dir="ltr">{r.createdBy}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {history && history.policies.length > 0 && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">تاريخ سياسات الاحتساب</h2>
          <ul className="mt-3 divide-y divide-line">
            {history.policies.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="font-medium">{describePolicy(p)}</span>
                <span className="text-muted">{dateRange(p.effectiveFrom, p.effectiveTo)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}


      <ActionModal
        open={modal === 'rate'}
        title={employee.currentPay ? 'تغيير الأجر' : 'تحديد الأجر'}
        submitLabel="حفظ"
        wide
        onClose={() => setModal(null)}
        onSubmit={async () => {
          const built = buildPayPayload(form);
          if ('error' in built) return built.error;
          const policy: Record<string, unknown> = { ...built.policy };
          delete policy.effectiveFrom;
          // السياسة تُرسل فقط إن تغيّر نوع الأجر أو تغيّرت هي، حتى لا يُنشأ قيد سياسة مكرر مع كل تغيير للقيمة
          const same =
            currentPolicy !== null &&
            form.payType === employee.currentPay?.payType &&
            policy.payrollFrequency === currentPolicy.payrollFrequency &&
            (policy.dailyPayMode ?? null) === currentPolicy.dailyPayMode &&
            (policy.referenceDailyHours ?? null) === currentPolicy.referenceDailyHours &&
            (policy.absenceDeductionMethod ?? null) === currentPolicy.absenceDeductionMethod &&
            (policy.fixedMonthDays ?? null) === currentPolicy.fixedMonthDays;
          applied(await api.post<PayHistory>(`/employees/${employee.id}/pay-rates`, { ...built.pay, ...(same ? {} : { policy }), refreshUnpaidPeriods }));
        }}
      >
        <Alert tone="brand">
          الأجر الجديد يسري من تاريخه. إذا غطّى مستحقًا مغلقًا غير مصروف، يمكنك طلب تحديثه بعد الحفظ.
        </Alert>
        <PayFields value={form} onChange={setForm} currency={currency} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={refreshUnpaidPeriods} onChange={e => setRefreshUnpaidPeriods(e.target.checked)} />
          تطبيق الأجر على المستحقات غير المصروفة في الفترات المغلقة
        </label>
        {refreshUnpaidPeriods && <p className="text-sm text-muted">بعد الحفظ افتح فترة الرواتب واضغط «تحديث المستحقات غير المصروفة» قبل الصرف.</p>}
      </ActionModal>

      <ActionModal
        open={modal === 'policy'}
        title="تغيير سياسة الاحتساب"
        submitLabel="حفظ"
        wide
        onClose={() => setModal(null)}
        onSubmit={async () => {
          const built = buildPolicyPayload(form);
          if ('error' in built) return built.error;
          applied(await api.post<PayHistory>(`/employees/${employee.id}/pay-policies`, built.policy));
        }}
      >
        <PayFields value={form} onChange={setForm} currency={currency} policyOnly />
      </ActionModal>
    </div>
  );
}

// ───────────────────────────── تبويب سجل التغييرات ─────────────────────────────

const CHANGE_LABELS: Record<string, string> = {
  'employee.created': 'إضافة الموظف',
  'employee.updated': 'تعديل البيانات',
  'employee.transferred': 'نقل بين الأقسام',
  'employee.deactivated': 'إيقاف',
  'employee.reactivated': 'إعادة تفعيل',
  'employee.pay_rate_changed': 'تغيير الأجر',
  'employee.pay_policy_changed': 'تغيير سياسة الاحتساب',
};

const KEY_LABELS: Record<string, string> = {
  code: 'الكود',
  fullName: 'الاسم',
  phone: 'الهاتف',
  department: 'القسم',
  status: 'الحالة',
  terminationDate: 'تاريخ إنهاء العمل',
  effectiveFrom: 'تاريخ السريان',
  payType: 'نوع الأجر',
  amount: 'القيمة',
  payrollFrequency: 'دورة الرواتب',
  dailyPayMode: 'طريقة الأجر اليومي',
  referenceDailyHours: 'الساعات المرجعية',
  absenceDeductionMethod: 'خصم الغياب',
  fixedMonthDays: 'عدد الأيام الثابت',
};

const VALUE_LABELS: Record<string, string> = {
  ACTIVE: 'نشط',
  INACTIVE: 'متوقف',
  HOURLY: 'بالساعة',
  DAILY: 'باليوم',
  WEEKLY: 'أسبوعية',
  SEMI_MONTHLY: 'نصف شهرية',
  FULL: 'كامل',
  PROPORTIONAL: 'نسبي',
  ACTUAL_MONTH_DAYS: 'أيام الشهر الفعلية',
  FIXED_DAYS: 'عدد أيام ثابت',
  SCHEDULED_WORK_DAYS: 'أيام العمل المجدولة',
};

function describeValues(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (value === 'MONTHLY') return key === 'payType' ? 'بالشهر' : 'شهرية';
  return VALUE_LABELS[String(value)] ?? String(value);
}

function ChangeValues({ title, values }: { title: string; values: Record<string, unknown> | null }) {
  const entries = Object.entries(values ?? {}).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg bg-subtle p-3">
      <p className="mb-1.5 text-xs font-medium text-muted">{title}</p>
      <dl className="space-y-1 text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-wrap gap-x-2">
            <dt className="text-muted">{KEY_LABELS[key] ?? key}:</dt>
            <dd className="tabular font-medium">{describeValues(key, value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function HistoryTab({ employeeId, refreshKey }: { employeeId: string; refreshKey: number }) {
  const [changes, setChanges] = useState<EmployeeChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<EmployeeChange[]>(`/employees/${employeeId}/history`)
      .then(setChanges)
      .catch((e) => setError(errorMessage(e)));
  }, [employeeId, refreshKey]);

  if (error) return <Alert>{error}</Alert>;
  if (!changes) {
    return (
      <div className="flex justify-center p-10 text-brand-600">
        <Spinner className="size-7" />
      </div>
    );
  }
  return (
    <Card>
      <ul className="divide-y divide-line">
        {changes.map((change) => (
          <li key={change.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone="brand">{CHANGE_LABELS[change.action] ?? change.action}</Badge>
              <span className="tabular text-xs text-muted">
                {formatDateTime(change.createdAt)} · <span dir="ltr">{change.actorUsername ?? '—'}</span>
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ChangeValues title="القيمة القديمة" values={change.before} />
              <ChangeValues title="القيمة الجديدة" values={change.after} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ───────────────────────────── الصفحة ─────────────────────────────

export default function EmployeeProfilePage() {
  const { id } = useParams<{ id: string }>();
  const settings = useSettings();
  const currency = settings['general.currency'];
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('basic');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(() => {
    api
      .get<Employee>(`/employees/${id}`)
      .then(setEmployee)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  useEffect(() => {
    load();
    if (window.location.hash === '#finance') setTab('finance');
  }, [load]);

  const back = (
    <Link href="/employees" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline dark:text-brand-300">
      <ArrowRight className="size-4" />
      كل الموظفين
    </Link>
  );

  if (error) {
    return (
      <>
        {back}
        <Alert>{error}</Alert>
      </>
    );
  }
  if (!employee) {
    return (
      <div className="flex justify-center p-16 text-brand-600">
        <Spinner className="size-8" />
      </div>
    );
  }

  return (
    <>
      {back}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold sm:text-2xl">{employee.fullName}</h1>
        <EmployeeStatusBadge status={employee.status} />
        <span className="text-sm text-muted">
          <span dir="ltr" className="tabular">
            {employee.code}
          </span>{' '}
          · {employee.department.name}
        </span>
      </div>

      <div role="tablist" aria-label="ملف الموظف" className="mb-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px h-11 shrink-0 border-b-2 px-4 text-sm font-medium transition-colors',
              tab === t.id ? 'border-brand-600 text-brand-600 dark:text-brand-300' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'basic' && (
          <BasicTab
            employee={employee}
            currency={currency}
            onChanged={(e) => {
              setEmployee(e);
              setRefreshKey((k) => k + 1);
            }}
          />
        )}
        {tab === 'attendance' && <AttendancePanel employeeId={employee.id} quick={false} />}
        {tab === 'finance' && (
          <FinanceTab
            employee={employee}
            currency={currency}
            onChanged={() => {
              load();
              setRefreshKey((k) => k + 1);
            }}
          />
        )}
        {tab === 'reports' && <ReportsHub employeeId={employee.id} />}
        {tab === 'history' && <HistoryTab employeeId={employee.id} refreshKey={refreshKey} />}
      </div>
    </>
  );
}
