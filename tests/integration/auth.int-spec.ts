import { authenticator } from 'otplib';
import request from 'supertest';
import { ADMIN, Client, createSupervisor, createTestApp, resetDatabase, setupAdmin, SUPERVISOR, TestContext } from './helpers';

describe('المصادقة والجلسات', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  describe('إعداد الأدمن الأول', () => {
    it('يرفض رمز إعداد خاطئًا ولا ينشئ أي حساب', async () => {
      const client = new Client(ctx.app);
      expect((await client.get('/auth/setup/status')).body).toEqual({ needsSetup: true, setupEnabled: true });

      const res = await client.post('/auth/setup', { ...ADMIN, setupToken: 'wrong-token-wrong-token-wrong-token' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SETUP_TOKEN_INVALID');
      expect(await ctx.prisma.user.count()).toBe(0);
    });

    it('ينشئ الأدمن بالرمز الصحيح ثم يتعطل الإعداد نهائيًا (أحادي الاستخدام)', async () => {
      const client = new Client(ctx.app);
      const res = await client.post('/auth/setup', { ...ADMIN, setupToken: ctx.setupToken });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: expect.any(String), username: ADMIN.username });

      const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { username: ADMIN.username } });
      expect(admin.role).toBe('ADMIN');
      expect(admin.passwordHash).toMatch(/^\$argon2id\$/);

      const again = await client.post('/auth/setup', { ...ADMIN, username: 'attacker', setupToken: ctx.setupToken });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('SETUP_ALREADY_COMPLETED');
      expect((await client.get('/auth/setup/status')).body).toEqual({ needsSetup: false, setupEnabled: false });
      expect(await ctx.prisma.user.count()).toBe(1);
    });

    it('طلبان متزامنان لا ينتجان إلا أدمن واحدًا', async () => {
      const attempt = (username: string) =>
        new Client(ctx.app).post('/auth/setup', { ...ADMIN, username, setupToken: ctx.setupToken });
      const results = await Promise.all([attempt('admin.a'), attempt('admin.b'), attempt('admin.c')]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await ctx.prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
    });

    it('يرفض كلمة مرور ضعيفة', async () => {
      const res = await new Client(ctx.app).post('/auth/setup', { ...ADMIN, password: 'weak', setupToken: ctx.setupToken });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('تسجيل الدخول', () => {
    it('دخول صحيح: كوكي HttpOnly ورمز CSRF وبيانات المستخدم', async () => {
      await setupAdmin(ctx);
      const client = new Client(ctx.app);
      const res = await client.login(ADMIN.username.toUpperCase(), ADMIN.password);

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ username: ADMIN.username, role: 'ADMIN', permissions: [] });
      expect(res.body.csrfToken).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');

      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('aq_session='));
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      // دون "تذكر الجهاز": كوكي جلسة بلا تاريخ انتهاء
      expect(cookie).not.toMatch(/Expires=/i);

      const me = await client.get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user.username).toBe(ADMIN.username);

      // الرمز المخزَّن بصمة فقط وليس الرمز نفسه
      const token = cookie!.split(';')[0].split('=')[1];
      expect(await ctx.prisma.session.count({ where: { tokenHash: token } })).toBe(0);
    });

    it('تذكر الجهاز: كوكي دائمة بمدة طويلة', async () => {
      await setupAdmin(ctx);
      const res = await new Client(ctx.app).login(ADMIN.username, ADMIN.password, { rememberDevice: true });
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('aq_session='));
      expect(cookie).toMatch(/Expires=/i);
      const session = await ctx.prisma.session.findFirstOrThrow({ where: { rememberDevice: true } });
      expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    });

    it('كلمة مرور خاطئة واسم مستخدم مجهول يعيدان الرد نفسه وتُسجَّل المحاولة', async () => {
      await setupAdmin(ctx);
      const wrong = await new Client(ctx.app).login(ADMIN.username, 'Wrong-Password-1');
      const unknown = await new Client(ctx.app).login('nobody', 'Wrong-Password-1');

      for (const res of [wrong, unknown]) {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('INVALID_CREDENTIALS');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      expect(wrong.body.message).toBe(unknown.body.message);
      expect(await ctx.prisma.loginAttempt.count({ where: { success: false, reason: 'INVALID_CREDENTIALS' } })).toBe(2);
    });

    it('حساب معطّل: يُرفض الدخول وتُلغى جلساته القائمة فورًا', async () => {
      const admin = await setupAdmin(ctx);
      const supervisor = await createSupervisor(ctx, admin, ['employees.view']);
      expect((await supervisor.client.get('/auth/me')).status).toBe(200);

      const disable = await admin.patch(`/users/${supervisor.id}`, { isActive: false });
      expect(disable.status).toBe(200);

      expect((await supervisor.client.get('/auth/me')).status).toBe(401);
      const login = await new Client(ctx.app).login(SUPERVISOR.username, SUPERVISOR.password);
      expect(login.status).toBe(403);
      expect(login.body.code).toBe('ACCOUNT_DISABLED');
    });

    it('حظر مؤقت بعد 5 محاولات فاشلة حتى مع كلمة المرور الصحيحة، مع إشعار للأدمن', async () => {
      await setupAdmin(ctx);
      for (let i = 0; i < 5; i++) {
        expect((await new Client(ctx.app).login(ADMIN.username, 'Wrong-Password-1')).status).toBe(401);
      }
      const locked = await new Client(ctx.app).login(ADMIN.username, ADMIN.password);
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('TOO_MANY_ATTEMPTS');

      const notifications = await ctx.prisma.notification.findMany({ where: { type: 'UNUSUAL_LOGIN' } });
      expect(notifications).toHaveLength(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.login_locked' } })).toBe(1);
    });
  });

  describe('الجلسات', () => {
    it('جلسة منتهية (مدة مطلقة) تُرفض', async () => {
      const admin = await setupAdmin(ctx);
      await ctx.prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await admin.get('/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    it('جلسة خاملة أكثر من الحد تُرفض، وجلسة "تذكر الجهاز" لا تنتهي بالخمول', async () => {
      const admin = await setupAdmin(ctx);
      const remembered = new Client(ctx.app);
      await remembered.login(ADMIN.username, ADMIN.password, { rememberDevice: true });

      await ctx.prisma.session.updateMany({ data: { lastSeenAt: new Date(Date.now() - 3 * 3_600_000) } });
      expect((await admin.get('/auth/me')).status).toBe(401);
      expect((await remembered.get('/auth/me')).status).toBe(200);
    });

    it('تسجيل الخروج يلغي الجلسة في الخادم فلا يُقبل الكوكي بعده', async () => {
      const admin = await setupAdmin(ctx);
      const second = new Client(ctx.app);
      const login = await second.login(ADMIN.username, ADMIN.password);
      const copiedCookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      expect(copiedCookie).toContain('aq_session=');

      const logout = await second.post('/auth/logout');
      expect(logout.status).toBe(200);
      expect((await second.get('/auth/me')).status).toBe(401);

      // كوكي الجلسة الملغاة لا يعمل حتى لو نُسخ قبل الخروج وأعيد إرساله يدويًا
      const replay = await request(ctx.app.getHttpServer()).get('/auth/me').set('Cookie', copiedCookie);
      expect(replay.status).toBe(401);
      const session = await ctx.prisma.session.findFirstOrThrow({ where: { revokedReason: 'LOGOUT' } });
      expect(session.revokedAt).not.toBeNull();

      // الجلسات الأخرى تبقى سليمة
      expect((await admin.get('/auth/me')).status).toBe(200);
    });

    it('إلغاء جلسة جهاز آخر من قائمة الجلسات', async () => {
      const admin = await setupAdmin(ctx);
      const other = new Client(ctx.app);
      await other.login(ADMIN.username, ADMIN.password);

      const list = await admin.get('/auth/sessions');
      expect(list.body).toHaveLength(2);
      const target = list.body.find((s: { current: boolean }) => !s.current);

      expect((await admin.delete(`/auth/sessions/${target.id}`)).status).toBe(200);
      expect((await other.get('/auth/me')).status).toBe(401);
      expect((await admin.get('/auth/me')).status).toBe(200);
    });

    it('تغيير كلمة المرور يلغي الجلسات الأخرى ويبطل الكلمة القديمة', async () => {
      const admin = await setupAdmin(ctx);
      const other = new Client(ctx.app);
      await other.login(ADMIN.username, ADMIN.password);

      const wrong = await admin.post('/auth/change-password', { currentPassword: 'Wrong-Password-1', newPassword: 'New-Admin-Pass-2027' });
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe('INVALID_PASSWORD');

      const ok = await admin.post('/auth/change-password', { currentPassword: ADMIN.password, newPassword: 'New-Admin-Pass-2027' });
      expect(ok.status).toBe(200);
      expect(ok.body.revokedOtherSessions).toBe(1);
      expect((await other.get('/auth/me')).status).toBe(401);
      expect((await admin.get('/auth/me')).status).toBe(200);

      expect((await new Client(ctx.app).login(ADMIN.username, ADMIN.password)).status).toBe(401);
      expect((await new Client(ctx.app).login(ADMIN.username, 'New-Admin-Pass-2027')).status).toBe(200);
    });
  });

  describe('CSRF ومصدر الطلب', () => {
    it('طلب مغيِّر للحالة دون رمز CSRF أو برمز خاطئ يُرفض', async () => {
      const admin = await setupAdmin(ctx);
      const missing = await admin.send('post', '/auth/logout', {}, { csrf: null });
      expect(missing.status).toBe(403);
      expect(missing.body.code).toBe('CSRF_FAILED');

      const wrong = await admin.send('post', '/auth/logout', {}, { csrf: 'forged-token' });
      expect(wrong.status).toBe(403);
      expect((await admin.get('/auth/me')).status).toBe(200);
    });

    it('رمز CSRF لجلسة لا يصلح لجلسة أخرى', async () => {
      const admin = await setupAdmin(ctx);
      const other = new Client(ctx.app);
      await other.login(ADMIN.username, ADMIN.password);
      const res = await admin.send('post', '/auth/logout', {}, { csrf: other.csrfToken });
      expect(res.status).toBe(403);
    });

    it('طلب من مصدر غير مسموح يُرفض حتى على المسارات العامة', async () => {
      await setupAdmin(ctx);
      const res = await new Client(ctx.app).send(
        'post',
        '/auth/login',
        { username: ADMIN.username, password: ADMIN.password },
        { origin: 'https://evil.example' },
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORIGIN_NOT_ALLOWED');
    });
  });

  describe('إعادة التحقق من كلمة المرور للعمليات الحساسة', () => {
    it('العملية الحساسة تُرفض بعد انقضاء النافذة وتنجح بعد إعادة إدخال كلمة المرور', async () => {
      const admin = await setupAdmin(ctx);
      await ctx.prisma.session.updateMany({ data: { reauthAt: new Date(Date.now() - 10 * 60_000) } });

      const blocked = await admin.post('/users', { ...SUPERVISOR });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('REAUTH_REQUIRED');
      expect(await ctx.prisma.user.count()).toBe(1);

      const bad = await admin.post('/auth/reauth', { password: 'Wrong-Password-1' });
      expect(bad.status).toBe(403);
      expect(bad.body.code).toBe('INVALID_PASSWORD');

      const good = await admin.post('/auth/reauth', { password: ADMIN.password });
      expect(good.status).toBe(200);
      expect(good.body.reauthValidUntil).toEqual(expect.any(String));
      expect((await admin.post('/users', { ...SUPERVISOR })).status).toBe(201);
    });

    it('فشل متكرر في إعادة التحقق يلغي الجلسة', async () => {
      const admin = await setupAdmin(ctx);
      for (let i = 0; i < 4; i++) {
        expect((await admin.post('/auth/reauth', { password: 'Wrong-Password-1' })).status).toBe(403);
      }
      expect((await admin.post('/auth/reauth', { password: 'Wrong-Password-1' })).status).toBe(401);
      expect((await admin.get('/auth/me')).status).toBe(401);
    });
  });

  describe('المصادقة الثنائية الاختيارية', () => {
    it('تفعيل TOTP ثم اشتراطه عند الدخول، ورمز الاسترداد يُستخدم مرة واحدة', async () => {
      const admin = await setupAdmin(ctx);
      const setup = await admin.post('/auth/2fa/setup');
      expect(setup.status).toBe(200);
      expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      const secret: string = setup.body.secret;

      // السر لا يُخزَّن كنص صريح
      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { username: ADMIN.username } });
      expect(stored.totpPendingSecretEnc).not.toContain(secret);

      expect((await admin.post('/auth/2fa/enable', { code: '000000' })).status).toBe(400);
      const enable = await admin.post('/auth/2fa/enable', { code: authenticator.generate(secret) });
      expect(enable.status).toBe(200);
      expect(enable.body.recoveryCodes).toHaveLength(8);

      const noCode = await new Client(ctx.app).login(ADMIN.username, ADMIN.password);
      expect(noCode.status).toBe(401);
      expect(noCode.body.code).toBe('TOTP_REQUIRED');

      const badCode = await new Client(ctx.app).login(ADMIN.username, ADMIN.password, { totpCode: '123456' });
      expect(badCode.status).toBe(401);
      expect(badCode.body.code).toBe('INVALID_TOTP');

      const good = await new Client(ctx.app).login(ADMIN.username, ADMIN.password, { totpCode: authenticator.generate(secret) });
      expect(good.status).toBe(200);
      expect(good.body.user.totpEnabled).toBe(true);

      const recovery: string = enable.body.recoveryCodes[0];
      expect((await new Client(ctx.app).login(ADMIN.username, ADMIN.password, { totpCode: recovery })).status).toBe(200);
      expect((await new Client(ctx.app).login(ADMIN.username, ADMIN.password, { totpCode: recovery })).status).toBe(401);

      expect((await admin.post('/auth/2fa/disable')).status).toBe(200);
      expect((await new Client(ctx.app).login(ADMIN.username, ADMIN.password)).status).toBe(200);
    });
  });

  it('المسارات المحمية ترفض الزائر غير المسجّل، وفحص الصحة عام', async () => {
    const anon = new Client(ctx.app);
    for (const url of ['/auth/me', '/users', '/audit-logs', '/settings', '/dashboard/summary', '/notifications', '/permissions']) {
      const res = await anon.get(url);
      expect([url, res.status]).toEqual([url, 401]);
    }
    const health = await anon.get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', database: 'up' });
  });
});
