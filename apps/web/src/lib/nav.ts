import { type AccessSubject, canAny, type PermissionKey } from '@abu-qamar/shared';

export type NavIcon = 'dashboard' | 'employees' | 'attendance' | 'payroll' | 'reports' | 'users' | 'audit' | 'settings';

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
  /** المرحلة التي تُبنى فيها الوحدة إن لم تكن جاهزة بعد */
  plannedPhase?: number;
}

/**
 * إخفاء العناصر هنا لتحسين التجربة فقط — الحماية الفعلية مفروضة في الخادم.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'لوحة التحكم', icon: 'dashboard', primary: true },
  {
    href: '/employees',
    label: 'الموظفون',
    icon: 'employees',
    anyOf: ['employees.view', 'employees.create', 'employees.update'],
    primary: true,
    plannedPhase: 2,
  },
  {
    href: '/attendance',
    label: 'الحضور والانصراف',
    icon: 'attendance',
    anyOf: ['attendance.view', 'attendance.check_in', 'attendance.check_out', 'attendance.correct'],
    primary: true,
    plannedPhase: 3,
  },
  { href: '/payroll', label: 'الرواتب', icon: 'payroll', adminOnly: true, plannedPhase: 4 },
  {
    href: '/reports',
    label: 'التقارير',
    icon: 'reports',
    anyOf: ['reports.attendance', 'reports.absence', 'reports.financial', 'reports.payments'],
    plannedPhase: 5,
  },
  { href: '/users', label: 'المستخدمون والصلاحيات', icon: 'users', adminOnly: true },
  { href: '/audit', label: 'سجل التدقيق', icon: 'audit', adminOnly: true },
  { href: '/settings', label: 'الإعدادات', icon: 'settings', adminOnly: true },
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

export const PLANNED_MODULES = NAV_ITEMS.filter((i) => i.plannedPhase !== undefined);
