'use client';

import { BarChart3, Clock, HandCoins, Lock, LogIn, LogOut, type LucideIcon, UserPlus, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { can, canAny, DASHBOARD_PERIODS, type DashboardPeriod } from '@abu-qamar/shared';
import { Alert, Card, cn } from '@abu-qamar/ui';
import { PageHeader } from '@/components/page';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { api, errorMessage } from '@/lib/api';
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
    { href: '/employees?new=1', label: 'إضافة موظف', icon: UserPlus, show: can(user, 'employees.create') },
    { href: '/attendance#quick-check-in', label: 'تسجيل حضور', icon: LogIn, show: can(user, 'attendance.check_in') },
    { href: '/attendance#quick-check-out', label: 'تسجيل انصراف', icon: LogOut, show: can(user, 'attendance.check_out') },
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
        title={`مرحبًا، ${user?.fullName ?? ''}`}
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

      {actions.length > 0 && (
        <section aria-labelledby="quick-actions" className="mt-8">
          <h2 id="quick-actions" className="mb-3 text-base font-semibold">
            إجراءات سريعة
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {actions.map((a) => (
              <QuickAction key={a.label} href={a.href} label={a.label} icon={a.icon} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
