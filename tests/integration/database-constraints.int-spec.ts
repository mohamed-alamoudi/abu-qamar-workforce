/**
 * اختبارات قيود قاعدة البيانات (الأساس الذي تُبنى عليه المراحل التالية):
 * منع التداخل، حماية السجلات المالية، حماية الفترات المغلقة، ومنع التكرار.
 * تُختبر على PostgreSQL مباشرة للتأكد أن القيود تصمد حتى لو أخطأ كود التطبيق.
 */
import { randomUUID } from 'crypto';
import { createTestApp, resetDatabase, setupAdmin, TestContext } from './helpers';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const t = (iso: string) => new Date(iso);

describe('قيود قاعدة البيانات', () => {
  let ctx: TestContext;
  let adminId: string;
  let departmentId: string;
  let employeeId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const admin = await setupAdmin(ctx);
    adminId = (await admin.get('/auth/me')).body.user.id;
    departmentId = (await ctx.prisma.department.create({ data: { name: 'الكاشير' } })).id;
    employeeId = (await ctx.prisma.employee.create({ data: { fullName: 'موظف اختبار', departmentId, createdById: adminId } })).id;
  });

  const session = (checkInAt: string, checkOutAt: string | null, extra: Record<string, unknown> = {}) =>
    ctx.prisma.workSession.create({
      data: {
        employeeId,
        departmentId,
        workDate: d(checkInAt.slice(0, 10)),
        checkInAt: t(checkInAt),
        originalCheckInAt: t(checkInAt),
        checkOutAt: checkOutAt ? t(checkOutAt) : null,
        originalCheckOutAt: checkOutAt ? t(checkOutAt) : null,
        status: checkOutAt ? 'CLOSED' : 'OPEN',
        createdById: adminId,
        ...extra,
      },
    });

  it('كود الموظف يتولد تلقائيًا وفريدًا', async () => {
    const first = await ctx.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    const second = await ctx.prisma.employee.create({ data: { fullName: 'موظف ثانٍ', departmentId, createdById: adminId } });
    expect(first.code).toBe('EMP-0001');
    expect(second.code).toBe('EMP-0002');
  });

  describe('منع تداخل فترات الأجور', () => {
    const rate = (from: string, to: string | null, amount = 20) =>
      ctx.prisma.payRate.create({
        data: { employeeId, payType: 'HOURLY', amount, effectiveFrom: d(from), effectiveTo: to ? d(to) : null, createdById: adminId },
      });

    it('يرفض فترة متداخلة ويقبل فترة متصلة دون تداخل', async () => {
      await rate('2026-01-01', '2026-06-30');
      await expect(rate('2026-06-30', null, 25)).rejects.toThrow();
      await expect(rate('2026-03-01', '2026-03-31', 25)).rejects.toThrow();
      await expect(rate('2026-07-01', null, 25)).resolves.toBeDefined();
      // فترة مفتوحة النهاية تمنع أي فترة لاحقة
      await expect(rate('2027-01-01', null, 30)).rejects.toThrow();
    });

    it('يرفض تاريخ نهاية قبل البداية وقيمة سالبة', async () => {
      await expect(rate('2026-05-01', '2026-04-01')).rejects.toThrow();
      await expect(rate('2026-05-01', null, -1)).rejects.toThrow();
    });

    it('الأجر اليومي النسبي يتطلب ساعات مرجعية صريحة', async () => {
      const policy = (extra: Record<string, unknown>) =>
        ctx.prisma.employeePayPolicy.create({
          data: { employeeId, effectiveFrom: d('2026-01-01'), createdById: adminId, ...extra },
        });
      await expect(policy({ dailyPayMode: 'PROPORTIONAL' })).rejects.toThrow();
      await expect(policy({ absenceDeductionMethod: 'FIXED_DAYS' })).rejects.toThrow();
      await expect(policy({ dailyPayMode: 'PROPORTIONAL', referenceDailyHours: 9 })).resolves.toBeDefined();
    });
  });

  describe('منع تداخل الورديات', () => {
    it('يسمح بعدة ورديات في اليوم ويرفض المتداخلة', async () => {
      await session('2026-03-01T06:00:00Z', '2026-03-01T10:00:00Z');
      await expect(session('2026-03-01T10:00:00Z', '2026-03-01T14:00:00Z')).resolves.toBeDefined();
      await expect(session('2026-03-01T09:00:00Z', '2026-03-01T11:00:00Z')).rejects.toThrow();
      await expect(session('2026-03-01T13:59:00Z', '2026-03-01T18:00:00Z')).rejects.toThrow();
    });

    it('وردية ممتدة بعد منتصف الليل تُقبل وتمنع التداخل في اليوم التالي', async () => {
      await session('2026-03-01T20:00:00Z', '2026-03-02T04:00:00Z');
      await expect(session('2026-03-02T03:00:00Z', '2026-03-02T09:00:00Z')).rejects.toThrow();
      await expect(session('2026-03-02T04:00:00Z', '2026-03-02T09:00:00Z')).resolves.toBeDefined();
    });

    it('وردية مفتوحة (حضور دون انصراف) تمنع تسجيل حضور جديد، والملغاة لا تمنع', async () => {
      const open = await session('2026-03-01T06:00:00Z', null);
      await expect(session('2026-03-01T15:00:00Z', null)).rejects.toThrow();

      await ctx.prisma.workSession.update({ where: { id: open.id }, data: { status: 'VOIDED', voidedAt: new Date() } });
      await expect(session('2026-03-01T15:00:00Z', null)).resolves.toBeDefined();
    });

    it('يرفض انصرافًا قبل الحضور وحالة لا تطابق الأوقات', async () => {
      await expect(session('2026-03-01T10:00:00Z', '2026-03-01T09:00:00Z')).rejects.toThrow();
      await expect(session('2026-03-01T10:00:00Z', null, { status: 'CLOSED' })).rejects.toThrow();
    });

    it('معرف عملية الجهاز يمنع تكرار الوردية عند إعادة المزامنة', async () => {
      const op = randomUUID();
      await session('2026-03-01T06:00:00Z', '2026-03-01T10:00:00Z', { clientOperationId: op });
      await expect(session('2026-03-05T06:00:00Z', '2026-03-05T10:00:00Z', { clientOperationId: op })).rejects.toThrow();
    });
  });

  describe('الرواتب والعمليات المالية', () => {
    const period = (start: string, end: string, frequency: 'WEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY' = 'MONTHLY') =>
      ctx.prisma.payrollPeriod.create({
        data: { frequency, startDate: d(start), endDate: d(end), label: `${start} → ${end}`, createdById: adminId },
      });
    const entry = (periodId: string, start: string, end: string, net = 1000) =>
      ctx.prisma.payrollEntry.create({
        data: { periodId, employeeId, periodStart: d(start), periodEnd: d(end), grossAmount: net, netAmount: net },
      });
    const payment = (amount: number, extra: Record<string, unknown> = {}) =>
      ctx.prisma.financialTransaction.create({
        data: {
          employeeId,
          type: 'SALARY_PAYMENT',
          amount,
          occurredAt: new Date(),
          method: 'CASH',
          idempotencyKey: randomUUID(),
          createdById: adminId,
          ...extra,
        },
      });

    it('يمنع تداخل فترات الرواتب للموظف نفسه (أسبوعية/نصف شهرية/شهرية)', async () => {
      const october = await period('2026-10-01', '2026-10-31');
      await entry(october.id, '2026-10-01', '2026-10-31');

      const half = await period('2026-10-16', '2026-10-31', 'SEMI_MONTHLY');
      await expect(entry(half.id, '2026-10-16', '2026-10-31')).rejects.toThrow();
      const week = await period('2026-10-31', '2026-11-06', 'WEEKLY');
      await expect(entry(week.id, '2026-10-31', '2026-11-06')).rejects.toThrow();

      const november = await period('2026-11-01', '2026-11-30');
      await expect(entry(november.id, '2026-11-01', '2026-11-30')).resolves.toBeDefined();
      // الفترة نفسها لا تُنشأ مرتين
      await expect(period('2026-11-01', '2026-11-30')).rejects.toThrow();
    });

    it('مفتاح منع التكرار يرفض الدفعة المكررة', async () => {
      const key = randomUUID();
      await payment(500, { idempotencyKey: key });
      await expect(payment(500, { idempotencyKey: key })).rejects.toThrow();
      expect(await ctx.prisma.financialTransaction.count()).toBe(1);
    });

    it('العمليات المالية لا تُحذف ولا تُعدَّل؛ يُسمح فقط بتعليمها معكوسة مرة واحدة', async () => {
      const tx = await payment(500);
      await expect(ctx.prisma.financialTransaction.delete({ where: { id: tx.id } })).rejects.toThrow();
      await expect(ctx.prisma.financialTransaction.update({ where: { id: tx.id }, data: { amount: 5 } })).rejects.toThrow();
      await expect(payment(0)).rejects.toThrow();

      // العكس: عملية جديدة تشير إلى الأصل + تعليم الأصل REVERSED
      const reversal = await payment(500, { type: 'REVERSAL', reversesId: tx.id, correctionReason: 'مبلغ خاطئ' });
      await ctx.prisma.financialTransaction.update({ where: { id: tx.id }, data: { status: 'REVERSED' } });
      expect(reversal.reversesId).toBe(tx.id);

      // لا عكس ثانٍ للعملية نفسها، ولا عودة عن العكس، ولا عملية عكسية بلا أصل
      await expect(payment(500, { type: 'REVERSAL', reversesId: tx.id })).rejects.toThrow();
      await expect(ctx.prisma.financialTransaction.update({ where: { id: tx.id }, data: { status: 'POSTED' } })).rejects.toThrow();
      await expect(payment(100, { type: 'REVERSAL' })).rejects.toThrow();
    });

    it('الفترة المغلقة محمية: لا تعديل للمستحق، ويُسمح فقط بتسجيل المدفوع دون تجاوز الصافي', async () => {
      const october = await period('2026-10-01', '2026-10-31');
      const e = await entry(october.id, '2026-10-01', '2026-10-31', 1500);
      await ctx.prisma.payrollEntryComponent.create({
        data: { entryId: e.id, type: 'REGULAR_WAGE', description: 'أجر أكتوبر', amount: 1500 },
      });
      await ctx.prisma.payrollPeriod.update({ where: { id: october.id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: adminId } });

      await expect(ctx.prisma.payrollEntry.update({ where: { id: e.id }, data: { netAmount: 9999 } })).rejects.toThrow();
      await expect(ctx.prisma.payrollEntry.delete({ where: { id: e.id } })).rejects.toThrow();
      await expect(
        ctx.prisma.payrollEntryComponent.create({ data: { entryId: e.id, type: 'BONUS', description: 'مكافأة', amount: 100 } }),
      ).rejects.toThrow();
      await expect(ctx.prisma.payrollEntryComponent.deleteMany({ where: { entryId: e.id } })).rejects.toThrow();
      await expect(ctx.prisma.payrollPeriod.update({ where: { id: october.id }, data: { status: 'DRAFT' } })).rejects.toThrow();

      // دفعة جزئية: يبقى 500 مرتبطة بأكتوبر
      const paid = await ctx.prisma.payrollEntry.update({ where: { id: e.id }, data: { paidAmount: 1000 } });
      expect(paid.netAmount.minus(paid.paidAmount).toFixed(2)).toBe('500.00');
      await expect(ctx.prisma.payrollEntry.update({ where: { id: e.id }, data: { paidAmount: 1500.01 } })).rejects.toThrow();
    });

    it('رصيد السلفة والدين لا يصبح سالبًا ولا يتجاوز الأصل، والتوزيع يرتبط بالتزام واحد', async () => {
      const advance = await ctx.prisma.advanceAccount.create({
        data: { employeeId, principalAmount: 300, remainingBalance: 300, disbursedAt: new Date(), createdById: adminId },
      });
      await expect(ctx.prisma.advanceAccount.update({ where: { id: advance.id }, data: { remainingBalance: -1 } })).rejects.toThrow();
      await expect(ctx.prisma.advanceAccount.update({ where: { id: advance.id }, data: { remainingBalance: 301 } })).rejects.toThrow();
      await expect(
        ctx.prisma.debtAccount.create({
          data: { employeeId, principalAmount: 0, remainingBalance: 0, incurredAt: new Date(), createdById: adminId },
        }),
      ).rejects.toThrow();

      const tx = await payment(100, { type: 'SETTLEMENT', advanceAccountId: advance.id });
      const allocation = (data: Record<string, unknown>) =>
        ctx.prisma.settlementAllocation.create({ data: { transactionId: tx.id, amount: 100, ...data } as never });
      await expect(allocation({ targetType: 'ADVANCE' })).rejects.toThrow();
      await expect(allocation({ targetType: 'DEBT', advanceAccountId: advance.id })).rejects.toThrow();
      const ok = await allocation({ targetType: 'ADVANCE', advanceAccountId: advance.id });
      await expect(ctx.prisma.settlementAllocation.delete({ where: { id: ok.id } })).rejects.toThrow();
    });
  });

  it('لا تتداخل إجازات الموظف القائمة، والمرفوضة لا تمنع', async () => {
    const leave = (start: string, end: string, status: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING') =>
      ctx.prisma.leaveRecord.create({
        data: { employeeId, type: 'UNPAID_LEAVE', startDate: d(start), endDate: d(end), status, affectsPay: true, recordedById: adminId },
      });
    await leave('2026-04-01', '2026-04-05', 'APPROVED');
    await expect(leave('2026-04-05', '2026-04-07')).rejects.toThrow();
    await expect(leave('2026-04-03', '2026-04-04', 'REJECTED')).resolves.toBeDefined();
    await expect(leave('2026-04-10', '2026-04-09')).rejects.toThrow();
  });
});
