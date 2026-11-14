import { type AccessSubject, canAny, type PermissionKey } from '@abu-qamar/shared';

export type NavIcon = 'dashboard' | 'employees' | 'departments' | 'attendance' | 'payroll' | 'reports' | 'users' | 'audit' | 'settings';

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** للأدمن فقط */
  adminOnly?: boolean;
  /** يظهر لمن يملك واحدة على الأقل من هذه الصلاحيات (والأدمن دائمًا) */
  anyOf?: PermissionKey[];
  /** يظهر في شريط التنقل السفلي على الجوال */
  primary?: boolean;
}

/**
 * إخفاء العناصر هنا لتحسين التجربة فقط — الحماية الفعلية مفروضة في الخادم.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'اليوم', icon: 'dashboard', primary: true },
  {
    href: '/employees',
    label: 'الموظفون',
    icon: 'employees',
    anyOf: ['employees.view', 'employees.create', 'employees.update'],
    primary: true,
  },
  { href: '/departments', label: 'الأقسام', icon: 'departments', anyOf: ['employees.view'] },
  {
    href: '/attendance',
    label: 'الحضور والانصراف',
    icon: 'attendance',
    anyOf: ['attendance.view', 'attendance.check_in', 'attendance.check_out', 'attendance.correct'],
    primary: true,
  },
  { href: '/leaves', label: 'الإجازات والغياب', icon: 'attendance', anyOf: ['leaves.view', 'leaves.record'] },
  { href: '/payroll', label: 'الرواتب', icon: 'payroll', anyOf: ['finance.view'] },
  {
    href: '/reports',
    label: 'التقارير',
    icon: 'reports',
    anyOf: ['reports.attendance', 'reports.absence', 'reports.financial', 'reports.payments'],
  },
  { href: '/users', label: 'المستخدمون والصلاحيات', icon: 'users', adminOnly: true },
  { href: '/audit', label: 'سجل التدقيق', icon: 'audit', adminOnly: true },
  { href: '/settings', label: 'الإعدادات', icon: 'settings', adminOnly: true },
  { href: '/backups', label: 'النسخ الاحتياطية', icon: 'settings', adminOnly: true },
];

export function isNavItemVisible(item: NavItem, subject: AccessSubject): boolean {
  if (subject.role === 'ADMIN') return true;
  if (item.adminOnly) return false;
  if (item.anyOf) return canAny(subject, item.anyOf);
  return true;
}

export function visibleNavItems(subject: AccessSubject): NavItem[] {
  return NAV_ITEMS.filter((item) => isNavItemVisible(item, subject));
}
