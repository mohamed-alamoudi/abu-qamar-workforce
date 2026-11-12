import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can } from '@abu-qamar/shared';
import { APP_CONFIG, AppConfig } from '../config/env';
import { Errors } from '../errors/app-exception';
import { safeEqual } from '../utils/crypto';
import { SessionService } from '../../auth/session.service';
import type { AppRequest } from './auth.types';
import { ACCESS_KEY, AccessRule, REAUTH_KEY } from './decorators';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * الحارس الأمني الموحّد لكل المسارات، بالترتيب:
 *  1) فحص مصدر الطلب (Origin) للطلبات المغيِّرة للحالة.
 *  2) المصادقة عبر جلسة الخادم (كوكي HttpOnly).
 *  3) حماية CSRF برمز مرتبط بالجلسة (X-CSRF-Token).
 *  4) التفويض: عام / مسجّل / أدمن فقط / صلاحيات — والافتراضي أدمن فقط.
 *  5) إعادة التحقق من كلمة المرور للعمليات الحساسة.
 */
@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const rule: AccessRule = this.reflector.getAllAndOverride<AccessRule>(ACCESS_KEY, targets) ?? { kind: 'admin' };
    const unsafe = !SAFE_METHODS.has(req.method.toUpperCase());

    if (unsafe) this.assertOrigin(req);
    if (rule.kind === 'public') return true;

    const token = req.cookies?.[this.config.sessionCookieName];
    const auth = typeof token === 'string' && token ? await (req.path === '/sync/attendance' ? this.sessions.resolve(token, true) : this.sessions.resolve(token)) : null;
    if (!auth) throw Errors.unauthenticated();
    req.auth = auth;

    if (unsafe) {
      const header = req.headers['x-csrf-token'];
      const expected = this.sessions.csrfTokenFor(auth.session.tokenHash);
      if (typeof header !== 'string' || !safeEqual(header, expected)) throw Errors.csrf();
    }

    if (rule.kind === 'admin' && auth.user.role !== 'ADMIN') throw Errors.adminOnly();
    if (rule.kind === 'permissions') {
      const check = (p: (typeof rule.permissions)[number]) => can(auth.user, p);
      const ok = rule.mode === 'all' ? rule.permissions.every(check) : rule.permissions.some(check);
      if (!ok) throw Errors.forbidden();
    }

    if (this.reflector.getAllAndOverride<boolean>(REAUTH_KEY, targets)) {
      const at = auth.session.reauthAt?.getTime() ?? 0;
      if (Date.now() - at > this.config.reauthWindowMs) throw Errors.reauthRequired();
    }
    return true;
  }

  /** المتصفحات ترسل Origin مع كل طلب مغيِّر للحالة؛ إن وُجد يجب أن يكون من القائمة المسموحة. */
  private assertOrigin(req: AppRequest): void {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return;
    if (!this.config.allowedOrigins.includes(origin.replace(/\/+$/, ''))) throw Errors.originNotAllowed();
  }
}
