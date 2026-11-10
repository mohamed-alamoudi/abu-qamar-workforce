/**
 * كتالوج الصلاحيات التي يستطيع الأدمن منحها للمراقبين.
 *
 * قاعدة أمنية: هذا الكتالوج يحتوي فقط على ما يجوز منحه لمراقب.
 * العمليات المحصورة بالأدمن (الرواتب، الدفعات، التسويات، الصلاحيات، الاسترداد...)
 * ليست صلاحيات قابلة للمنح أصلًا، وتُفرض في الخادم بفحص الدور (AdminOnly).
 */
export const PERMISSION_CATEGORIES = {
  employees: 'الموظفون',
  attendance: 'الحضور والانصراف',
  leaves: 'الإجازات والغياب',
  reports: 'التقارير',
  finance: 'المعلومات المالية',
} as const;

export type PermissionCategory = keyof typeof PERMISSION_CATEGORIES;

export const PERMISSIONS = [
  { key: 'employees.view', category: 'employees', nameAr: 'عرض الموظفين والأقسام' },
  { key: 'employees.create', category: 'employees', nameAr: 'إضافة موظفين' },
  { key: 'employees.update', category: 'employees', nameAr: 'تعديل بيانات الموظفين غير المالية' },
  { key: 'attendance.view', category: 'attendance', nameAr: 'عرض سجلات الدوام' },
  { key: 'attendance.check_in', category: 'attendance', nameAr: 'تسجيل الحضور' },
  { key: 'attendance.check_out', category: 'attendance', nameAr: 'تسجيل الانصراف' },
  { key: 'attendance.correct', category: 'attendance', nameAr: 'تصحيح سجلات الدوام' },
  { key: 'leaves.view', category: 'leaves', nameAr: 'عرض الإجازات والغياب' },
  { key: 'leaves.record', category: 'leaves', nameAr: 'تسجيل إجازة أو غياب (بانتظار اعتماد الأدمن)' },
  { key: 'reports.attendance', category: 'reports', nameAr: 'عرض تقارير الدوام' },
  { key: 'reports.absence', category: 'reports', nameAr: 'عرض تقارير الغياب' },
  { key: 'reports.financial', category: 'reports', nameAr: 'عرض التقارير المالية (قراءة فقط)' },
  { key: 'reports.payments', category: 'reports', nameAr: 'عرض تقارير الدفعات (قراءة فقط)' },
  { key: 'finance.view', category: 'finance', nameAr: 'عرض المعلومات المالية (قراءة فقط)' },
] as const satisfies ReadonlyArray<{ key: string; category: PermissionCategory; nameAr: string }>;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}

/** عمليات محصورة بالأدمن ولا يمكن منحها لأي مراقب (للعرض في الواجهة والتوثيق). */
export const ADMIN_ONLY_ACTIONS: readonly string[] = [
  'حذف السجلات',
  'تعديل العمليات المالية',
  'تحضير مسودات الرواتب',
  'اعتماد الرواتب',
  'إغلاق فترات الرواتب',
  'تسجيل دفعات الرواتب',
  'إجراء التسويات المالية',
  'تغيير قواعد الأجور',
  'إدارة المستخدمين وتغيير صلاحياتهم',
  'تغيير إعدادات النظام',
  'إدارة النسخ الاحتياطية والاسترداد',
  'مراجعة سجل التدقيق',
];

export type UserRole = 'ADMIN' | 'SUPERVISOR';

export interface AccessSubject {
  role: UserRole;
  permissions: readonly string[];
}

/** الأدمن يملك كل شيء؛ المراقب يملك فقط ما مُنح له صراحةً. */
export function can(subject: AccessSubject | null | undefined, permission: PermissionKey): boolean {
  if (!subject) return false;
  if (subject.role === 'ADMIN') return true;
  return subject.permissions.includes(permission);
}

export function canAny(subject: AccessSubject | null | undefined, permissions: readonly PermissionKey[]): boolean {
  return permissions.some((p) => can(subject, p));
}
