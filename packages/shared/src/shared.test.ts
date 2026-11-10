import { describe, expect, it } from 'vitest';
import { can, canAny, isPermissionKey, PERMISSION_KEYS, PERMISSIONS } from './permissions';
import { createUserSchema, loginSchema, passwordSchema, setupAdminSchema, usernameSchema } from './schemas';

describe('كتالوج الصلاحيات', () => {
  it('المفاتيح فريدة', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSIONS.length);
  });

  it('لا يحتوي على أي صلاحية كتابة مالية أو إدارية', () => {
    const forbidden = /^(payroll|payments|settlements|advances|debts|users|settings|backups|audit|delete)./;
    for (const key of PERMISSION_KEYS) expect(key).not.toMatch(forbidden);
    // المالية للقراءة فقط
    expect(PERMISSION_KEYS.filter((k) => k.startsWith('finance.'))).toEqual(['finance.view']);
  });

  it('الأدمن يملك كل الصلاحيات والمراقب يملك الممنوح فقط', () => {
    expect(can({ role: 'ADMIN', permissions: [] }, 'finance.view')).toBe(true);
    const supervisor = { role: 'SUPERVISOR' as const, permissions: ['attendance.check_in'] };
    expect(can(supervisor, 'attendance.check_in')).toBe(true);
    expect(can(supervisor, 'finance.view')).toBe(false);
    expect(canAny(supervisor, ['finance.view', 'attendance.check_in'])).toBe(true);
    expect(can(null, 'employees.view')).toBe(false);
  });

  it('isPermissionKey يرفض المفاتيح المجهولة', () => {
    expect(isPermissionKey('employees.view')).toBe(true);
    expect(isPermissionKey('payroll.approve')).toBe(false);
  });
});

describe('مخططات التحقق', () => {
  it('اسم المستخدم يُحوَّل إلى أحرف صغيرة ويُرفض غير الصالح', () => {
    expect(usernameSchema.parse('  Ahmad.S ')).toBe('ahmad.s');
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('اسم عربي').success).toBe(false);
  });

  it('سياسة كلمة المرور', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
    expect(passwordSchema.safeParse('onlyletterslong').success).toBe(false);
    expect(passwordSchema.safeParse('12345678901').success).toBe(false);
    expect(passwordSchema.safeParse('Strong-Pass-2026').success).toBe(true);
  });

  it('تسجيل الدخول: rememberDevice افتراضيًا false', () => {
    expect(loginSchema.parse({ username: 'admin', password: 'x' }).rememberDevice).toBe(false);
  });

  it('إنشاء مراقب يرفض صلاحية خارج الكتالوج', () => {
    const base = { username: 'sup1', fullName: 'مراقب أول', password: 'Strong-Pass-2026' };
    expect(createUserSchema.safeParse({ ...base, permissions: ['employees.view'] }).success).toBe(true);
    expect(createUserSchema.safeParse({ ...base, permissions: ['payroll.approve'] }).success).toBe(false);
  });

  it('إعداد الأدمن يتطلب رمز الإعداد', () => {
    const input = { setupToken: '', username: 'admin', fullName: 'المدير', password: 'Strong-Pass-2026' };
    expect(setupAdminSchema.safeParse(input).success).toBe(false);
  });
});
