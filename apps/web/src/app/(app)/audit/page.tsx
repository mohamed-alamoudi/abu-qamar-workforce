'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Input, Select, Spinner } from '@abu-qamar/ui';
import { AdminOnlyPage, PageHeader, Pagination } from '@/components/page';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { api, errorMessage, toQuery } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { AuditLogItem, Paginated } from '@/lib/types';

const ACTION_LABELS: Record<string, string> = {
  'auth.setup_admin': 'إنشاء الأدمن الأول',
  'auth.setup_rejected': 'محاولة إعداد مرفوضة',
  'auth.login': 'تسجيل دخول',
  'auth.logout': 'تسجيل خروج',
  'auth.login_locked': 'حظر محاولات الدخول',
  'auth.reauth': 'تأكيد كلمة المرور',
  'auth.password_changed': 'تغيير كلمة المرور',
  'auth.session_revoked': 'إلغاء جلسة',
  'auth.2fa_enabled': 'تفعيل المصادقة الثنائية',
  'auth.2fa_disabled': 'تعطيل المصادقة الثنائية',
  'user.created': 'إنشاء مراقب',
  'user.updated': 'تعديل مستخدم',
  'user.enabled': 'تفعيل حساب',
  'user.disabled': 'تعطيل حساب',
  'user.permissions_changed': 'تغيير الصلاحيات',
  'user.password_reset': 'إعادة تعيين كلمة مرور',
  'user.sessions_revoked': 'إلغاء جلسات مستخدم',
  'settings.updated': 'تعديل الإعدادات',
};

const CATEGORY_OPTIONS = [
  { value: '', label: 'كل الأحداث' },
  { value: 'auth.', label: 'الدخول والجلسات' },
  { value: 'user.', label: 'المستخدمون والصلاحيات' },
  { value: 'settings.', label: 'الإعدادات' },
];

const DEFAULT_FILTERS = { action: '', from: '', to: '' };

/** تاريخ محلي (YYYY-MM-DD) → بداية/نهاية اليوم بصيغة ISO. */
function dayBoundary(date: string, end: boolean): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T${end ? '23:59:59.999' : '00:00:00.000'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function ChangeDetails({ log }: { log: AuditLogItem }) {
  const sections: [string, unknown][] = [
    ['القيمة القديمة', log.before],
    ['القيمة الجديدة', log.after],
    ['تفاصيل', log.metadata],
  ];
  const visible = sections.filter(([, v]) => v !== null && v !== undefined);
  if (visible.length === 0) return <span className="text-xs text-muted">—</span>;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-medium text-brand-600 dark:text-brand-300">عرض التغيير</summary>
      <div className="mt-2 grid gap-2">
        {visible.map(([label, value]) => (
          <div key={label}>
            <p className="mb-1 text-muted">{label}</p>
            <pre dir="ltr" className="max-w-full overflow-x-auto rounded-md bg-subtle p-2 text-start">
              {JSON.stringify(value, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function AuditLog() {
  const [filters, setFilters, resetFilters] = usePersistedState('aq-audit-filters', DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<AuditLogItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = toQuery({
        page,
        pageSize: 25,
        action: filters.action,
        from: dayBoundary(filters.from, false),
        to: dayBoundary(filters.to, true),
      });
      setData(await api.get<Paginated<AuditLogItem>>(`/audit-logs${query}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => setPage(1), [filters]);

  const hasFilters = filters.action !== '' || filters.from !== '' || filters.to !== '';

  return (
    <>
      <PageHeader title="سجل التدقيق" description="سجل دائم للأحداث الحساسة — لا يمكن تعديله أو حذفه." />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="w-52">
            <Select label="نوع الحدث" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-44">
            <Input label="من تاريخ" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </div>
          <div className="w-44">
            <Input label="إلى تاريخ" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </div>
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
          <p className="p-10 text-center text-sm text-muted">لا توجد أحداث مطابقة</p>
        ) : (
          data && (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs text-muted">
                      <th className="px-4 py-3 text-start font-medium">الوقت</th>
                      <th className="px-4 py-3 text-start font-medium">المستخدم</th>
                      <th className="px-4 py-3 text-start font-medium">الحدث</th>
                      <th className="px-4 py-3 text-start font-medium">العنوان</th>
                      <th className="px-4 py-3 text-start font-medium">التغيير</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.items.map((log) => (
                      <tr key={log.id} className="align-top">
                        <td className="tabular whitespace-nowrap px-4 py-3 text-muted">{formatDateTime(log.createdAt)}</td>
                        <td className="px-4 py-3" dir="ltr">
                          {log.actorUsername ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone="brand">{ACTION_LABELS[log.action] ?? log.action}</Badge>
                        </td>
                        <td className="tabular px-4 py-3 text-muted" dir="ltr">
                          {log.ip ?? '—'}
                        </td>
                        <td className="max-w-xs px-4 py-3">
                          <ChangeDetails log={log} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-line md:hidden">
                {data.items.map((log) => (
                  <li key={log.id} className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <Badge tone="brand">{ACTION_LABELS[log.action] ?? log.action}</Badge>
                      <span className="tabular text-xs text-muted">{formatDateTime(log.createdAt)}</span>
                    </div>
                    <p className="text-sm">
                      <span className="text-muted">المستخدم: </span>
                      <span dir="ltr">{log.actorUsername ?? '—'}</span>
                    </p>
                    <ChangeDetails log={log} />
                  </li>
                ))}
              </ul>
              <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
            </>
          )
        )}
      </Card>
    </>
  );
}

export default function AuditPage() {
  return (
    <AdminOnlyPage>
      <AuditLog />
    </AdminOnlyPage>
  );
}
