import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@abu-qamar/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { APP_CONFIG, AppConfig } from '../common/config/env';
import { AppException, Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { safeEqual } from '../common/utils/crypto';
import { NotificationsService } from '../notifications/notifications.service';
import type { ChangePasswordDto, LoginDto, SetupAdminDto } from './dto/auth.dto';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

export const LOCKOUT_WINDOW_MS = 15 * 60_000;
/** فشل متتالٍ لنفس (اسم المستخدم + IP) خلال النافذة */
export const MAX_FAILURES_PER_USER_IP = 5;
/** فشل لنفس اسم المستخدم من كل العناوين خلال النافذة */
export const MAX_FAILURES_PER_USERNAME = 20;

type FailureReason = 'INVALID_CREDENTIALS' | 'ACCOUNT_DISABLED' | 'INVALID_TOTP' | 'LOCKED' | 'REAUTH_FAILED';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly totp: TotpService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ───────────────────────── إعداد الأدمن الأول ─────────────────────────

  async setupStatus(): Promise<{ needsSetup: boolean; setupEnabled: boolean }> {
    const adminExists = (await this.prisma.user.count({ where: { role: 'ADMIN' } })) > 0;
    return { needsSetup: !adminExists, setupEnabled: !adminExists && this.isSetupTokenUsable() };
  }

  private isSetupTokenUsable(): boolean {
    if (!this.config.setupToken) return false;
    const expires = this.config.setupTokenExpiresAt;
    return !expires || expires.getTime() > Date.now();
  }

  /**
   * ينشئ حساب الأدمن الوحيد. الحماية من الاستيلاء عبر الإنترنت:
   *  - يتطلب SETUP_TOKEN السري (من متغيرات البيئة) مع صلاحية زمنية.
   *  - يعمل فقط ما دام لا يوجد أدمن؛ بعد أول نجاح يتعطل نهائيًا (أحادي الاستخدام).
   *  - قيد فريد في قاعدة البيانات يمنع وجود أكثر من أدمن حتى مع طلبين متزامنين.
   */
  async setupFirstAdmin(dto: SetupAdminDto, meta: RequestMeta) {
    if ((await this.prisma.user.count({ where: { role: 'ADMIN' } })) > 0) {
      throw new AppException(ERROR_CODES.SETUP_ALREADY_COMPLETED, 'تم إعداد النظام مسبقًا', HttpStatus.CONFLICT);
    }
    if (!this.config.setupToken) {
      throw new AppException(
        ERROR_CODES.SETUP_NOT_CONFIGURED,
        'الإعداد عبر الويب غير مفعّل. عرّف SETUP_TOKEN في الخادم أو استخدم أمر إنشاء الأدمن',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!this.isSetupTokenUsable() || !safeEqual(dto.setupToken, this.config.setupToken)) {
      await this.recordAttempt(dto.username, null, meta, false, 'INVALID_CREDENTIALS');
      await this.audit.log({ action: 'auth.setup_rejected', meta });
      throw new AppException(ERROR_CODES.SETUP_TOKEN_INVALID, 'رمز الإعداد غير صحيح أو منتهي الصلاحية', HttpStatus.FORBIDDEN);
    }

    const passwordHash = await this.passwords.hash(dto.password);
    try {
      const admin = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { username: dto.username, fullName: dto.fullName, passwordHash, role: 'ADMIN' },
        });
        await this.audit.log(
          {
            action: 'auth.setup_admin',
            actor: { id: created.id, username: created.username },
            entityType: 'user',
            entityId: created.id,
            after: { username: created.username, fullName: created.fullName, role: created.role },
            meta,
          },
          tx,
        );
        return created;
      });
      return { id: admin.id, username: admin.username };
    } catch (error) {
      // طلب متزامن سبقنا: قيد الأدمن الوحيد رفض الإدراج (أو انتظر قفله حتى انتهت المهلة).
      // أيًّا كان شكل الخطأ، إن وُجد أدمن الآن فالرد الصحيح «تم الإعداد مسبقًا» لا خطأ داخلي.
      if ((await this.prisma.user.count({ where: { role: 'ADMIN' } })) > 0) {
        throw new AppException(ERROR_CODES.SETUP_ALREADY_COMPLETED, 'تم إعداد النظام مسبقًا', HttpStatus.CONFLICT);
      }
      throw error;
    }
  }

  // ───────────────────────────── تسجيل الدخول ─────────────────────────────

  async login(dto: LoginDto, meta: RequestMeta) {
    const username = dto.username;

    if (await this.isLockedOut(username, meta.ip)) {
      await this.recordAttempt(username, null, meta, false, 'LOCKED');
      throw Errors.tooManyAttempts();
    }

    const user = await this.prisma.user.findUnique({ where: { username } });
    if (!user) {
      await this.passwords.dummyVerify(dto.password);
      await this.failLogin(username, null, meta, 'INVALID_CREDENTIALS');
      throw Errors.invalidCredentials();
    }
    if (!(await this.passwords.verify(user.passwordHash, dto.password))) {
      await this.failLogin(username, user.id, meta, 'INVALID_CREDENTIALS');
      throw Errors.invalidCredentials();
    }
    // حالة التعطيل تُكشف فقط بعد كلمة مرور صحيحة (لا نكشف وجود الحساب لغير صاحبه)
    if (!user.isActive) {
      await this.failLogin(username, user.id, meta, 'ACCOUNT_DISABLED');
      throw Errors.accountDisabled();
    }

    if (user.totpEnabledAt && user.totpSecretEnc) {
      if (!dto.totpCode) throw Errors.totpRequired();
      const ok = this.totp.looksLikeRecoveryCode(dto.totpCode)
        ? await this.consumeRecoveryCode(user.id, dto.totpCode)
        : await this.consumeTotp(user.id, user.totpSecretEnc, dto.totpCode);
      if (!ok) {
        await this.failLogin(username, user.id, meta, 'INVALID_TOTP');
        throw Errors.invalidTotp();
      }
    }

    const unusual = await this.isUnusualLogin(user.id, meta.ip);
    const { token, session } = await this.sessions.create(user.id, dto.rememberDevice === true, meta);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.recordAttempt(username, user.id, meta, true, 'OK');
    await this.audit.log({
      action: 'auth.login',
      actor: { id: user.id, username: user.username },
      entityType: 'session',
      entityId: session.id,
      metadata: { rememberDevice: session.rememberDevice },
      meta,
    });
    if (unusual) {
      await this.notifications.notifyAdmin({
        type: 'UNUSUAL_LOGIN',
        title: 'تسجيل دخول من عنوان جديد',
        body: `تم تسجيل دخول الحساب «${user.username}» من عنوان لم يُستخدم سابقًا (${meta.ip ?? 'غير معروف'}).`,
        data: { userId: user.id, ip: meta.ip },
      });
    }

    const auth = await this.sessions.resolve(token);
    if (!auth) throw Errors.unauthenticated();
    return { token, auth };
  }

  private async isLockedOut(username: string, ip: string | null): Promise<boolean> {
    const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
    const failure = { username, success: false, reason: { notIn: ['LOCKED', 'REAUTH_FAILED'] } };

    // الفشل يُحتسب بعد آخر دخول ناجح من نفس (المستخدم + العنوان)
    const lastSuccess = await this.prisma.loginAttempt.findFirst({
      where: { username, ip, success: true, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const pairFailures = await this.prisma.loginAttempt.count({
      where: { ...failure, ip, createdAt: { gt: lastSuccess?.createdAt ?? since } },
    });
    if (pairFailures >= MAX_FAILURES_PER_USER_IP) return true;

    const usernameFailures = await this.prisma.loginAttempt.count({ where: { ...failure, createdAt: { gte: since } } });
    return usernameFailures >= MAX_FAILURES_PER_USERNAME;
  }

  private async failLogin(username: string, userId: string | null, meta: RequestMeta, reason: FailureReason) {
    await this.recordAttempt(username, userId, meta, false, reason);
    const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
    const failures = await this.prisma.loginAttempt.count({
      where: { username, ip: meta.ip, success: false, reason: { notIn: ['LOCKED', 'REAUTH_FAILED'] }, createdAt: { gte: since } },
    });
    // إشعار واحد عند بلوغ الحد (لا عند كل محاولة بعده)
    if (failures === MAX_FAILURES_PER_USER_IP) {
      await this.audit.log({ action: 'auth.login_locked', metadata: { username }, meta });
      await this.notifications.notifyAdmin({
        type: 'UNUSUAL_LOGIN',
        title: 'محاولات دخول فاشلة متكررة',
        body: `${failures} محاولات دخول فاشلة للحساب «${username.slice(0, 32)}» من العنوان ${meta.ip ?? 'غير معروف'}. تم حظر المحاولات مؤقتًا.`,
        data: { username, ip: meta.ip },
      });
    }
  }

  private async recordAttempt(
    username: string,
    userId: string | null,
    meta: RequestMeta,
    success: boolean,
    reason: FailureReason | 'OK',
  ): Promise<void> {
    await this.prisma.loginAttempt.create({
      data: { username: username.slice(0, 64), userId, ip: meta.ip, userAgent: meta.userAgent, success, reason },
    });
  }

  private async isUnusualLogin(userId: string, ip: string | null): Promise<boolean> {
    const previous = await this.prisma.loginAttempt.count({ where: { userId, success: true } });
    if (previous === 0) return false;
    return (await this.prisma.loginAttempt.count({ where: { userId, success: true, ip } })) === 0;
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const result = await this.prisma.userRecoveryCode.updateMany({
      where: { userId, codeHash: this.totp.hashRecoveryCode(code), usedAt: null },
      data: { usedAt: new Date() },
    });
    return result.count === 1;
  }

  // ───────────────────────────── الجلسة الحالية ─────────────────────────────

  describe(auth: AuthContext) {
    return {
      user: auth.user,
      csrfToken: this.sessions.csrfTokenFor(auth.session.tokenHash),
      session: {
        id: auth.session.id,
        rememberDevice: auth.session.rememberDevice,
        expiresAt: auth.session.expiresAt,
        reauthValidUntil: this.sessions.reauthValidUntil(auth.session.reauthAt),
      },
    };
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(auth.session.id, 'LOGOUT');
    await this.audit.log({ action: 'auth.logout', actor: auth, entityType: 'session', entityId: auth.session.id, meta });
  }

  /** إعادة إدخال كلمة المرور قبل العمليات الحساسة. الفشل المتكرر يلغي الجلسة. */
  async reauthenticate(auth: AuthContext, password: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.recordAttempt(user.username, user.id, meta, false, 'REAUTH_FAILED');
      const failures = await this.prisma.loginAttempt.count({
        where: { userId: user.id, reason: 'REAUTH_FAILED', createdAt: { gte: new Date(Date.now() - LOCKOUT_WINDOW_MS) } },
      });
      if (failures >= MAX_FAILURES_PER_USER_IP) {
        await this.sessions.revoke(auth.session.id, 'REAUTH_FAILURES');
        await this.audit.log({ action: 'auth.session_revoked', actor: auth, metadata: { reason: 'REAUTH_FAILURES' }, meta });
        throw Errors.unauthenticated();
      }
      throw Errors.invalidPassword();
    }
    const reauthAt = await this.sessions.markReauthenticated(auth.session.id);
    await this.audit.log({ action: 'auth.reauth', actor: auth, meta });
    return { reauthValidUntil: this.sessions.reauthValidUntil(reauthAt) };
  }

  async changePassword(auth: AuthContext, dto: ChangePasswordDto, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      await this.recordAttempt(user.username, user.id, meta, false, 'REAUTH_FAILED');
      throw Errors.invalidPassword();
    }
    if (dto.currentPassword === dto.newPassword) {
      throw Errors.validation('كلمة المرور الجديدة يجب أن تختلف عن الحالية');
    }
    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
      await this.audit.log({ action: 'auth.password_changed', actor: auth, entityType: 'user', entityId: user.id, meta }, tx);
    });
    const revoked = await this.sessions.revokeAllForUser(user.id, 'PASSWORD_CHANGED', auth.session.id);
    return { revokedOtherSessions: revoked };
  }

  async listSessions(auth: AuthContext) {
    const now = new Date();
    const sessions = await this.prisma.session.findMany({
      where: { userId: auth.user.id, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, ip: true, userAgent: true, rememberDevice: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    });
    return sessions
      .filter((s) => s.rememberDevice || now.getTime() - s.lastSeenAt.getTime() <= this.config.sessionIdleMs)
      .map((s) => ({ ...s, current: s.id === auth.session.id }));
  }

  async revokeOwnSession(auth: AuthContext, sessionId: string, meta: RequestMeta): Promise<void> {
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, userId: auth.user.id } });
    if (!session) throw Errors.notFound('الجلسة غير موجودة');
    await this.sessions.revoke(session.id, 'REVOKED_BY_USER');
    await this.audit.log({ action: 'auth.session_revoked', actor: auth, entityType: 'session', entityId: session.id, meta });
  }

  // ───────────────────────── المصادقة الثنائية (اختيارية) ─────────────────────────

  async totpSetup(auth: AuthContext) {
    if (auth.user.totpEnabled) throw Errors.conflict('المصادقة الثنائية مفعّلة مسبقًا');
    const generated = this.totp.generateSecret(auth.user.username);
    await this.prisma.user.update({ where: { id: auth.user.id }, data: { totpPendingSecretEnc: generated.secretEnc } });
    return { secret: generated.secret, otpauthUrl: generated.otpauthUrl };
  }

  private async consumeTotp(userId: string, secretEnc: string, code: string): Promise<boolean> {
    const step = this.totp.verifyStep(secretEnc, code);
    if (step === null) return false;
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: userId,
        isActive: true,
        totpSecretEnc: secretEnc,
        totpEnabledAt: { not: null },
        OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
      },
      data: { totpLastUsedStep: step },
    });
    return count === 1;
  }

  async totpEnable(auth: AuthContext, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (user.totpEnabledAt) throw Errors.conflict('المصادقة الثنائية مفعّلة مسبقًا');
    if (!user.totpPendingSecretEnc) throw Errors.validation('ابدأ إعداد المصادقة الثنائية أولًا');
    // 400 وليس 401: المستخدم مسجّل الدخول، والرمز الخاطئ هنا خطأ إدخال لا فشل مصادقة
    const step = this.totp.verifyStep(user.totpPendingSecretEnc, code);
    if (step === null) throw Errors.validation('رمز التحقق غير صحيح');

    const recovery = this.totp.generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id, totpEnabledAt: null, totpPendingSecretEnc: user.totpPendingSecretEnc },
        data: { totpSecretEnc: user.totpPendingSecretEnc, totpPendingSecretEnc: null, totpEnabledAt: new Date(), totpLastUsedStep: step },
      });
      await tx.userRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.userRecoveryCode.createMany({ data: recovery.hashes.map((codeHash) => ({ userId: user.id, codeHash })) });
      await this.audit.log({ action: 'auth.2fa_enabled', actor: auth, entityType: 'user', entityId: user.id, meta }, tx);
    });
    return { recoveryCodes: recovery.codes };
  }

  async totpDisable(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: auth.user.id },
        data: { totpSecretEnc: null, totpPendingSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null },
      });
      await tx.userRecoveryCode.deleteMany({ where: { userId: auth.user.id } });
      await this.audit.log({ action: 'auth.2fa_disabled', actor: auth, entityType: 'user', entityId: auth.user.id, meta }, tx);
    });
  }
}
