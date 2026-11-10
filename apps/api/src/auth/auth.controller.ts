import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { AnyAuthenticated, Auth, Meta, Public, RequireReauth } from '../common/auth/decorators';
import { APP_CONFIG, AppConfig, getConfig } from '../common/config/env';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, ReauthDto, SetupAdminDto, TotpCodeDto } from './dto/auth.dto';
import { SessionService } from './session.service';

// حد أشد على مسارات الدخول والإعداد (لكل عنوان IP) — إضافةً إلى الحظر المؤقت المبني على قاعدة البيانات
const loginThrottle = () => ({ default: { limit: getConfig().loginRateLimitPerMinute, ttl: 60_000 } });

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('setup/status')
  @ApiOperation({ summary: 'هل يحتاج النظام إلى إنشاء الأدمن الأول؟' })
  setupStatus() {
    return this.auth.setupStatus();
  }

  @Public()
  @Throttle(loginThrottle())
  @Post('setup')
  @ApiOperation({ summary: 'إنشاء الأدمن الأول باستخدام رمز الإعداد أحادي الاستخدام' })
  setup(@Body() dto: SetupAdminDto, @Meta() meta: RequestMeta) {
    return this.auth.setupFirstAdmin(dto, meta);
  }

  @Public()
  @Throttle(loginThrottle())
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'تسجيل الدخول — يضبط كوكي الجلسة HttpOnly ويعيد رمز CSRF' })
  async login(@Body() dto: LoginDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const { token, auth } = await this.auth.login(dto, meta);
    res.cookie(
      this.config.sessionCookieName,
      token,
      this.sessions.cookieOptions(auth.session.rememberDevice, auth.session.expiresAt),
    );
    return this.auth.describe(auth);
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'تسجيل الخروج وإلغاء الجلسة في الخادم' })
  async logout(@Auth() auth: AuthContext, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(auth, meta);
    res.clearCookie(this.config.sessionCookieName, this.sessions.cookieOptions(false));
    return { ok: true };
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @Get('me')
  @ApiOperation({ summary: 'المستخدم الحالي وصلاحياته ورمز CSRF' })
  me(@Auth() auth: AuthContext) {
    return this.auth.describe(auth);
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @Throttle(loginThrottle())
  @Post('reauth')
  @HttpCode(200)
  @ApiOperation({ summary: 'إعادة إدخال كلمة المرور قبل العمليات الحساسة' })
  reauth(@Auth() auth: AuthContext, @Body() dto: ReauthDto, @Meta() meta: RequestMeta) {
    return this.auth.reauthenticate(auth, dto.password, meta);
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @Throttle(loginThrottle())
  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'تغيير كلمة المرور وإلغاء الجلسات الأخرى' })
  changePassword(@Auth() auth: AuthContext, @Body() dto: ChangePasswordDto, @Meta() meta: RequestMeta) {
    return this.auth.changePassword(auth, dto, meta);
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'الجلسات النشطة للمستخدم الحالي' })
  listSessions(@Auth() auth: AuthContext) {
    return this.auth.listSessions(auth);
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @Delete('sessions/:id')
  @ApiOperation({ summary: 'إلغاء إحدى جلسات المستخدم الحالي' })
  async revokeSession(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta) {
    await this.auth.revokeOwnSession(auth, id, meta);
    return { ok: true };
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @RequireReauth()
  @Post('2fa/setup')
  @HttpCode(200)
  @ApiOperation({ summary: 'بدء إعداد المصادقة الثنائية (يعيد السر ورابط otpauth)' })
  totpSetup(@Auth() auth: AuthContext) {
    return this.auth.totpSetup(auth);
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @Post('2fa/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'تأكيد المصادقة الثنائية برمز من التطبيق — يعيد رموز الاسترداد مرة واحدة' })
  totpEnable(@Auth() auth: AuthContext, @Body() dto: TotpCodeDto, @Meta() meta: RequestMeta) {
    return this.auth.totpEnable(auth, dto.code, meta);
  }

  @AnyAuthenticated()
  @ApiCookieAuth()
  @RequireReauth()
  @Post('2fa/disable')
  @HttpCode(200)
  @ApiOperation({ summary: 'تعطيل المصادقة الثنائية (يتطلب إعادة إدخال كلمة المرور)' })
  async totpDisable(@Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    await this.auth.totpDisable(auth, meta);
    return { ok: true };
  }
}
