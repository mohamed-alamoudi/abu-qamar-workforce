import { PERMISSION_KEYS } from '@abu-qamar/shared';
import { ADMIN, Client, createSupervisor, createTestApp, resetDatabase, setupAdmin, SUPERVISOR, TestContext } from './helpers';

describe('المستخدمون والصلاحيات وسجل التدقيق', () => {
  let ctx: TestContext;
  let admin: Client;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await setupAdmin(ctx);
  });

  describe('منع المراقب من صلاحيات الأدمن (مفروض في الخادم)', () => {
    it('كل مسارات الإدارة ترفض المراقب حتى لو مُنح كل صلاحيات الكتالوج', async () => {
      const supervisor = await createSupervisor(ctx, admin, [...PERMISSION_KEYS]);
      const s = supervisor.client;
      const adminId = (await admin.get('/auth/me')).body.user.id;

      const attempts = [
        await s.get('/users'),
        await s.get(`/users/${adminId}`),
        await s.post('/users', { username: 'sneaky', fullName: 'متسلل', password: 'Sneaky-Pass-2026' }),
        await s.patch(`/users/${supervisor.id}`, { fullName: 'اسم جديد' }),
        await s.put(`/users/${supervisor.id}/permissions`, { permissions: ['finance.view'] }),
        await s.post(`/users/${adminId}/reset-password`, { newPassword: 'Hijack-Pass-2026' }),
        await s.post(`/users/${adminId}/revoke-sessions`),
        await s.get('/audit-logs'),
        await s.get('/permissions'),
        await s.patch('/settings', { currency: 'USD' }),
      ];
      for (const res of attempts) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ADMIN_ONLY');
      }
      // لم يتغير شيء فعليًا
      expect(await ctx.prisma.user.count()).toBe(2);
      expect((await admin.get('/auth/me')).status).toBe(200);
    });

    it('لا يمكن منح صلاحية خارج الكتالوج (مثل اعتماد الرواتب) لأي مراقب', async () => {
      const supervisor = await createSupervisor(ctx, admin);
      for (const key of ['payroll.approve', 'payments.create', 'users.manage', 'backups.restore']) {
        const res = await admin.put(`/users/${supervisor.id}/permissions`, { permissions: [key] });
        expect(res.status).toBe(400);
      }
      const created = await admin.post('/users', {
        username: 'supervisor2',
        fullName: 'مراقب ثانٍ',
        password: 'Super-Test-Pass-2026',
        permissions: ['settlements.create'],
      });
      expect(created.status).toBe(400);
      expect(await ctx.prisma.userPermission.count()).toBe(0);
    });
  });

  describe('إدارة المراقبين', () => {
    it('إنشاء مراقب بصلاحيات فردية، ورفض اسم مستخدم مكرر', async () => {
      const res = await admin.post('/users', { ...SUPERVISOR, permissions: ['employees.view', 'attendance.check_in'] });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        username: SUPERVISOR.username,
        role: 'SUPERVISOR',
        isActive: true,
        permissions: ['attendance.check_in', 'employees.view'],
      });
      expect(res.body.passwordHash).toBeUndefined();

      const duplicate = await admin.post('/users', { ...SUPERVISOR });
      expect(duplicate.status).toBe(409);
    });

    it('تعديل الصلاحيات يسري فورًا على جلسة المراقب القائمة', async () => {
      const supervisor = await createSupervisor(ctx, admin, ['employees.view']);
      expect((await supervisor.client.get('/auth/me')).body.user.permissions).toEqual(['employees.view']);

      const res = await admin.put(`/users/${supervisor.id}/permissions`, {
        permissions: ['attendance.check_in', 'attendance.check_out'],
      });
      expect(res.status).toBe(200);
      expect((await supervisor.client.get('/auth/me')).body.user.permissions.sort()).toEqual([
        'attendance.check_in',
        'attendance.check_out',
      ]);

      await admin.put(`/users/${supervisor.id}/permissions`, { permissions: [] });
      expect((await supervisor.client.get('/auth/me')).body.user.permissions).toEqual([]);
    });

    it('حساب الأدمن الرئيسي محمي: لا يُعطَّل ولا تُعدَّل صلاحياته ولا يُنشأ أدمن ثانٍ', async () => {
      const adminId = (await admin.get('/auth/me')).body.user.id;
      expect((await admin.patch(`/users/${adminId}`, { isActive: false })).status).toBe(403);
      expect((await admin.put(`/users/${adminId}/permissions`, { permissions: [] })).status).toBe(403);
      expect((await admin.post(`/users/${adminId}/reset-password`, { newPassword: 'Another-Pass-2026' })).status).toBe(403);

      // لا يمكن تمرير الدور عبر الـ API (حقول غير معروفة تُرفض)
      const withRole = await admin.post('/users', { ...SUPERVISOR, role: 'ADMIN' });
      expect(withRole.status).toBe(400);

      // وقاعدة البيانات نفسها ترفض أدمن ثانيًا أو تعطيل الأدمن
      await expect(
        ctx.prisma.user.create({ data: { username: 'admin2', fullName: 'أدمن ثانٍ', passwordHash: 'x', role: 'ADMIN' } }),
      ).rejects.toThrow();
      await expect(ctx.prisma.user.update({ where: { id: adminId }, data: { isActive: false } })).rejects.toThrow();
    });

    it('إعادة تفعيل مراقب معطّل تسمح له بالدخول مجددًا', async () => {
      const supervisor = await createSupervisor(ctx, admin);
      await admin.patch(`/users/${supervisor.id}`, { isActive: false });
      expect((await new Client(ctx.app).login(SUPERVISOR.username, SUPERVISOR.password)).status).toBe(403);

      const enabled = await admin.patch(`/users/${supervisor.id}`, { isActive: true });
      expect(enabled.body).toMatchObject({ isActive: true, disabledAt: null });
      expect((await new Client(ctx.app).login(SUPERVISOR.username, SUPERVISOR.password)).status).toBe(200);
    });

    it('إعادة تعيين كلمة المرور تلغي جلسات المراقب وتبطل الكلمة القديمة', async () => {
      const supervisor = await createSupervisor(ctx, admin);
      const res = await admin.post(`/users/${supervisor.id}/reset-password`, { newPassword: 'Reset-Pass-2026-x' });
      expect(res.status).toBe(200);

      expect((await supervisor.client.get('/auth/me')).status).toBe(401);
      expect((await new Client(ctx.app).login(SUPERVISOR.username, SUPERVISOR.password)).status).toBe(401);
      expect((await new Client(ctx.app).login(SUPERVISOR.username, 'Reset-Pass-2026-x')).status).toBe(200);
    });

    it('البحث والتصفية والترقيم في قائمة المستخدمين', async () => {
      await createSupervisor(ctx, admin);
      await createSupervisor(ctx, admin, [], { username: 'cashier.lead', fullName: 'مسؤول الصندوق' });

      const all = await admin.get('/users?pageSize=2');
      expect(all.body).toMatchObject({ total: 3, page: 1, pageSize: 2, totalPages: 2 });
      expect(all.body.items[0].role).toBe('ADMIN');

      const search = await admin.get(`/users?search=${encodeURIComponent('الصندوق')}`);
      expect(search.body.items.map((u: { username: string }) => u.username)).toEqual(['cashier.lead']);
      expect((await admin.get('/users?pageSize=500')).status).toBe(400);
    });
  });

  describe('سجل التدقيق', () => {
    it('يسجل الأحداث الحساسة بالقيم القديمة والجديدة دون أي أسرار', async () => {
      const supervisor = await createSupervisor(ctx, admin, ['employees.view']);
      await admin.put(`/users/${supervisor.id}/permissions`, { permissions: ['finance.view'] });
      await admin.patch(`/users/${supervisor.id}`, { isActive: false });

      const res = await admin.get(`/audit-logs?entityType=user&entityId=${supervisor.id}`);
      expect(res.status).toBe(200);
      const actions = res.body.items.map((l: { action: string }) => l.action);
      expect(actions).toEqual(['user.disabled', 'user.permissions_changed', 'user.created']);

      const change = res.body.items[1];
      expect(change.before).toEqual({ permissions: ['employees.view'] });
      expect(change.after).toEqual({ permissions: ['finance.view'] });
      expect(change.actorUsername).toBe(ADMIN.username);

      const everything = JSON.stringify((await admin.get('/audit-logs?pageSize=100')).body);
      expect(everything).not.toContain(SUPERVISOR.password);
      expect(everything).not.toContain(ADMIN.password);
      expect(everything).not.toContain('$argon2');

      const authOnly = await admin.get('/audit-logs?action=auth.');
      expect(authOnly.body.items.every((l: { action: string }) => l.action.startsWith('auth.'))).toBe(true);
      expect(authOnly.body.total).toBeGreaterThanOrEqual(2);
    });

    it('سجل التدقيق للإضافة فقط: قاعدة البيانات ترفض التعديل والحذف', async () => {
      const log = await ctx.prisma.auditLog.findFirstOrThrow();
      await expect(ctx.prisma.auditLog.update({ where: { id: log.id }, data: { action: 'tampered' } })).rejects.toThrow();
      await expect(ctx.prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow();
      await expect(ctx.prisma.auditLog.deleteMany()).rejects.toThrow();
      expect((await ctx.prisma.auditLog.findUniqueOrThrow({ where: { id: log.id } })).action).toBe(log.action);
    });
  });

  describe('الإعدادات ولوحة التحكم والإشعارات', () => {
    it('الإعدادات الافتراضية (شيكل، غزة، السبت) وتعديلها مع التحقق', async () => {
      const defaults = await admin.get('/settings');
      expect(defaults.body).toMatchObject({
        'general.currency': 'ILS',
        'general.timezone': 'Asia/Gaza',
        'general.weekStartsOn': 6,
        'payroll.defaultOvertimeMultiplier': 1.5,
      });

      expect((await admin.patch('/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);
      expect((await admin.patch('/settings', { weekStartsOn: 9 })).status).toBe(400);
      expect((await admin.patch('/settings', { unknownKey: 1 })).status).toBe(400);

      const updated = await admin.patch('/settings', { defaultOvertimeMultiplier: 1.25, organizationName: 'أبو قمر' });
      expect(updated.status).toBe(200);
      expect(updated.body['payroll.defaultOvertimeMultiplier']).toBe(1.25);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'settings.updated' } })).toBe(1);

      // المراقب يقرأ الإعدادات العامة فقط
      const supervisor = await createSupervisor(ctx, admin);
      expect((await supervisor.client.get('/settings')).status).toBe(200);
    });

    it('لوحة التحكم: أصفار حقيقية للأدمن على قاعدة فارغة، وحجب ما لا يملكه المراقب', async () => {
      for (const period of ['day', 'week', 'month']) {
        const res = await admin.get(`/dashboard/summary?period=${period}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          period,
          currency: 'ILS',
          employeesWorked: 0,
          totalWorkedMinutes: 0,
          totalPayments: '0.00',
          unpaidWages: '0.00',
        });
      }
      expect((await admin.get('/dashboard/summary?period=year')).status).toBe(400);

      const none = await createSupervisor(ctx, admin);
      expect((await none.client.get('/dashboard/summary')).body).toMatchObject({
        employeesWorked: null,
        totalWorkedMinutes: null,
        totalPayments: null,
        unpaidWages: null,
      });

      const attendanceOnly = await createSupervisor(ctx, admin, ['attendance.view'], { username: 'supervisor2' });
      expect((await attendanceOnly.client.get('/dashboard/summary')).body).toMatchObject({
        employeesWorked: 0,
        totalWorkedMinutes: 0,
        totalPayments: null,
        unpaidWages: null,
      });
    });

    it('الإشعارات خاصة بصاحبها ويمكن تعليمها كمقروءة', async () => {
      const adminId = (await admin.get('/auth/me')).body.user.id;
      const supervisor = await createSupervisor(ctx, admin);
      const note = await ctx.prisma.notification.create({
        data: { userId: adminId, type: 'BACKUP_FAILED', title: 'فشل نسخة احتياطية', body: 'اختبار' },
      });

      const mine = await admin.get('/notifications');
      expect(mine.body).toMatchObject({ total: 1, unreadCount: 1 });
      expect((await supervisor.client.get('/notifications')).body).toMatchObject({ total: 0, unreadCount: 0 });
      expect((await supervisor.client.post(`/notifications/${note.id}/read`)).status).toBe(404);

      expect((await admin.post(`/notifications/${note.id}/read`)).status).toBe(200);
      expect((await admin.get('/notifications?unreadOnly=true')).body).toMatchObject({ total: 0, unreadCount: 0 });
    });
  });
});
