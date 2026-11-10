import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthContext } from './auth.types';
import { AdminOnly, AnyAuthenticated, Public, RequireAnyPermission, RequirePermissions, RequireReauth } from './decorators';
import { SecurityGuard } from './security.guard';
import type { AppConfig } from '../config/env';
import { AppException } from '../errors/app-exception';
import type { SessionService } from '../../auth/session.service';

class Routes {
  @Public() open() {}
  @AnyAuthenticated() any() {}
  @AdminOnly() admin() {}
  @RequirePermissions('employees.view', 'employees.update') both() {}
  @RequireAnyPermission('attendance.view', 'reports.attendance') either() {}
  @AnyAuthenticated() @RequireReauth() sensitive() {}
  unmarked() {}
}

const config = {
  sessionCookieName: 'aq_session',
  allowedOrigins: ['http://localhost:3000'],
  reauthWindowMs: 5 * 60_000,
} as AppConfig;

function authContext(role: 'ADMIN' | 'SUPERVISOR', permissions: string[] = [], reauthAgoMs: number | null = 0): AuthContext {
  return {
    user: { id: 'u1', username: 'user', fullName: 'مستخدم', role, permissions, totpEnabled: false },
    session: {
      id: 's1',
      tokenHash: 'hash',
      rememberDevice: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      reauthAt: reauthAgoMs === null ? null : new Date(Date.now() - reauthAgoMs),
    },
  };
}

function setup(auth: AuthContext | null) {
  const sessions = {
    resolve: jest.fn().mockResolvedValue(auth),
    csrfTokenFor: jest.fn().mockReturnValue('csrf-ok'),
  } as unknown as SessionService;
  const guard = new SecurityGuard(new Reflector(), sessions, config);

  const run = (
    route: keyof Routes,
    opts: { method?: string; cookie?: string | null; csrf?: string; origin?: string } = {},
  ) => {
    const req = {
      method: opts.method ?? 'GET',
      cookies: opts.cookie === null ? {} : { aq_session: opts.cookie ?? 'token' },
      headers: {
        ...(opts.csrf ? { 'x-csrf-token': opts.csrf } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
    } as Record<string, unknown>;
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => Routes.prototype[route],
      getClass: () => Routes,
    } as unknown as ExecutionContext;
    return guard.canActivate(context).then((ok) => ({ ok, req }));
  };
  return { run, sessions };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ALLOWED';
  } catch (error) {
    return error instanceof AppException ? error.code : `UNEXPECTED:${String(error)}`;
  }
};

describe('SecurityGuard', () => {
  it('المسار العام يمر دون جلسة ولا يستعلم عن الجلسات', async () => {
    const { run, sessions } = setup(null);
    expect((await run('open', { cookie: null })).ok).toBe(true);
    expect(sessions.resolve).not.toHaveBeenCalled();
  });

  it('دون كوكي أو بجلسة غير صالحة: UNAUTHENTICATED', async () => {
    const { run } = setup(null);
    expect(await codeOf(run('any', { cookie: null }))).toBe('UNAUTHENTICATED');
    expect(await codeOf(run('any'))).toBe('UNAUTHENTICATED');
  });

  it('يُرفق سياق المستخدم بالطلب عند النجاح', async () => {
    const auth = authContext('SUPERVISOR');
    const { run } = setup(auth);
    const { req } = await run('any');
    expect(req.auth).toBe(auth);
  });

  it('المسار غير المعلَّم للأدمن فقط (الرفض افتراضيًا)', async () => {
    expect(await codeOf(setup(authContext('SUPERVISOR', ['employees.view'])).run('unmarked'))).toBe('ADMIN_ONLY');
    expect(await codeOf(setup(authContext('ADMIN')).run('unmarked'))).toBe('ALLOWED');
  });

  it('AdminOnly يرفض المراقب مهما كانت صلاحياته', async () => {
    const everything = ['employees.view', 'employees.update', 'finance.view', 'attendance.correct'];
    expect(await codeOf(setup(authContext('SUPERVISOR', everything)).run('admin'))).toBe('ADMIN_ONLY');
    expect(await codeOf(setup(authContext('ADMIN')).run('admin'))).toBe('ALLOWED');
  });

  it('RequirePermissions يتطلب كل الصلاحيات و RequireAnyPermission واحدة منها', async () => {
    expect(await codeOf(setup(authContext('SUPERVISOR', ['employees.view'])).run('both'))).toBe('FORBIDDEN');
    expect(await codeOf(setup(authContext('SUPERVISOR', ['employees.view', 'employees.update'])).run('both'))).toBe('ALLOWED');
    expect(await codeOf(setup(authContext('SUPERVISOR', [])).run('either'))).toBe('FORBIDDEN');
    expect(await codeOf(setup(authContext('SUPERVISOR', ['reports.attendance'])).run('either'))).toBe('ALLOWED');
    expect(await codeOf(setup(authContext('ADMIN')).run('both'))).toBe('ALLOWED');
  });

  it('الطلبات المغيِّرة للحالة تتطلب رمز CSRF صحيحًا، وطلبات القراءة لا تتطلبه', async () => {
    const { run } = setup(authContext('ADMIN'));
    expect(await codeOf(run('any', { method: 'GET' }))).toBe('ALLOWED');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await codeOf(run('any', { method }))).toBe('CSRF_FAILED');
      expect(await codeOf(run('any', { method, csrf: 'wrong' }))).toBe('CSRF_FAILED');
      expect(await codeOf(run('any', { method, csrf: 'csrf-ok' }))).toBe('ALLOWED');
    }
  });

  it('مصدر غير مسموح يُرفض قبل أي شيء، حتى على المسار العام', async () => {
    const { run, sessions } = setup(authContext('ADMIN'));
    expect(await codeOf(run('open', { method: 'POST', origin: 'https://evil.example' }))).toBe('ORIGIN_NOT_ALLOWED');
    expect(await codeOf(run('any', { method: 'POST', origin: 'https://evil.example', csrf: 'csrf-ok' }))).toBe('ORIGIN_NOT_ALLOWED');
    expect(sessions.resolve).not.toHaveBeenCalled();
    expect(await codeOf(run('any', { method: 'POST', origin: 'http://localhost:3000', csrf: 'csrf-ok' }))).toBe('ALLOWED');
  });

  it('RequireReauth: يمر ضمن النافذة ويرفض بعدها أو دون إعادة تحقق', async () => {
    expect(await codeOf(setup(authContext('ADMIN', [], 60_000)).run('sensitive'))).toBe('ALLOWED');
    expect(await codeOf(setup(authContext('ADMIN', [], 6 * 60_000)).run('sensitive'))).toBe('REAUTH_REQUIRED');
    expect(await codeOf(setup(authContext('ADMIN', [], null)).run('sensitive'))).toBe('REAUTH_REQUIRED');
  });
});
