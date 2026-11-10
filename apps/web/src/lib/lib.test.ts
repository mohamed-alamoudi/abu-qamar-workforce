import { describe, expect, it } from 'vitest';
import { ApiError, buildRequestInit, errorMessage, toApiError, toQuery } from './api';
import { describeUserAgent, formatDuration, formatMoney } from './format';
import { visibleNavItems } from './nav';

describe('عميل الـ API', () => {
  it('يرسل رمز CSRF مع الطلبات المغيِّرة فقط، والكوكيز لنفس النطاق فقط', () => {
    const post = buildRequestInit('POST', { a: 1 }, 'token');
    expect(post.headers).toMatchObject({ 'X-CSRF-Token': 'token', 'Content-Type': 'application/json' });
    expect(post.credentials).toBe('same-origin');
    expect(post.body).toBe('{"a":1}');

    const get = buildRequestInit('GET', undefined, 'token');
    expect(get.headers).not.toHaveProperty('X-CSRF-Token');
    expect(get.body).toBeUndefined();
    expect(buildRequestInit('DELETE', undefined, null).headers).not.toHaveProperty('X-CSRF-Token');
  });

  it('يحوّل رد الخطأ إلى ApiError ويعرض تفاصيل التحقق', () => {
    const error = toApiError(400, { code: 'VALIDATION_FAILED', message: 'البيانات غير صالحة', details: ['أ', 'ب'] });
    expect(error).toBeInstanceOf(ApiError);
    expect(errorMessage(error)).toBe('أ • ب');
    expect(errorMessage(toApiError(500, null))).toBe('حدث خطأ غير متوقع');
    expect(toApiError(403, { code: 'ADMIN_ONLY', message: 'للأدمن فقط' }).code).toBe('ADMIN_ONLY');
  });

  it('toQuery يتجاهل القيم الفارغة', () => {
    expect(toQuery({ page: 2, search: '', active: undefined, q: 'علي' })).toBe('?page=2&q=%D8%B9%D9%84%D9%8A');
    expect(toQuery({})).toBe('');
  });
});

describe('التنسيق', () => {
  it('مدة العمل بالدقيقة دون تقريب', () => {
    expect(formatDuration(0)).toBe('0 د');
    expect(formatDuration(59)).toBe('59 د');
    expect(formatDuration(60)).toBe('1 س');
    expect(formatDuration(487)).toBe('8 س 7 د');
  });

  it('المبالغ بخانتين عشريتين', () => {
    expect(formatMoney('1500', 'ILS')).toContain('1,500.00');
    expect(formatMoney('abc', 'ILS')).toBe('—');
  });

  it('وصف الجهاز من User-Agent', () => {
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome على Android');
    expect(describeUserAgent(null)).toBe('جهاز غير معروف');
  });
});

describe('قائمة التنقل حسب الصلاحيات', () => {
  const ids = (role: 'ADMIN' | 'SUPERVISOR', permissions: string[]) =>
    visibleNavItems({ role, permissions }).map((i) => i.href);

  it('الأدمن يرى كل شيء', () => {
    expect(ids('ADMIN', [])).toEqual(
      expect.arrayContaining(['/dashboard', '/employees', '/attendance', '/payroll', '/reports', '/users', '/audit', '/settings']),
    );
  });

  it('المراقب لا يرى صفحات الأدمن، ويرى فقط ما تسمح به صلاحياته', () => {
    const none = ids('SUPERVISOR', []);
    expect(none).toEqual(['/dashboard']);

    const some = ids('SUPERVISOR', ['attendance.check_in', 'reports.absence']);
    expect(some).toEqual(['/dashboard', '/attendance', '/reports']);
    for (const adminPage of ['/users', '/audit', '/settings', '/payroll']) expect(some).not.toContain(adminPage);
  });
});
