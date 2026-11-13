import { Client, createSupervisor, createTestApp, resetDatabase, setupAdmin, TestContext } from './helpers';

const HOURLY = { payType: 'HOURLY', amount: 20, effectiveFrom: '2026-01-01' };

describe('الموظفون والأقسام', () => {
  let ctx: TestContext;
  let admin: Client;
  let cashier: string;
  let bakery: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await setupAdmin(ctx);
    cashier = (await admin.post('/departments', { name: 'الكاشير' })).body.id;
    bakery = (await admin.post('/departments', { name: 'المخبز' })).body.id;
  });

  const addEmployee = async (overrides: Record<string, unknown> = {}) => {
    const res = await admin.post('/employees', { fullName: 'أحمد سالم', phone: '0599123456', departmentId: cashier, pay: HOURLY, ...overrides });
    if (res.status !== 201) throw new Error(`فشل إنشاء الموظف: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; code: string; version: number };
  };

  describe('الأقسام', () => {
    it('إضافة وتعديل، ورفض الاسم المكرر (دون حساسية للمسافات)', async () => {
      expect((await admin.post('/departments', { name: '  الكاشير ' })).status).toBe(409);
      const renamed = await admin.patch(`/departments/${bakery}`, { name: 'المخبز والحلويات' });
      expect(renamed.body.name).toBe('المخبز والحلويات');
      expect((await admin.patch(`/departments/${bakery}`, { name: 'الكاشير' })).status).toBe(409);

      const list = await admin.get('/departments');
      expect(list.body.map((d: { name: string }) => d.name)).toEqual(['الكاشير', 'المخبز والحلويات']);
    });

    it('قسم مرتبط بسجلات لا يُحذف بل يُعطَّل، وقسم فيه موظفون نشطون لا يُعطَّل', async () => {
      const employee = await addEmployee();
      expect((await admin.delete(`/departments/${cashier}`)).status).toBe(409);
      expect((await admin.patch(`/departments/${cashier}`, { isActive: false })).status).toBe(409);

      // بعد نقل الموظف: يُعطَّل القسم لكنه لا يُحذف لأن تاريخه مرتبط به
      await admin.post(`/employees/${employee.id}/transfer`, { departmentId: bakery });
      expect((await admin.patch(`/departments/${cashier}`, { isActive: false })).body.isActive).toBe(false);
      expect((await admin.delete(`/departments/${cashier}`)).status).toBe(409);
      expect((await admin.post('/employees', { fullName: 'موظف جديد', departmentId: cashier, pay: HOURLY })).status).toBe(400);

      // قسم لم يرتبط بشيء يُحذف
      const empty = (await admin.post('/departments', { name: 'قسم مؤقت' })).body.id;
      expect((await admin.delete(`/departments/${empty}`)).status).toBe(200);
      expect(await ctx.prisma.department.count()).toBe(2);
    });

    it('إدارة الأقسام للأدمن فقط، والقراءة لأي مستخدم مسجّل', async () => {
      const supervisor = await createSupervisor(ctx, admin, ['employees.view', 'employees.create', 'employees.update']);
      expect((await supervisor.client.get('/departments')).status).toBe(200);
      expect((await supervisor.client.post('/departments', { name: 'قسم' })).body.code).toBe('ADMIN_ONLY');
      expect((await supervisor.client.patch(`/departments/${cashier}`, { name: 'س' })).body.code).toBe('ADMIN_ONLY');
      expect((await supervisor.client.delete(`/departments/${cashier}`)).body.code).toBe('ADMIN_ONLY');
    });
  });

  describe('إضافة وتعديل الموظفين', () => {
    it('إضافة موظف: كود تلقائي فريد، أجر ابتدائي، وتاريخ قسم', async () => {
      const first = await admin.post('/employees', { fullName: '  أحمد   سالم ', phone: '0599123456', departmentId: cashier, pay: HOURLY });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        code: 'EMP-0001',
        fullName: 'أحمد سالم',
        status: 'ACTIVE',
        terminationDate: null,
        department: { id: cashier, name: 'الكاشير' },
        version: 1,
        payVisible: true,
        currentPay: { payType: 'HOURLY', amount: '20.00', effectiveFrom: '2026-01-01' },
      });
      expect((await addEmployee({ fullName: 'سارة علي' })).code).toBe('EMP-0002');

      const history = await admin.get(`/employees/${first.body.id}/department-history`);
      expect(history.body).toHaveLength(1);
      expect(history.body[0]).toMatchObject({ department: { name: 'الكاشير' }, effectiveFrom: '2026-01-01', effectiveTo: null });
    });

    it('يرفض المدخلات غير الصالحة والحقول غير المسموحة', async () => {
      const base = { fullName: 'أحمد سالم', departmentId: cashier, pay: HOURLY };
      const bad: Record<string, unknown>[] = [
        { ...base, fullName: 'أ' },
        { ...base, phone: 'abc' },
        { ...base, departmentId: '00000000-0000-4000-8000-000000000000' },
        { ...base, pay: undefined },
        { ...base, pay: { ...HOURLY, amount: 0 } },
        { ...base, pay: { ...HOURLY, amount: 10.555 } },
        { ...base, pay: { ...HOURLY, payType: 'WEEKLY' } },
        { ...base, pay: { ...HOURLY, effectiveFrom: '2026-02-30' } },
        { ...base, pay: { payType: 'HOURLY', amount: 20 } },
        // حقول ممنوعة بنص المتطلبات أو غير معروفة
        { ...base, address: 'غزة' },
        { ...base, code: 'EMP-9999' },
        { ...base, status: 'INACTIVE' },
      ];
      for (const body of bad) {
        const res = await admin.post('/employees', body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      }
      expect(await ctx.prisma.employee.count()).toBe(0);
    });

    it('تعديل الاسم والهاتف مع كشف التعديل المتزامن برقم الإصدار', async () => {
      const employee = await addEmployee();
      const updated = await admin.patch(`/employees/${employee.id}`, { version: 1, fullName: 'أحمد سالم حسن', phone: '' });
      expect(updated.body).toMatchObject({ fullName: 'أحمد سالم حسن', phone: null, version: 2 });

      // جهاز آخر ما زال يحمل الإصدار القديم
      const stale = await admin.patch(`/employees/${employee.id}`, { version: 1, fullName: 'اسم من جهاز قديم' });
      expect(stale.status).toBe(409);
      expect((await admin.get(`/employees/${employee.id}`)).body.fullName).toBe('أحمد سالم حسن');
      // الأجر لا يتغير من مسار التعديل العام
      expect((await admin.patch(`/employees/${employee.id}`, { version: 2, amount: 99 })).status).toBe(400);
    });

    it('إيقاف موظف دون حذف سجلاته ثم إعادة تفعيله', async () => {
      const employee = await addEmployee();
      expect((await admin.post(`/employees/${employee.id}/deactivate`, { terminationDate: '2999-01-01' })).status).toBe(400);

      const stopped = await admin.post(`/employees/${employee.id}/deactivate`, { terminationDate: '2026-06-30' });
      expect(stopped.body).toMatchObject({ status: 'INACTIVE', terminationDate: '2026-06-30' });
      expect((await admin.post(`/employees/${employee.id}/deactivate`)).status).toBe(409);
      // السجلات باقية
      expect(await ctx.prisma.payRate.count({ where: { employeeId: employee.id } })).toBe(1);
      expect(await ctx.prisma.employeeDepartmentHistory.count({ where: { employeeId: employee.id } })).toBe(1);

      const active = await admin.post(`/employees/${employee.id}/reactivate`);
      expect(active.body).toMatchObject({ status: 'ACTIVE', terminationDate: null });
      expect((await admin.post(`/employees/${employee.id}/reactivate`)).status).toBe(409);
    });

    it('لا يُوقف موظف له حضور دون انصراف', async () => {
      const employee = await addEmployee();
      const adminId = (await admin.get('/auth/me')).body.user.id;
      const now = new Date();
      await ctx.prisma.workSession.create({
        data: { employeeId: employee.id, departmentId: cashier, workDate: now, checkInAt: now, originalCheckInAt: now, createdById: adminId },
      });
      const res = await admin.post(`/employees/${employee.id}/deactivate`);
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('انصراف');
    });
  });

  describe('النقل بين الأقسام', () => {
    it('يحفظ تاريخ الانتقال دون تداخل', async () => {
      const employee = await addEmployee();
      const moved = await admin.post(`/employees/${employee.id}/transfer`, { departmentId: bakery, effectiveFrom: '2026-03-01' });
      expect(moved.status).toBe(200);
      expect(moved.body.department.name).toBe('المخبز');

      const history = (await admin.get(`/employees/${employee.id}/department-history`)).body;
      expect(history.map((h: any) => [h.department.name, h.effectiveFrom, h.effectiveTo])).toEqual([
        ['المخبز', '2026-03-01', null],
        ['الكاشير', '2026-01-01', '2026-02-28'],
      ]);
    });

    it('يرفض النقل إلى القسم نفسه، أو بتاريخ مستقبلي، أو قبل بداية القسم الحالي، أو إلى قسم معطّل', async () => {
      const employee = await addEmployee();
      const to = (body: Record<string, unknown>) => admin.post(`/employees/${employee.id}/transfer`, body);
      expect((await to({ departmentId: cashier })).status).toBe(409);
      expect((await to({ departmentId: bakery, effectiveFrom: '2999-01-01' })).status).toBe(400);
      expect((await to({ departmentId: bakery, effectiveFrom: '2025-12-31' })).status).toBe(409);
      await admin.patch(`/departments/${bakery}`, { isActive: false });
      expect((await to({ departmentId: bakery })).status).toBe(400);
      expect(await ctx.prisma.employeeDepartmentHistory.count()).toBe(1);
    });

    it('نقل بتاريخ بداية القيد الحالي يصحّحه في مكانه', async () => {
      const employee = await addEmployee();
      await admin.post(`/employees/${employee.id}/transfer`, { departmentId: bakery, effectiveFrom: '2026-01-01' });
      const history = (await admin.get(`/employees/${employee.id}/department-history`)).body;
      expect(history).toHaveLength(1);
      expect(history[0].department.name).toBe('المخبز');
    });
  });

  describe('الأجور وسياساتها', () => {
    it('تغيير الأجر يغلق الفترة السابقة ويبدأ فترة جديدة دون تداخل', async () => {
      const employee = await addEmployee();
      const res = await admin.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 22.5, effectiveFrom: '2026-04-01' });
      expect(res.status).toBe(200);
      expect(res.body.rates.map((r: any) => [r.amount, r.effectiveFrom, r.effectiveTo])).toEqual([
        ['22.50', '2026-04-01', null],
        ['20.00', '2026-01-01', '2026-03-31'],
      ]);
      expect(res.body.rates[0].createdBy).toBe('admin');
      // النوع لم يتغير فلا سياسة جديدة
      expect(res.body.policies).toHaveLength(1);
      expect((await admin.get(`/employees/${employee.id}`)).body.currentPay.amount).toBe('22.50');
    });

    it('يمنع تداخل فترات الأجر: تاريخ أقدم من آخر تغيير مرفوض', async () => {
      const employee = await addEmployee();
      await admin.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 22, effectiveFrom: '2026-04-01' });

      const earlier = await admin.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 30, effectiveFrom: '2026-02-01' });
      expect(earlier.status).toBe(409);
      expect(earlier.body.message).toContain('2026-04-01');
      expect(await ctx.prisma.payRate.count()).toBe(2);

      // وقاعدة البيانات ترفض التداخل حتى لو تجاوز أحد فحص الخادم
      const adminId = (await admin.get('/auth/me')).body.user.id;
      await expect(
        ctx.prisma.payRate.create({
          data: { employeeId: employee.id, payType: 'HOURLY', amount: 30, effectiveFrom: new Date('2026-02-01'), createdById: adminId },
        }),
      ).rejects.toThrow();
    });

    it('التاريخ نفسه يصحّح القيمة في مكانها، والقيمة القديمة تبقى في سجل التغييرات', async () => {
      const employee = await addEmployee();
      const res = await admin.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 21, effectiveFrom: '2026-01-01' });
      expect(res.body.rates).toHaveLength(1);
      expect(res.body.rates[0].amount).toBe('21.00');

      const history = (await admin.get(`/employees/${employee.id}/history`)).body;
      const change = history.find((h: any) => h.action === 'employee.pay_rate_changed' && h.before);
      expect(change.before.amount).toBe('20.00');
      expect(change.after.amount).toBe('21.00');
    });

    it('تغيير نوع الأجر يتطلب سياسة مناسبة: اليومي النسبي بساعات مرجعية، والشهري بطريقة خصم', async () => {
      const employee = await addEmployee();
      const change = (body: Record<string, unknown>) => admin.post(`/employees/${employee.id}/pay-rates`, { effectiveFrom: '2026-05-01', ...body });

      expect((await change({ payType: 'DAILY', amount: 120 })).status).toBe(400);
      expect((await change({ payType: 'DAILY', amount: 120, policy: { payrollFrequency: 'WEEKLY', dailyPayMode: 'PROPORTIONAL' } })).status).toBe(400);
      expect((await change({ payType: 'MONTHLY', amount: 2500, policy: { payrollFrequency: 'MONTHLY' } })).status).toBe(400);
      expect(
        (await change({ payType: 'MONTHLY', amount: 2500, policy: { payrollFrequency: 'MONTHLY', absenceDeductionMethod: 'FIXED_DAYS' } })).status,
      ).toBe(400);
      expect(await ctx.prisma.payRate.count()).toBe(1);

      const daily = await change({
        payType: 'DAILY',
        amount: 120,
        policy: { payrollFrequency: 'WEEKLY', dailyPayMode: 'PROPORTIONAL', referenceDailyHours: 9 },
      });
      expect(daily.status).toBe(200);
      expect(daily.body.policies[0]).toMatchObject({
        payrollFrequency: 'WEEKLY',
        dailyPayMode: 'PROPORTIONAL',
        referenceDailyHours: 9,
        absenceDeductionMethod: null,
        effectiveFrom: '2026-05-01',
        effectiveTo: null,
      });
      expect(daily.body.policies[1]).toMatchObject({ payrollFrequency: 'MONTHLY', effectiveTo: '2026-04-30' });

      // تغيير السياسة وحدها لاحقًا (الطرق الثلاث لخصم الغياب تُقبل للشهري فقط)
      const monthly = await admin.post(`/employees/${employee.id}/pay-rates`, {
        payType: 'MONTHLY',
        amount: 2500,
        effectiveFrom: '2026-07-01',
        policy: { payrollFrequency: 'MONTHLY', absenceDeductionMethod: 'ACTUAL_MONTH_DAYS' },
      });
      expect(monthly.status).toBe(200);
      const fixed = await admin.post(`/employees/${employee.id}/pay-policies`, {
        payrollFrequency: 'SEMI_MONTHLY',
        absenceDeductionMethod: 'FIXED_DAYS',
        fixedMonthDays: 26,
        effectiveFrom: '2026-09-01',
      });
      expect(fixed.body.policies[0]).toMatchObject({ absenceDeductionMethod: 'FIXED_DAYS', fixedMonthDays: 26, dailyPayMode: null });
      const scheduled = await admin.post(`/employees/${employee.id}/pay-policies`, {
        payrollFrequency: 'MONTHLY',
        absenceDeductionMethod: 'SCHEDULED_WORK_DAYS',
        effectiveFrom: '2026-10-01',
      });
      expect(scheduled.body.policies[0]).toMatchObject({ absenceDeductionMethod: 'SCHEDULED_WORK_DAYS', fixedMonthDays: null });
    });

    it('لا يُسمح بتاريخ سريان يمس فترة رواتب مغلقة', async () => {
      const employee = await addEmployee();
      const adminId = (await admin.get('/auth/me')).body.user.id;
      const period = await ctx.prisma.payrollPeriod.create({
        data: { frequency: 'MONTHLY', startDate: new Date('2026-03-01'), endDate: new Date('2026-03-31'), label: 'مارس 2026', createdById: adminId },
      });
      await ctx.prisma.payrollEntry.create({
        data: { periodId: period.id, employeeId: employee.id, periodStart: period.startDate, periodEnd: period.endDate, netAmount: 100 },
      });
      const draft = await admin.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 21, effectiveFrom: '2026-03-15' });
      expect(draft.status).toBe(200); // الفترة ما زالت مسودة

      await ctx.prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: adminId } });
      const inside = await admin.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 25, effectiveFrom: '2026-03-20' });
      expect(inside.status).toBe(409);
      expect(inside.body.message).toContain('مغلقة');
      const after = await admin.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 25, effectiveFrom: '2026-04-01' });
      expect(after.status).toBe(200);
    });
  });

  describe('صلاحيات المراقب', () => {
    it('دون صلاحية لا يرى ولا يضيف ولا يعدّل', async () => {
      const employee = await addEmployee();
      const none = (await createSupervisor(ctx, admin)).client;
      expect((await none.get('/employees')).status).toBe(403);
      expect((await none.get(`/employees/${employee.id}`)).status).toBe(403);
      expect((await none.post('/employees', { fullName: 'موظف', departmentId: cashier })).status).toBe(403);
      expect((await none.patch(`/employees/${employee.id}`, { version: 1, fullName: 'تعديل' })).status).toBe(403);
      expect((await none.get('/search?q=أحمد')).body).toEqual({ employees: [] });
    });

    it('بصلاحيات الموظفين: يضيف ويعدّل غير المالي فقط، ولا يرى الأجر ولا يغيّره ولا يوقف', async () => {
      const employee = await addEmployee();
      const s = (await createSupervisor(ctx, admin, ['employees.view', 'employees.create', 'employees.update'])).client;

      const seen = await s.get(`/employees/${employee.id}`);
      expect(seen.body).toMatchObject({ fullName: 'أحمد سالم', payVisible: false, currentPay: null });
      expect(JSON.stringify((await s.get('/employees')).body)).not.toContain('20.00');
      expect((await s.get('/employees?payType=HOURLY')).status).toBe(403);
      expect((await s.get(`/employees/${employee.id}/pay`)).status).toBe(403);

      // إضافة دون أجر مسموحة، ومع أجر مرفوضة
      expect((await s.post('/employees', { fullName: 'ليلى حسن', departmentId: cashier, pay: HOURLY })).body.code).toBe('ADMIN_ONLY');
      const created = await s.post('/employees', { fullName: 'ليلى حسن', departmentId: cashier });
      expect(created.status).toBe(201);
      expect(await ctx.prisma.payRate.count({ where: { employeeId: created.body.id } })).toBe(0);

      expect((await s.patch(`/employees/${employee.id}`, { version: 1, phone: '0599000111' })).status).toBe(200);
      expect((await s.post(`/employees/${employee.id}/transfer`, { departmentId: bakery })).status).toBe(200);

      for (const res of [
        await s.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 99 }),
        await s.post(`/employees/${employee.id}/pay-policies`, { payrollFrequency: 'WEEKLY' }),
        await s.post(`/employees/${employee.id}/deactivate`),
        await s.post(`/employees/${employee.id}/reactivate`),
      ]) {
        expect(res.body.code).toBe('ADMIN_ONLY');
      }

      // سجل التغييرات يخفي تغييرات الأجر عنه
      const history = (await s.get(`/employees/${employee.id}/history`)).body;
      expect(history.length).toBeGreaterThan(0);
      expect(history.some((h: any) => h.action.startsWith('employee.pay_'))).toBe(false);
      expect(JSON.stringify(history)).not.toContain('20.00');
    });

    it('بصلاحية عرض المعلومات المالية يرى الأجر للقراءة فقط', async () => {
      const employee = await addEmployee();
      const s = (await createSupervisor(ctx, admin, ['employees.view', 'finance.view'])).client;
      expect((await s.get(`/employees/${employee.id}`)).body.currentPay).toMatchObject({ amount: '20.00' });
      expect((await s.get(`/employees/${employee.id}/pay`)).body.rates).toHaveLength(1);
      expect((await s.post(`/employees/${employee.id}/pay-rates`, { payType: 'HOURLY', amount: 99 })).body.code).toBe('ADMIN_ONLY');
    });
  });

  describe('البحث والتصفية وسجل التغييرات', () => {
    it('بحث بالاسم والكود والهاتف، وتصفية بالقسم والحالة ونوع الأجر، مع فرز وترقيم', async () => {
      const ahmad = await addEmployee();
      await addEmployee({ fullName: 'سارة علي', phone: '0598777666', departmentId: bakery });
      const khaled = await addEmployee({
        fullName: 'خالد عمر',
        phone: null,
        pay: { payType: 'MONTHLY', amount: 2500, effectiveFrom: '2026-01-01' },
        policy: { payrollFrequency: 'MONTHLY', absenceDeductionMethod: 'ACTUAL_MONTH_DAYS' },
      });
      await admin.post(`/employees/${khaled.id}/deactivate`);

      const names = async (query: string) => (await admin.get(`/employees?${query}`)).body.items.map((e: { fullName: string }) => e.fullName);
      expect(await names('')).toEqual(['أحمد سالم', 'خالد عمر', 'سارة علي']);
      expect(await names(`search=${encodeURIComponent('سارة')}`)).toEqual(['سارة علي']);
      expect(await names('search=emp-0003')).toEqual(['خالد عمر']);
      expect(await names('search=0598777')).toEqual(['سارة علي']);
      expect(await names(`departmentId=${bakery}`)).toEqual(['سارة علي']);
      expect(await names('status=INACTIVE')).toEqual(['خالد عمر']);
      expect(await names('payType=MONTHLY')).toEqual(['خالد عمر']);
      expect(await names('sortBy=code&sortDir=desc')).toEqual(['خالد عمر', 'سارة علي', 'أحمد سالم']);

      const page = await admin.get('/employees?pageSize=2&page=2');
      expect(page.body).toMatchObject({ total: 3, page: 2, totalPages: 2 });
      expect(page.body.items).toHaveLength(1);
      expect((await admin.get('/employees?sortBy=passwordHash')).status).toBe(400);

      const search = await admin.get(`/search?q=${encodeURIComponent('أحمد')}`);
      expect(search.body.employees).toEqual([expect.objectContaining({ id: ahmad.id, code: 'EMP-0001' })]);
      const departments = (await admin.get('/departments')).body;
      expect(departments.map((d: any) => [d.name, d.activeEmployees])).toEqual([
        ['الكاشير', 1],
        ['المخبز', 1],
      ]);
    });

    it('سجل تغييرات الموظف يوثق كل عملية بالفاعل والقيم القديمة والجديدة', async () => {
      const employee = await addEmployee();
      await admin.patch(`/employees/${employee.id}`, { version: 1, fullName: 'أحمد سالم حسن' });
      await admin.post(`/employees/${employee.id}/transfer`, { departmentId: bakery, effectiveFrom: '2026-02-01' });
      await admin.post(`/employees/${employee.id}/deactivate`);
      await admin.post(`/employees/${employee.id}/reactivate`);

      const history = (await admin.get(`/employees/${employee.id}/history`)).body;
      const actions = history.map((h: any) => h.action);
      expect(actions.slice(0, 4)).toEqual(['employee.reactivated', 'employee.deactivated', 'employee.transferred', 'employee.updated']);
      // الإنشاء والأجر الابتدائي يُسجَّلان في المعاملة نفسها (اللحظة نفسها)
      expect(actions.slice(4).sort()).toEqual(['employee.created', 'employee.pay_rate_changed']);
      expect(history.every((h: any) => h.actorUsername === 'admin')).toBe(true);
      expect(history[3]).toMatchObject({ before: { fullName: 'أحمد سالم' }, after: { fullName: 'أحمد سالم حسن' } });
      expect(history[2]).toMatchObject({ before: { department: 'الكاشير' }, after: { department: 'المخبز', effectiveFrom: '2026-02-01' } });
    });
  });
});
