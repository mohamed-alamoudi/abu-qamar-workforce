import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions } from 'express';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { APP_CONFIG, AppConfig } from '../common/config/env';
import { PrismaService } from '../common/prisma/prisma.service';
import { hmacBase64Url, randomToken, sha256Hex } from '../common/utils/crypto';

/** لا نكتب lastSeenAt مع كل طلب؛ مرة كل دقيقة تكفي لحساب الخمول. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * جلسات محفوظة في الخادم (جدول sessions):
 * - الكوكي يحمل رمزًا عشوائيًا (256 بت) والقاعدة تحفظ بصمته SHA-256 فقط.
 * - كل طلب يُعاد فيه فحص: الإلغاء، الانتهاء المطلق، الخمول، وحالة الحساب وصلاحياته —
 *   فتعطيل الحساب أو تغيير الصلاحيات يسري فورًا.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(userId: string, rememberDevice: boolean, meta: RequestMeta) {
    const token = randomToken(32);
    const now = Date.now();
    const ttl = rememberDevice ? this.config.rememberTtlMs : this.config.sessionTtlMs;
    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        rememberDevice,
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(now + ttl),
        // تسجيل الدخول نفسه إثبات حديث لكلمة المرور
        reauthAt: new Date(now),
      },
    });
    return { token, session };
  }

  async resolve(token: string): Promise<AuthContext | null> {
    const tokenHash = sha256Hex(token);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: { include: { permissions: { include: { permission: { select: { key: true } } } } } } },
    });
    if (!session || session.revokedAt) return null;

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) return null;
    // الجلسة العادية تنتهي بالخمول؛ جلسة "تذكر الجهاز" تعتمد على مدتها المطلقة فقط.
    if (!session.rememberDevice && now - session.lastSeenAt.getTime() > this.config.sessionIdleMs) return null;

    const { user } = session;
    if (!user.isActive) return null;

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.updateMany({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
    }

    return {
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        permissions: user.role === 'ADMIN' ? [] : user.permissions.map((p) => p.permission.key),
        totpEnabled: user.totpEnabledAt !== null,
      },
      session: {
        id: session.id,
        tokenHash,
        rememberDevice: session.rememberDevice,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        reauthAt: session.reauthAt,
      },
    };
  }

  async markReauthenticated(sessionId: string): Promise<Date> {
    const reauthAt = new Date();
    await this.prisma.session.update({ where: { id: sessionId }, data: { reauthAt } });
    return reauthAt;
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  /** رمز CSRF مرتبط بالجلسة: لا يمكن لموقع آخر معرفته، ويبطل ببطلان الجلسة. */
  csrfTokenFor(tokenHash: string): string {
    return hmacBase64Url(this.config.sessionSecret, `csrf:${tokenHash}`);
  }

  reauthValidUntil(reauthAt: Date | null): Date | null {
    if (!reauthAt) return null;
    const until = new Date(reauthAt.getTime() + this.config.reauthWindowMs);
    return until.getTime() > Date.now() ? until : null;
  }

  cookieOptions(rememberDevice: boolean, expiresAt?: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.isSecureEnv,
      sameSite: this.config.cookieSameSite,
      path: '/',
      // دون "تذكر الجهاز" تكون كوكي جلسة تُحذف بإغلاق المتصفح
      ...(rememberDevice && expiresAt ? { expires: expiresAt } : {}),
    };
  }
}
