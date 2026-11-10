'use client';

import { ChevronLeft, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { can } from '@abu-qamar/shared';
import { Alert, Button, Card, Input, Modal, Select, Spinner } from '@abu-qamar/ui';
import { PageHeader, Pagination } from '@/components/page';
import { EmployeeStatusBadge, PayCell } from '@/features/employees/badges';
import { buildPayPayload, EMPTY_PAY_FORM, PAY_TYPE_LABELS, PayFields, type PayFormState } from '@/features/employees/pay';
import { useDebounced, usePersistedState } from '@/hooks/use-persisted-state';
import { useSettings } from '@/hooks/use-settings';
import { api, errorMessage, toQuery } from '@/lib/api';
import type { Department, Employee, Paginated, PayType } from '@/lib/types';
import { useAuth } from '@/providers/auth-provider';

const DEFAULT_FILTERS = { search: '', departmentId: '', status: 'ACTIVE' as '' | 'ACTIVE' | 'INACTIVE', payType: '' as '' | PayType };

function CreateEmployeeModal({
  open,
  departments,
  isAdmin,
  currency,
  onClose,
  onCreated,
}: {
  open: boolean;
  departments: Department[];
  isAdmin: boolean;
  currency: string;
  onClose: () => void;
  onCreated: (employee: Employee) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [pay, setPay] = useState<PayFormState>(EMPTY_PAY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFullName('');
      setPhone('');
      setDepartmentId('');
      setPay(EMPTY_PAY_FORM);
      setError(null);
    }
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (fullName.trim().length < 2) return setError('أدخل الاسم الكامل');
    if (!departmentId) return setError('اختر القسم');
    const body: Record<string, unknown> = { fullName, phone, departmentId };
    if (isAdmin) {
      const built = buildPayPayload(pay);
      if ('error' in built) return setError(built.error);
      body.pay = built.pay;
      body.policy = built.policy;
    }
    setBusy(true);
    try {
      onCreated(await api.post<Employee>('/employees', body));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="إضافة موظف" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-5" noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="الاسم الكامل" required autoFocus value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <Input label="رقم الهاتف" type="tel" dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} hint="اختياري" />
          <Select label="القسم" required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">— اختر القسم —</option>
            {departments
              .filter((d) => d.isActive)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </Select>
        </div>
        {isAdmin ? (
          <fieldset className="rounded-lg border border-line p-4">
            <legend className="px-1 text-sm font-semibold">الأجر</legend>
            <PayFields value={pay} onChange={setPay} currency={currency} />
          </fieldset>
        ) : (
          <Alert tone="brand">الكود يُولَّد تلقائيًا. نوع الأجر وقيمته يحددهما الأدمن بعد الإضافة.</Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" loading={busy}>
            إضافة الموظف
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function EmployeesPage() {
  const router = useRouter();
  const { user } = useAuth();
  const settings = useSettings();
  const currency = settings['general.currency'];
  const canCreate = can(user, 'employees.create');
  const canSeePay = can(user, 'finance.view');

  const [filters, setFilters, resetFilters] = usePersistedState('aq-employees-filters', DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const search = useDebounced(filters.search);
  const [data, setData] = useState<Paginated<Employee> | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    api
      .get<Department[]>('/departments')
      .then(setDepartments)
      .catch(() => undefined);
    // فتح نافذة الإضافة مباشرة من الإجراء السريع في لوحة التحكم
    if (new URLSearchParams(window.location.search).get('new') === '1') setCreateOpen(true);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = toQuery({
        page,
        pageSize: 20,
        search,
        departmentId: filters.departmentId,
        status: filters.status,
        payType: canSeePay ? filters.payType : '',
      });
      setData(await api.get<Paginated<Employee>>(`/employees${query}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, search, filters.departmentId, filters.status, filters.payType, canSeePay]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setPage(1), [search, filters.departmentId, filters.status, filters.payType]);

  const hasFilters = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  return (
    <>
      <PageHeader
        title="الموظفون"
        description="إضافة الموظفين وإدارة بياناتهم وأقسامهم وأجورهم."
        actions={
          canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <UserPlus className="size-4" />
              إضافة موظف
            </Button>
          )
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="min-w-48 flex-1">
            <Input
              label="بحث"
              type="search"
              placeholder="الاسم أو الكود أو الهاتف"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            />
          </div>
          <div className="w-44">
            <Select label="القسم" value={filters.departmentId} onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })}>
              <option value="">كل الأقسام</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-36">
            <Select label="الحالة" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as typeof filters.status })}>
              <option value="">الكل</option>
              <option value="ACTIVE">نشط</option>
              <option value="INACTIVE">متوقف</option>
            </Select>
          </div>
          {canSeePay && (
            <div className="w-36">
              <Select label="نوع الأجر" value={filters.payType} onChange={(e) => setFilters({ ...filters, payType: e.target.value as typeof filters.payType })}>
                <option value="">الكل</option>
                {(Object.keys(PAY_TYPE_LABELS) as PayType[]).map((t) => (
                  <option key={t} value={t}>
                    {PAY_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {hasFilters && (
            <Button variant="ghost" onClick={resetFilters}>
              مسح الفلاتر
            </Button>
          )}
        </div>

        {error && <Alert className="m-4">{error}</Alert>}
        {loading && !data ? (
          <div className="flex justify-center p-10 text-brand-600">
            <Spinner className="size-7" />
          </div>
        ) : data && data.items.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted">{hasFilters ? 'لا يوجد موظفون مطابقون للفلاتر' : 'لا يوجد موظفون بعد'}</p>
        ) : (
          data && (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs text-muted">
                      <th className="px-4 py-3 text-start font-medium">الكود</th>
                      <th className="px-4 py-3 text-start font-medium">الاسم</th>
                      <th className="px-4 py-3 text-start font-medium">القسم</th>
                      <th className="px-4 py-3 text-start font-medium">الهاتف</th>
                      <th className="px-4 py-3 text-start font-medium">الأجر</th>
                      <th className="px-4 py-3 text-start font-medium">الحالة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.items.map((e) => (
                      <tr key={e.id} className="cursor-pointer hover:bg-subtle" onClick={() => router.push(`/employees/${e.id}`)}>
                        <td className="tabular px-4 py-3 text-muted" dir="ltr">
                          {e.code}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          <Link href={`/employees/${e.id}`} className="hover:underline" onClick={(ev) => ev.stopPropagation()}>
                            {e.fullName}
                          </Link>
                        </td>
                        <td className="px-4 py-3">{e.department.name}</td>
                        <td className="tabular px-4 py-3 text-muted" dir="ltr">
                          {e.phone ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          <PayCell employee={e} currency={currency} />
                        </td>
                        <td className="px-4 py-3">
                          <EmployeeStatusBadge status={e.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-line md:hidden">
                {data.items.map((e) => (
                  <li key={e.id}>
                    <Link href={`/employees/${e.id}`} className="flex items-center gap-3 p-4 active:bg-subtle">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{e.fullName}</p>
                          <EmployeeStatusBadge status={e.status} />
                        </div>
                        <p className="text-xs text-muted">
                          <span dir="ltr">{e.code}</span> · {e.department.name}
                        </p>
                        <p className="text-sm">
                          <PayCell employee={e} currency={currency} />
                        </p>
                      </div>
                      <ChevronLeft className="size-5 shrink-0 text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
              <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
            </>
          )
        )}
      </Card>

      <CreateEmployeeModal
        open={createOpen}
        departments={departments}
        isAdmin={user?.role === 'ADMIN'}
        currency={currency}
        onClose={() => setCreateOpen(false)}
        onCreated={(employee) => router.push(`/employees/${employee.id}`)}
      />
    </>
  );
}
