'use client';

import {
  BarChart3,
  Bell,
  Building2,
  CalendarClock,
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  UserCircle,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, cn, Modal } from '@abu-qamar/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { type NavIcon, type NavItem, visibleNavItems } from '@/lib/nav';
import type { NotificationItem, Paginated, SearchResults, SessionUser } from '@/lib/types';
import { useAuth } from '@/providers/auth-provider';
import { BrandMark } from './auth-card';
import { AttendanceQueuePanel } from './attendance-queue-panel';
import { ConnectionStatus } from './pwa';
import { ThemeToggle } from './theme-toggle';

const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  employees: Users,
  departments: Building2,
  attendance: CalendarClock,
  payroll: Wallet,
  reports: BarChart3,
  users: ShieldCheck,
  audit: ScrollText,
  settings: Settings,
};

const COLLAPSE_KEY = 'aq-sidebar-collapsed';
const ROLE_LABEL = { ADMIN: 'الأدمن الرئيسي', SUPERVISOR: 'مراقب' } as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** يغلق القائمة المنسدلة عند النقر خارجها أو ضغط Esc. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

// ───────────────────────────── القائمة الجانبية (كمبيوتر) ─────────────────────────────

function Sidebar({ items, collapsed, onToggle }: { items: NavItem[]; collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname();
  const Chevron = collapsed ? ChevronsLeft : ChevronsRight;
  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-dvh shrink-0 flex-col border-e border-line bg-surface transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[4.5rem]' : 'w-64',
      )}
    >
      <div className={cn('flex h-16 items-center gap-3 border-b border-line px-4', collapsed && 'justify-center px-0')}>
        <BrandMark className="size-9 shrink-0" />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-bold">سوبر ماركت أبو قمر</p>
            <p className="truncate text-xs text-muted">إدارة الموظفين</p>
          </div>
        )}
      </div>
      <nav aria-label="القائمة الرئيسية" className="flex-1 space-y-1 overflow-y-auto p-3">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
                collapsed && 'justify-center px-0',
                active ? 'bg-brand-600 text-white' : 'text-ink hover:bg-subtle',
              )}
            >
              <Icon className="size-5 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-line p-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'توسيع القائمة' : 'طي القائمة'}
          className={cn(
            'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-muted hover:bg-subtle hover:text-ink',
            collapsed && 'justify-center px-0',
          )}
        >
          <Chevron className="size-5 shrink-0" />
          {!collapsed && <span>طي القائمة</span>}
        </button>
      </div>
    </aside>
  );
}

// ───────────────────────────── البحث الموحد ─────────────────────────────

/**
 * البحث الفوري في الشريط العلوي. في المرحلة الأولى يبحث في صفحات النظام؛
 * ويتوسع ليشمل الموظفين والسجلات مع بناء وحداتها.
 */
function GlobalSearch({ items }: { items: NavItem[] }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const results = useMemo(() => {
    const q = query.trim();
    return q ? items.filter((i) => i.label.includes(q)) : [];
  }, [items, query]);

  // الموظفون المطابقون (الخادم يعيد فقط ما يملك المستخدم صلاحية رؤيته) — بتأخير قصير بعد التوقف عن الكتابة
  const [employees, setEmployees] = useState<SearchResults['employees']>([]);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setEmployees([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .get<SearchResults>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => !cancelled && setEmployees(r.employees))
        .catch(() => !cancelled && setEmployees([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const go = (href: string) => {
    setQuery('');
    setOpen(false);
    router.push(href);
  };

  return (
    <div ref={ref} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        role="combobox"
        aria-expanded={open && results.length + employees.length > 0}
        aria-controls="global-search-results"
        aria-label="بحث"
        placeholder="بحث عن موظف أو صفحة…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          if (results[0]) go(results[0].href);
          else if (employees[0]) go(`/employees/${employees[0].id}`);
        }}
        className="h-10 w-full rounded-lg border border-line bg-bg ps-9 pe-3 text-sm text-ink placeholder:text-muted focus:border-brand-500 focus:outline-2 focus:outline-brand-500/30"
      />
      {open && query.trim() && (
        <ul
          id="global-search-results"
          role="listbox"
          className="absolute inset-x-0 top-12 z-30 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          {employees.map((employee) => (
            <li key={employee.id} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => go(`/employees/${employee.id}`)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-start text-sm hover:bg-subtle"
              >
                <Users className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">
                  {employee.fullName}
                  <span className="ms-2 text-xs text-muted">
                    <span dir="ltr">{employee.code}</span> · {employee.department.name}
                    {employee.status === 'INACTIVE' && ' · متوقف'}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 ? (
            employees.length === 0 && <li className="px-3 py-3 text-sm text-muted">لا توجد نتائج</li>
          ) : (
            results.map((item) => {
              const Icon = ICONS[item.icon];
              return (
                <li key={item.href} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onClick={() => go(item.href)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-start text-sm hover:bg-subtle"
                  >
                    <Icon className="size-4 text-muted" />
                    {item.label}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────────── الإشعارات ─────────────────────────────

type NotificationsResponse = Paginated<NotificationItem> & { unreadCount: number };

function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  const load = useCallback(async () => {
    try {
      setData(await api.get<NotificationsResponse>('/notifications?pageSize=10'));
    } catch {
      /* الجرس لا يعطّل الصفحة عند فشل التحميل */
    }
  }, []);

  useEffect(() => {
    void load();
    if (new URLSearchParams(location.search).has('notifications')) setOpen(true);
    if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
      void api.get<{ publicKey: string | null; subscribed: boolean }>('/notifications/push').then(result => {
        setPushKey(result.publicKey);
        setSubscribed(result.subscribed);
      }).catch(() => {});
    }
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function remove(id?: string) {
    if (busy || (!id && !window.confirm('مسح كل إشعارات حسابك نهائيًا؟'))) return;
    setBusy(true);
    setNotice('');
    try {
      await api.delete(id ? '/notifications/' + id : '/notifications');
      await load();
      const registration = await navigator.serviceWorker?.getRegistration();
      const shown = await registration?.getNotifications(id ? { tag: id } : undefined);
      shown?.forEach(notification => notification.close());
    } catch {
      setNotice('تعذر مسح الإشعارات. حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  }

  async function togglePush() {
    if (busy || !pushKey) return;
    setBusy(true);
    setNotice('');
    try {
      if (!subscribed && await Notification.requestPermission() !== 'granted') {
        setNotice('اسمح بالإشعارات من إعدادات المتصفح أو الهاتف.');
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration?.active) throw new Error('Service worker unavailable');
      let subscription = await registration.pushManager.getSubscription();
      if (subscribed) {
        await api.delete('/notifications/push');
        await subscription?.unsubscribe();
      } else {
        subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKey });
        const { endpoint, keys } = subscription.toJSON();
        await api.post('/notifications/push', { endpoint, p256dh: keys?.p256dh, auth: keys?.auth });
      }
      setSubscribed(!subscribed);
    } catch {
      setNotice('تعذر تغيير إعداد إشعارات الهاتف. حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  }

  const markAll = async () => {
    try {
      await api.post('/notifications/read-all');
      await load();
    } catch {
      /* يبقى العدد كما هو */
    }
  };

  const unread = data?.unreadCount ?? 0;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void load();
        }}
        aria-label={unread ? `الإشعارات (${unread} غير مقروء)` : 'الإشعارات'}
        aria-expanded={open}
        className="relative flex size-10 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-ink"
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute end-1 top-1 flex min-w-4.5 items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-bold leading-4.5 text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="fixed inset-x-3 top-16 z-30 rounded-xl border border-line bg-surface shadow-xl sm:absolute sm:inset-x-auto sm:end-0 sm:top-12 sm:w-96">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-sm font-semibold">الإشعارات</p>
            {unread > 0 && (
              <button type="button" onClick={markAll} className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300">
                تعليم الكل كمقروء
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-3 border-b border-line px-4 py-2 text-xs">
            {pushKey && <button type="button" disabled={busy} onClick={() => void togglePush()} className="underline">
              {subscribed ? 'إيقاف إشعارات الهاتف' : 'تفعيل إشعارات الهاتف'}
            </button>}
            {!!data?.total && <button type="button" disabled={busy} onClick={() => void remove()} className="underline">مسح الكل نهائيًا</button>}
            {notice && <p role="alert" className="w-full">{notice}</p>}
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {!data || data.items.length === 0 ? (
              <li className="px-4 py-8 text-center text-sm text-muted">لا توجد إشعارات</li>
            ) : (
              data.items.map((n) => (
                <li key={n.id} className={cn('px-4 py-3', !n.readAt && 'bg-brand-600/5')}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium">{n.title}</p>
                    {!n.readAt && <Badge tone="brand">جديد</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{n.body}</p>
                  <p className="tabular mt-1 text-xs text-muted">{formatDateTime(n.createdAt)}</p>
                  <button type="button" disabled={busy} onClick={() => void remove(n.id)} className="mt-1 text-xs underline">حذف الإشعار</button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── قائمة الحساب ─────────────────────────────

function AccountMenu({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-10 items-center gap-2 rounded-lg px-2 hover:bg-subtle"
      >
        <UserCircle className="size-6 text-muted" />
        <span className="hidden max-w-32 truncate text-sm font-medium sm:block">{user.fullName}</span>
      </button>
      {open && (
        <div role="menu" className="absolute end-0 top-12 z-30 w-60 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="border-b border-line px-4 py-3">
            <p className="truncate text-sm font-semibold">{user.fullName}</p>
            <p className="mt-0.5 text-xs text-muted">
              <span dir="ltr">{user.username}</span> · {ROLE_LABEL[user.role]}
            </p>
          </div>
          <Link role="menuitem" href="/account" onClick={close} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-subtle">
            <UserCircle className="size-4 text-muted" />
            حسابي والأمان
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={onLogout}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm text-danger-600 hover:bg-subtle"
          >
            <LogOut className="size-4" />
            تسجيل الخروج
          </button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── التنقل السفلي (جوال) ─────────────────────────────

function BottomNav({ items, onMore }: { items: NavItem[]; onMore: () => void }) {
  const pathname = usePathname();
  const primary = ['/dashboard', '/attendance', '/employees'].flatMap(href => items.filter(item => item.primary && item.href === href));
  const moreActive = !primary.some((i) => isActive(pathname, i.href));
  const cell = 'flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium';
  return (
    <nav
      aria-label="التنقل السفلي"
      className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {primary.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(cell, active ? 'text-brand-600 dark:text-brand-300' : 'text-muted')}
          >
            <Icon className="size-6" />
            {item.href === '/attendance' ? 'الدوام' : item.label}
          </Link>
        );
      })}
      <button type="button" onClick={onMore} className={cn(cell, moreActive ? 'text-brand-600 dark:text-brand-300' : 'text-muted')}>
        <Menu className="size-6" />
        المزيد
      </button>
    </nav>
  );
}

// ───────────────────────────── الهيكل ─────────────────────────────

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const items = useMemo(() => visibleNavItems(user), [user]);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* التخزين غير متاح */
    }
  }, []);

  useEffect(() => setMoreOpen(false), [pathname]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, value ? '0' : '1');
      } catch {
        /* التخزين غير متاح */
      }
      return !value;
    });
  };

  const handleLogout = async () => {
    if (await logout()) router.replace('/login');
  };

  return (
    <div className="flex min-h-dvh">
      <Sidebar items={items} collapsed={collapsed} onToggle={toggleCollapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-line bg-surface px-3 sm:px-6">
          <Link href="/dashboard" className="lg:hidden" aria-label="لوحة التحكم">
            <BrandMark className="size-9" />
          </Link>
          <GlobalSearch items={items} />
          <div className="ms-auto flex items-center gap-1">
            <ConnectionStatus />
            <ThemeToggle />
            <NotificationsBell />
            <AccountMenu user={user} onLogout={handleLogout} />
          </div>
        </header>
        <main className="flex-1 px-3 pb-24 pt-5 sm:px-6 lg:pb-8">
          <div className="mx-auto w-full max-w-6xl">
            <AttendanceQueuePanel key={user.id} userId={user.id} />
            {children}
          </div>
        </main>
      </div>

      <BottomNav items={items} onMore={() => setMoreOpen(true)} />
      <Modal open={moreOpen} title="القائمة" onClose={() => setMoreOpen(false)}>
        <nav aria-label="كل الصفحات" className="grid grid-cols-2 gap-2">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border p-3 text-center text-sm font-medium',
                  active ? 'border-brand-600 bg-brand-600/10 text-brand-700 dark:text-brand-300' : 'border-line hover:bg-subtle',
                )}
              >
                <Icon className="size-6" />
                {item.label}
              </Link>
            );
          })}
          <Link href="/account" className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border border-line p-3 text-sm font-medium hover:bg-subtle">
            <UserCircle className="size-6" />
            حسابي والأمان
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border border-line p-3 text-sm font-medium text-danger-600 hover:bg-subtle"
          >
            <LogOut className="size-6" />
            تسجيل الخروج
          </button>
        </nav>
      </Modal>
    </div>
  );
}
