'use client';

import { BarChart3, Clock, HandCoins, Lock, LogIn, type LucideIcon, UserPlus, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { can, canAny, DASHBOARD_PERIODS, type DashboardPeriod } from '@abu-qamar/shared';
import { Alert, Card, cn } from '@abu-qamar/ui';
import { PageHeader } from '@/components/page';
import { useResource } from '@/features/attendance/shared';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { api, errorMessage } from '@/lib/api';
import { QUEUE_CHANGED, readQueue } from '@/lib/attendance-queue';
import { formatDate, formatDuration, formatMoney, formatNumber } from '@/lib/format';
import type { DashboardSummary } from '@/lib/types';
import { useAuth } from '@/providers/auth-provider';

const PERIOD_LABELS: Record<DashboardPeriod, string> = { day: 'اليوم', week: 'الأسبوع', month: 'الشهر' };

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  loading,
  note,
}: {
  label: string;
  value: string | null;
  icon: LucideIcon;
  tone: 'brand' | 'success' | 'danger';
  loading: boolean;
  note?: string;
}) {
  const tones = {
    brand: 'bg-brand-600/10 text-brand-600 dark:text-brand-300',
    success: 'bg-success-600/10 text-success-700',
    danger: 'bg-danger-600/10 text-danger-600',
  };
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted">{label}</p>
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', tones[tone])}>
          <Icon className="size-5" />
        </span>
      </div>
      <div className="mt-3 min-h-9">
        {loading ? (
          <div className="h-8 w-24 animate-pulse rounded bg-subtle" />
        ) : value === null ? (
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Lock className="size-4" />
            لا تملك صلاحية العرض
          </p>
        ) : (
          <p className="tabular text-2xl font-bold sm:text-3xl">{value}</p>
        )}
      </div>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </Card>
  );
}

function QuickAction({ href, label, icon: Icon }: { href: string; label: string; icon: LucideIcon }) {
  return (
    <Link
      href={href}
      className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border border-line bg-surface p-3 text-center text-sm font-medium shadow-sm transition-colors hover:border-brand-500 hover:bg-subtle"
    >
      <Icon className="size-7 text-brand-600 dark:text-brand-300" />
      {label}
    </Link>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [period, setPeriod] = usePersistedState<DashboardPeriod>('aq-dashboard-period', 'day');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncIssues, setSyncIssues] = useState(0);
  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    const refresh = () => void readQueue(user.id).then(items => {
      if (active) setSyncIssues(items.filter(item => item.state === 'FAILED' || item.state === 'CONFLICT').length);
    }).catch(() => {});
    refresh();
    window.addEventListener(QUEUE_CHANGED, refresh);
    return () => { active = false; window.removeEventListener(QUEUE_CHANGED, refresh); };
  }, [user?.id]);
  const openShifts = useResource<{ total: number; items: { id: string; missingCheckOut: boolean; employee: { fullName: string } }[] }>(
    canAny(user, ['attendance.view', 'attendance.check_in', 'attendance.check_out']) ? '/attendance/open?pageSize=20' : null);
  const reviewShifts = useResource<{ total: number }>(can(user, 'attendance.view')
    ? '/attendance?status=CLOSED&approvalStatus=IN_REVIEW&pageSize=1' : null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<DashboardSummary>(`/dashboard/summary?period=${period}`)
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const currency = summary?.currency ?? 'ILS';
  const rangeText = summary
    ? period === 'day'
      ? formatDate(summary.range.start, summary.timezone)
      : `${formatDate(summary.range.start, summary.timezone)} — ${formatDate(
          new Date(new Date(summary.range.end).getTime() - 1).toISOString(),
          summary.timezone,
        )}`
    : '';

  const actions = [
    { href: '/attendance#quick-check-in', label: 'سجّل الدوام', icon: LogIn,
      show: canAny(user, ['attendance.check_in', 'attendance.check_out', 'attendance.correct']) },
    { href: '/employees?new=1', label: 'إضافة موظف', icon: UserPlus, show: can(user, 'employees.create') },
    { href: '/payroll', label: 'عرض الرواتب', icon: Wallet, show: user?.role === 'ADMIN' },
    {
      href: '/reports',
      label: 'عرض التقارير',
      icon: BarChart3,
      show: canAny(user, ['reports.attendance', 'reports.absence', 'reports.financial', 'reports.payments']),
    },
  ].filter((a) => a.show);

  return (
    <>
      <PageHeader
        title="اليوم"
        description={rangeText ? `ملخص الفترة: ${rangeText}` : 'ملخص العمل'}
        actions={
          <div role="group" aria-label="اختيار الفترة" className="inline-flex rounded-lg border border-line bg-surface p-1">
            {DASHBOARD_PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={period === p}
                onClick={() => setPeriod(p)}
                className={cn(
                  'h-9 rounded-md px-4 text-sm font-medium transition-colors',
                  period === p ? 'bg-brand-600 text-white' : 'text-muted hover:text-ink',
                )}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        }
      />

      {error && <Alert className="mb-4">{error}</Alert>}

      {actions.length > 0 && (
        <section aria-label="إجراءات سريعة" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {actions.map((action) => <QuickAction key={action.href} {...action} />)}
        </section>
      )}
      {(openShifts.data || reviewShifts.data || syncIssues > 0) && <section aria-labelledby="attention-title" className="mb-4">
        <h2 id="attention-title" className="mb-2 font-semibold">بحاجة إلى انتباه</h2>
        <div className="flex flex-wrap gap-3 text-sm">
        {syncIssues > 0 && <a className="rounded-lg border border-line bg-surface p-3 underline" href="#attendance-sync"
          onClick={() => { const queue = document.getElementById('attendance-sync'); if (queue instanceof HTMLDetailsElement) queue.open = true; }}>
          عمليات مزامنة تحتاج مراجعة · {formatNumber(syncIssues)}
        </a>}
        {openShifts.data && <Link className="rounded-lg border border-line bg-surface p-3 underline" href="/attendance#quick-check-out">
          الورديات المفتوحة · {formatNumber(openShifts.data.total)}
        </Link>}
        {reviewShifts.data && <Link className="rounded-lg border border-line bg-surface p-3 underline" href="/attendance#review">
          دوام قيد المراجعة · {formatNumber(reviewShifts.data.total)}
        </Link>}
        {openShifts.data?.items.filter(shift => shift.missingCheckOut).map(shift =>
          <Link key={shift.id} className="rounded-lg border border-line bg-surface p-3 underline" href={`/attendance#shift-${shift.id}`}>
            انصراف ناقص · {shift.employee.fullName}
          </Link>)}
        </div>
      </section>}
      <section aria-label="المؤشرات" className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="الموظفون الذين عملوا"
          icon={Users}
          tone="brand"
          loading={loading}
          value={summary && summary.employeesWorked !== null ? formatNumber(summary.employeesWorked) : null}
        />
        <StatCard
          label="مجموع ساعات العمل"
          icon={Clock}
          tone="brand"
          loading={loading}
          value={summary && summary.totalWorkedMinutes !== null ? formatDuration(summary.totalWorkedMinutes) : null}
        />
        <StatCard
          label="مجموع المدفوعات"
          icon={HandCoins}
          tone="success"
          loading={loading}
          value={summary && summary.totalPayments !== null ? formatMoney(summary.totalPayments, currency) : null}
        />
        <StatCard
          label="أجور مستحقة غير مدفوعة"
          icon={Wallet}
          tone="danger"
          loading={loading}
          note="رصيد قائم حتى الآن من الفترات المغلقة"
          value={summary && summary.unpaidWages !== null ? formatMoney(summary.unpaidWages, currency) : null}
        />
      </section>

    </>
  );
}
