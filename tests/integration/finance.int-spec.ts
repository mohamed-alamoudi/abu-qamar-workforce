import { randomUUID } from 'node:crypto';
import { Prisma } from '@abu-qamar/database';
import { ADMIN, Client, createSupervisor, createTestApp, resetDatabase, setupAdmin, type TestContext } from './helpers';

const d = (date: string) => new Date(`${date}T00:00:00.000Z`);
const amount = (value: string) => new Prisma.Decimal(value).toFixed(2);

describe('محرك الرواتب والحسابات المالية', () => {
  let ctx: TestContext;
  let admin: Client;
  let adminId: string;
  let departmentId: string;
  let employeeId: string;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx?.app.close(); });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await setupAdmin(ctx);
    adminId = (await admin.get('/auth/me').expect(200)).body.user.id;
    departmentId = (await ctx.prisma.department.create({ data: { name: 'المبيعات' } })).id;
    employeeId = (await ctx.prisma.employee.create({ data: { fullName: 'موظف الاختبار', departmentId, createdById: adminId } })).id;
  });

  async function rate(payType: 'HOURLY' | 'DAILY' | 'MONTHLY', value: string, from = '2026-10-01', to?: string) {
    return ctx.prisma.payRate.create({ data: {
      employeeId, payType, amount: value, effectiveFrom: d(from), effectiveTo: to && d(to) || null, createdById: adminId,
    } });
  }

  async function policy(fields: Partial<Prisma.EmployeePayPolicyUncheckedCreateInput> = {}) {
    return ctx.prisma.employeePayPolicy.create({ data: {
      employeeId, createdById: adminId, effectiveFrom: d('2026-10-01'), ...fields,
    } });
  }

  async function shift(workDate: string, minutes: number, hour = '08', approvalStatus: 'APPROVED' | 'DRAFT' = 'APPROVED') {
    const start = new Date(`${workDate}T${hour}:00:00.000Z`);
    const end = new Date(start.getTime() + minutes * 60000);
    return ctx.prisma.workSession.create({ data: {
      employeeId, departmentId, workDate: d(workDate), checkInAt: start, checkOutAt: end,
      originalCheckInAt: start, originalCheckOutAt: end, status: 'CLOSED', approvalStatus, workedMinutes: minutes, createdById: adminId,
    } });
  }

  async function period(date = '2026-10-05', frequency = 'MONTHLY') {
    return (await admin.post('/payroll/periods', { frequency, date }).expect(201)).body;
  }

  async function calc(id: string) {
    return (await admin.post(`/payroll/periods/${id}/calculate`).expect(201)).body;
  }

  const reauth = async () => { await admin.post('/auth/reauth', { password: ADMIN.password }).expect(200); };
  async function close(id: string) {
    await admin.post(`/payroll/periods/${id}/review`).expect(201);
    await reauth();
    await admin.post(`/payroll/periods/${id}/approve`).expect(201);
    return (await admin.post(`/payroll/periods/${id}/close`).expect(201)).body.entries[0];
  }

  it('يحذف حساب فترة قيد المراجعة مع حفظ الدوام ويمنع حذف الفترة المعتمدة', async () => {
    await rate('HOURLY', '30');
    await policy();
    const attendance = await shift('2026-10-05', 120);
    const draft = await period();
    const path = '/payroll/periods/' + draft.id;
    await admin.post(path + '/review').expect(201);
    expect(await ctx.prisma.payrollEntry.count({ where: { periodId: draft.id } })).toBe(1);
    const supervisor = await createSupervisor(ctx, admin, ['finance.view']);
    await supervisor.client.delete(path).expect(403);
    await ctx.prisma.session.updateMany({ where: { userId: adminId }, data: { reauthAt: null } });
    await admin.delete(path).expect(403);
    await reauth();
    await admin.delete(path).expect(200);
    await admin.get(path).expect(404);
    expect(await ctx.prisma.workSession.count({ where: { id: attendance.id } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'payroll.period.delete', entityId: draft.id } })).toBe(1);
    const replacement = await period();
    const replacementPath = '/payroll/periods/' + replacement.id;
    await admin.post(replacementPath + '/review').expect(201);
    await admin.post(replacementPath + '/approve').expect(201);
    await admin.delete(replacementPath).expect(409);
    await admin.post(replacementPath + '/close').expect(201);
    await admin.delete(replacementPath).expect(409);
  });

  it('يحدث فترة مغلقة جزئيًا دون المساس بدفعة عامل ويضيف عاملًا جديدًا بعد اعتماد دوامه', async () => {
    await rate('HOURLY', '30');
    await policy();
    await shift('2026-10-05', 120);
    const createHourly = async (fullName: string) => (await admin.post('/employees', {
      fullName, departmentId, pay: { payType: 'HOURLY', amount: 30, effectiveFrom: '2026-10-01' },
    }).expect(201)).body.id;
    const record = async (id: string) => (await admin.post('/attendance/manual', {
      employeeId: id, checkInAt: '2026-10-06T08:00:00Z', checkOutAt: '2026-10-06T09:00:00Z',
    }).expect(201)).body;
    const approveShift = async (row: { id: string; version: number }) => {
      await admin.post('/attendance/' + row.id + '/review', { version: row.version }).expect(201);
      await admin.post('/attendance/' + row.id + '/approve', { version: row.version + 1 }).expect(201);
    };
    const paidEmployee = await createHourly('عامل قبض');
    await approveShift(await record(paidEmployee));
    const { id } = await ctx.prisma.payrollPeriod.findFirstOrThrow({ where: { entries: { some: { employeeId: paidEmployee } } } });
    await calc(id);
    await close(id);
    const existing = await ctx.prisma.payrollEntry.findMany({ where: { periodId: id } });
    const paid = existing.find(entry => entry.employeeId === paidEmployee)!;
    const unpaid = existing.find(entry => entry.employeeId === employeeId)!;
    const payment = (entryId: string) => admin.post('/payments', {
      payrollEntryId: entryId, amount: '20', method: 'CASH', receivedBy: 'الموظف', reference: 'إيصال',
    }).set('Idempotency-Key', randomUUID());
    await payment(paid.id).expect(201);
    const paidBefore = await ctx.prisma.payrollEntry.findUniqueOrThrow({ where: { id: paid.id } });
    const corrected = { payType: 'HOURLY', amount: 45, effectiveFrom: '2026-10-01', refreshUnpaidPeriods: true };
    await admin.post('/employees/' + paidEmployee + '/pay-rates', corrected).expect(409);
    await admin.post('/employees/' + employeeId + '/pay-rates', corrected).expect(200);
    await payment(unpaid.id).expect(409);

    const addedEmployee = await createHourly('عامل جديد');
    const pending = await record(addedEmployee);
    const path = '/payroll/periods/' + id + '/refresh-unpaid';
    const request = { reason: 'تحديث أجر وضم عامل جديد' };
    const supervisor = await createSupervisor(ctx, admin, ['finance.view']);
    await supervisor.client.post(path, request).expect(403);
    await ctx.prisma.session.updateMany({ where: { userId: adminId }, data: { reauthAt: null } });
    expect((await admin.post(path, request).expect(403)).body.code).toBe('REAUTH_REQUIRED');
    await reauth();
    const partial = await admin.post(path, request).expect(201);
    expect(partial.body).toMatchObject({ added: 0, updated: 1, protected: 1,
      blockers: [expect.objectContaining({ code: 'ATTENDANCE_PENDING', employeeName: 'عامل جديد' })] });
    const updated = await ctx.prisma.payrollEntry.findUniqueOrThrow({ where: { id: unpaid.id } });
    expect(updated.netAmount.toFixed(2)).toBe('90.00');
    expect(updated.snapshot).not.toHaveProperty('needsRefresh');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'payroll.entry.refresh_closed', entityId: unpaid.id } })).toBe(1);
    await approveShift(pending);
    const finished = await admin.post(path, request).expect(201);
    expect(finished.body).toMatchObject({ added: 1, updated: 0, protected: 1, blockers: [] });
    const added = await ctx.prisma.payrollEntry.findUniqueOrThrow({ where: { periodId_employeeId: { periodId: id, employeeId: addedEmployee } } });
    expect(added.netAmount.toFixed(2)).toBe('30.00');
    expect(await ctx.prisma.payrollEntry.findUniqueOrThrow({ where: { id: paid.id } })).toEqual(paidBefore);
    expect((await admin.get('/payroll/periods/' + id).expect(200)).body.status).toBe('CLOSED');
    expect(await ctx.prisma.financialTransaction.count()).toBe(1);
    await admin.post(path, request).expect(201, { added: 0, updated: 0, protected: 1, blockers: [] });
    await payment(unpaid.id).expect(201);
  });

  it('يعيد فتح فترة مخصصة قبل الصرف لإضافة موظف وتصحيح الأجر ثم يمنع فتحها بعد الدفع', async () => {
    await rate('HOURLY', '30');
    await policy();
    await shift('2026-10-05', 120);
    await admin.post('/payroll/periods', { frequency: 'MONTHLY', from: '2026-10-10', to: '2026-10-04' }).expect(400);
    const bounds = { frequency: 'MONTHLY', from: '2026-10-04', to: '2026-10-10' };
    const { body: original } = await admin.post('/payroll/periods', bounds).expect(201);
    expect(original.startDate.slice(0, 10)).toBe(bounds.from);
    expect(original.endDate.slice(0, 10)).toBe(bounds.to);
    await calc(original.id);
    const previous = await close(original.id);
    expect(amount(previous.netAmount)).toBe('60.00');
    const supervisor = await createSupervisor(ctx, admin, ['finance.view']);
    const reopen = '/payroll/periods/' + original.id + '/reopen';
    const reason = { reason: 'تصحيح الأجر وإضافة وردية موظف' };
    await supervisor.client.post(reopen, reason).expect(403);
    await ctx.prisma.session.updateMany({ where: { userId: adminId }, data: { reauthAt: null } });
    const denied = await admin.post(reopen, reason).expect(403);
    expect(denied.body.code).toBe('REAUTH_REQUIRED');
    await reauth();
    await admin.post(reopen, reason).expect(201);
    const archive = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'payroll.entry.archived_on_reopen', entityId: previous.id },
    });
    expect(archive.before).toMatchObject({ netAmount: '60', snapshot: { version: 1 } });
    const corrected = { payType: 'HOURLY', amount: 45, effectiveFrom: '2026-10-01' };
    await admin.post('/employees/' + employeeId + '/pay-rates', corrected).expect(200);
    const { body: added } = await admin.post('/employees', {
      fullName: 'موظف أضيف بعد الإغلاق', departmentId, pay: corrected,
    }).expect(201);
    const { body: manual } = await admin.post('/attendance/manual', {
      employeeId: added.id, checkInAt: '2026-10-06T08:00:00Z', checkOutAt: '2026-10-06T09:00:00Z',
    }).expect(201);
    await admin.post('/attendance/' + manual.id + '/review', { version: manual.version }).expect(201);
    await admin.post('/attendance/' + manual.id + '/approve', { version: manual.version + 1 }).expect(201);
    const recalculated = await calc(original.id);
    expect(recalculated.entries.map((row: { netAmount: string }) => amount(row.netAmount)).sort()).toEqual(['45.00', '90.00']);
    const entry = await close(original.id);
    await admin.post('/payments', {
      payrollEntryId: entry.id, amount: '20', method: 'CASH', receivedBy: 'الموظف', reference: 'إيصال',
    }).set('Idempotency-Key', randomUUID()).expect(201);
    await admin.post(reopen, reason).expect(409);
    expect((await admin.get('/payroll/periods/' + original.id).expect(200)).body.status).toBe('CLOSED');
  });

  it('يربط الدوام المعتمد بالراتب والتقرير ويحجب التصحيح المتأخر عند المزامنة', async () => {
    await rate('HOURLY', '30');
    await policy();
    const attendance = await admin.post('/attendance/manual', {
      employeeId, checkInAt: '2026-10-05T08:00:00Z', checkOutAt: '2026-10-05T10:00:00Z',
    }).expect(201);
    const row = attendance.body;
    await admin.post('/attendance/' + row.id + '/review', { version: row.version }).expect(201);
    await admin.post('/attendance/' + row.id + '/approve', { version: row.version + 1 }).expect(201);
    const { id } = await ctx.prisma.payrollPeriod.findFirstOrThrow({ where: { entries: { some: { employeeId } } } });
    const preliminary = (await admin.get('/employees/' + employeeId + '/financial-balances').expect(200)).body;
    expect(amount(preliminary.provisional)).toBe('60.00');
    const entry = await close(id);
    expect(amount(entry.netAmount)).toBe('60.00');
    const payment = await admin.post('/payments', {
      payrollEntryId: entry.id, method: 'CASH', receivedBy: 'الموظف', reference: 'إيصال 1', amount: '20',
    }).set('Idempotency-Key', randomUUID()).expect(201);

    const report = await admin.get('/reports/financial?view=entries&from=2026-10-01&to=2026-10-31&employeeId=' + employeeId).expect(200);
    expect(report.body.items).toEqual([expect.objectContaining({ netAmount: '60.00', paidAmount: '20.00', unpaidAmount: '40.00' })]);
    const balance = (await admin.get('/employees/' + employeeId + '/financial-balances').expect(200)).body;
    expect(amount(balance.net)).toBe('60.00');
    expect(amount(balance.paid)).toBe('20.00');
    expect(amount(balance.outstanding)).toBe('40.00');
    const sync = await admin.post('/sync/attendance', { userId: adminId, operations: [{
      action: 'CORRECTION', sessionId: row.id, baseVersion: row.version + 2,
      operationId: randomUUID(), deviceId: randomUUID(), createdAt: new Date().toISOString(),
      checkOutAt: '2026-10-05T11:00:00Z', reason: 'تصحيح الانصراف',
    }] }).expect(200);
    expect(sync.body.results[0]).toMatchObject({ status: 'CONFLICT', message: expect.stringContaining('رواتب مغلقة') });
    expect(await ctx.prisma.workSession.findUnique({ where: { id: row.id } }))
      .toMatchObject({ workedMinutes: 120, approvalStatus: 'APPROVED' });

    const reversalPath = '/financial-transactions/' + payment.body.id + '/reverse';
    const reversalKey = randomUUID();
    const reverse = (recoverableAmount: string) => admin.post(reversalPath, {
      reason: 'تصحيح قيد الدفع', recoverableAmount,
    }).set('Idempotency-Key', reversalKey);
    await reverse('21').expect(409);
    const reversal = await reverse('12').expect(201);
    expect((await reverse('12').expect(201)).body.id).toBe(reversal.body.id);
    const movement = await ctx.prisma.debtMovement.findFirstOrThrow({
      where: { transactionId: reversal.body.id }, include: { debtAccount: true },
    });
    expect(await ctx.prisma.debtAccount.count()).toBe(1);
    expect(movement.type).toBe('INITIAL');
    expect(movement.debtAccount.remainingBalance.toFixed(2)).toBe('12.00');
    expect((await ctx.prisma.payrollEntry.findUniqueOrThrow({ where: { id: entry.id } })).paidAmount.toFixed(2)).toBe('0.00');
  });

  it('يحسب الساعة على التاريخ المحلي مع سعرين وإضافي معتمد ومعلّق', async () => {
    await rate('HOURLY', '20', '2026-10-01', '2026-10-15');
    await rate('HOURLY', '30', '2026-10-16');
    await policy();
    const first = await shift('2026-10-14', 180, '22');
    const second = await shift('2026-10-16', 120);
    await ctx.prisma.overtimeEntry.createMany({ data: [
      { employeeId, sessionId: first.id, workDate: first.workDate, minutes: 60, multiplier: '1.5', status: 'APPROVED' },
      { employeeId, sessionId: second.id, workDate: second.workDate, minutes: 30, multiplier: '1.5', status: 'PENDING_APPROVAL' },
    ] });
    const { id } = await period();
    const firstRun = await calc(id);
    // (120 ÷ 60 × 20) + (60 ÷ 60 × 20 × 1.5) + (90 ÷ 60 × 30) = 115.00
    expect(amount(firstRun.entries[0].netAmount)).toBe('115.00');
    expect(firstRun.blockers).toEqual([expect.objectContaining({ code: 'OVERTIME_PENDING' })]);
    const repeated = await calc(id);
    expect(repeated.entries[0].id).toBe(firstRun.entries[0].id);
    expect(await ctx.prisma.payrollEntry.count()).toBe(1);
    expect(await ctx.prisma.payrollEntryComponent.count()).toBe(3);
    expect(repeated.entries[0].components.map((row: { id: string }) => row.id).sort())
      .toEqual(firstRun.entries[0].components.map((row: { id: string }) => row.id).sort());
    await admin.post(`/payroll/periods/${id}/review`).expect(201);
    await reauth();
    await admin.post(`/payroll/periods/${id}/approve`).expect(409);
  });

  it.each([
    ['FULL', '120.00'], // ورديتان في اليوم نفسه = يوم واحد × 120.
    ['PROPORTIONAL', '60.00'], // (120 + 120) ÷ 60 ÷ 8 × 120 = 60.
  ] as const)('يحسب الأجر اليومي %s', async (dailyPayMode, expected) => {
    await rate('DAILY', '120');
    await policy({ dailyPayMode, referenceDailyHours: dailyPayMode === 'PROPORTIONAL' ? '8' : null });
    await shift('2026-10-05', 120, '08');
    await shift('2026-10-05', 120, '12');
    const row = (await calc((await period()).id)).entries[0];
    expect(amount(row.netAmount)).toBe(expected);
  });

  it.each([
    ['HOURLY', null, '30', '180.00'],
    ['DAILY', 'FULL', '120', '120.00'],
    ['DAILY', 'PROPORTIONAL', '120', '90.00'],
    ['MONTHLY', null, '3100', '3100.00'],
  ] as const)('يدفع الإجازة المعتمدة وفق سياسة %s / %s', async (payType, dailyPayMode, value, expected) => {
    await rate(payType, value);
    await policy({ dailyPayMode, referenceDailyHours: dailyPayMode === 'PROPORTIONAL' ? '8' : null });
    const leaveBody = {
      employeeId, type: 'PAID_LEAVE', affectsPay: false, startDate: '2026-10-05', endDate: '2026-10-06',
    };
    await admin.post('/leaves', { ...leaveBody, affectsPay: true }).expect(400);
    const leave = await admin.post('/leaves', leaveBody).expect(201);
    await admin.post('/leaves/' + leave.body.id + '/decision', { status: 'APPROVED' }).expect(201);
    const { id } = await period();
    if (payType !== 'MONTHLY') {
      const draft = await calc(id);
      expect(draft.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'NO_SCHEDULE_FOR_PAID_LEAVE' }),
      ]));
    }
    await ctx.prisma.employeeSchedule.create({ data: {
      employeeId, createdById: adminId, effectiveFrom: d('2026-10-01'),
      weeklyPattern: [{ day: 1, start: '08:00', end: '14:00' }],
    } });
    const draft = await calc(id);
    expect(draft.blockers).toEqual([]);
    expect(amount(draft.entries[0].netAmount)).toBe(expected);
    expect(draft.entries[0].components.filter((row: { sourceType: string }) => row.sourceType === 'leave_record'))
      .toHaveLength(payType === 'MONTHLY' ? 0 : 1);
  });

  it.each([
    ['ACTUAL_MONTH_DAYS', '3000.00'], // 3100 - 3100 ÷ 31 = 3000.
    ['FIXED_DAYS', '2945.00'], // 3100 - 3100 ÷ 20 = 2945.
    ['SCHEDULED_WORK_DAYS', '2480.00'], // خمسة أيام اثنين في مارس 2026: 3100 - 3100 ÷ 5 = 2480.
  ] as const)('يحسب الشهري وخصم الغياب %s', async (absenceDeductionMethod, expected) => {
    const start = '2026-03-01';
    await rate('MONTHLY', '3100', start);
    await policy({ effectiveFrom: d(start), absenceDeductionMethod, fixedMonthDays: absenceDeductionMethod === 'FIXED_DAYS' ? 20 : null });
    await ctx.prisma.employeeSchedule.create({ data: {
      employeeId, createdById: adminId, effectiveFrom: d(start), weeklyPattern: [{ day: 1, start: '08:00', end: '16:00' }],
    } });
    await ctx.prisma.leaveRecord.create({ data: {
      employeeId, recordedById: adminId, startDate: d('2026-03-02'), endDate: d('2026-03-03'),
      status: 'APPROVED', type: 'UNPAID_ABSENCE', affectsPay: true,
    } }); // الثلاثاء يوم راحة، والاثنين هو اليوم الوحيد المخصوم.
    const entry = (await calc((await period('2026-03-05')).id)).entries[0];
    expect(amount(entry.grossAmount)).toBe('3100.00');
    expect(amount(entry.netAmount)).toBe(expected);
  });

  it.each([
    ['WEEKLY', '2026-10-03', '2026-10-09'],
    ['SEMI_MONTHLY', '2026-10-01', '2026-10-15'],
    ['MONTHLY', '2026-10-01', '2026-10-31'],
  ] as const)('يحدد حدود %s ويحسب الموظف المخصص لها', async (frequency, start, end) => {
    await rate('HOURLY', '30');
    await policy({ payrollFrequency: frequency });
    await shift('2026-10-05', 30);
    const row = await period('2026-10-05', frequency);
    expect(row.startDate.slice(0, 10)).toBe(start);
    expect(row.endDate.slice(0, 10)).toBe(end);
    // نصف ساعة × 30 = 15.
    expect(amount((await calc(row.id)).entries[0].netAmount)).toBe('15.00');
  });

  it('يعيد مانع التداخل عند تغيير تكرار الموظف داخل فترة محسوبة', async () => {
    await rate('HOURLY', '30');
    const original = await policy();
    await shift('2026-10-05', 30);
    await calc((await period()).id);
    await ctx.prisma.employeePayPolicy.update({ where: { id: original.id }, data: { payrollFrequency: 'WEEKLY' } });
    const weekly = await period('2026-10-05', 'WEEKLY');
    const result = await calc(weekly.id);
    expect(result.entries).toHaveLength(0);
    expect(result.blockers).toEqual([expect.objectContaining({ code: 'PAYROLL_OVERLAP' })]);
    expect(await ctx.prisma.payrollEntry.count()).toBe(1);
  });

  it('يعيد قائمة موانع الدوام والإجازات ويمنح المراقب القراءة فقط', async () => {
    await rate('HOURLY', '30');
    await policy();
    // الوردية المفتوحة تمتد إلى ما لا نهاية في قيد منع التداخل، فتأتي بعد الوردية غير المعتمدة.
    const date = '2026-10-08';
    const start = new Date(`${date}T06:00:00.000Z`);
    await ctx.prisma.workSession.create({ data: {
      employeeId, departmentId, workDate: d(date), checkInAt: start, originalCheckInAt: start, createdById: adminId,
    } });
    await shift('2026-10-06', 60, '08', 'DRAFT');
    await ctx.prisma.leaveRecord.create({ data: {
      employeeId, type: 'PAID_LEAVE', affectsPay: false, startDate: d('2026-10-07'),
      endDate: d('2026-10-07'), recordedById: adminId,
    } });
    const { id } = await period();
    const path = `/payroll/periods/${id}`;
    await admin.post(`${path}/review`).expect(201);
    await ctx.prisma.session.updateMany({ where: { userId: adminId }, data: { reauthAt: null } });
    const approval = await admin.post(`${path}/approve`).expect(403);
    expect(approval.body.code).toBe('REAUTH_REQUIRED');
    await reauth();
    const { client } = await createSupervisor(ctx, admin, ['finance.view']);
    const checklist = (await client.get(`${path}/checklist`).expect(200)).body;
    expect(checklist.blockers.map((item: { code: string }) => item.code).sort())
      .toEqual(['ATTENDANCE_PENDING', 'LEAVE_PENDING', 'OPEN_SHIFT']);
    await client.post(`${path}/calculate`).expect(403);
    expect(await ctx.prisma.notification.count({ where: { type: 'PAYROLL_READY_FOR_REVIEW' } })).toBe(1);
    expect((await admin.post(`${path}/approve`).expect(409)).body.details.blockers).toHaveLength(3);
    // لا توجد دقائق معتمدة، لذلك الأجر صفر.
    expect(amount((await admin.get(path).expect(200)).body.entries[0].netAmount)).toBe('0.00');
  });

  it('يسجل دفعات متعددة ويمنع إعادة المفتاح والتجاوز ويعكس دفعة ويرحّل الباقي', async () => {
    await rate('HOURLY', '100');
    await policy();
    await shift('2026-10-05', 600);
    const october = await period();
    const entry = await close(october.id);
    expect(entry.snapshot.version).toBe(1);
    expect(amount(entry.netAmount)).toBe('1000.00'); // 10 × 100.
    const details = { payrollEntryId: entry.id, method: 'CASH', receivedBy: 'الموظف', reference: 'إيصال' };
    const key = randomUUID();
    const post = (value: string, token = randomUUID()) =>
      admin.post('/payments', { ...details, amount: value }).set('Idempotency-Key', token);
    const [first, retry] = await Promise.all([post('200', key).expect(201), post('200', key).expect(201)]);
    expect(retry.body).toEqual(first.body);
    await post('300').expect(201);
    await post('500.01').expect(409); // 1000 - 200 - 300 = 500.
    const reversal = await admin.post(`/financial-transactions/${first.body.id}/reverse`, { reason: 'إيصال خاطئ' })
      .set('Idempotency-Key', randomUUID()).expect(201);
    expect(reversal.body.reversesId).toBe(first.body.id);
    expect(await ctx.prisma.financialTransaction.count()).toBe(3);
    expect((await ctx.prisma.financialTransaction.findUniqueOrThrow({ where: { id: first.body.id } })).status).toBe('REVERSED');
    await admin.post(`/payroll/periods/${october.id}/calculate`).expect(409);
    await shift('2026-11-05', 60);
    const november = await period('2026-11-05');
    const next = await close(november.id);
    expect(amount(next.netAmount)).toBe('100.00'); // ساعة نوفمبر فقط.
    const balance = (await admin.get(`/employees/${employeeId}/financial-balances`).expect(200)).body;
    expect(amount(balance.paid)).toBe('300.00');
    expect(amount(balance.outstanding)).toBe('800.00'); // (1000 - 300) + 100.
    expect(amount(balance.entries.find((item: { id: string }) => item.id === entry.id).outstanding)).toBe('700.00');
  });

  it('يفصل السلف والديون ويسوّي جزءًا من الالتزام ويعيد الأرصدة عند العكس', async () => {
    await rate('HOURLY', '100');
    await policy();
    await shift('2026-10-05', 300);
    const entry = await close((await period()).id); // 5 × 100 = 500.
    const advance = (await admin.post('/advances', {
      employeeId, amount: '125', method: 'E_WALLET', receivedBy: 'الموظف', reference: 'سلفة',
    }).set('Idempotency-Key', randomUUID()).expect(201)).body;
    const debt = (await admin.post('/debts', { employeeId, amount: '200', reason: 'دين مستقل' }).expect(201)).body;
    const settle = (value: string) => admin.post('/settlements', {
      payrollEntryId: entry.id, targetType: 'DEBT', targetId: debt.id, amount: value, reason: 'سداد من الراتب',
    }).set('Idempotency-Key', randomUUID());
    const partial = (await settle('80').expect(201)).body;
    expect(await ctx.prisma.settlementAllocation.count({ where: { transactionId: partial.id } })).toBe(2);
    await settle('120.01').expect(409); // الدين 200 - 80 = 120.
    const balance = (await admin.get(`/employees/${employeeId}/financial-balances`).expect(200)).body;
    expect(amount(balance.advances)).toBe('125.00');
    expect(amount(balance.debts)).toBe('120.00');
    expect(amount(balance.settled)).toBe('80.00');
    expect(amount(balance.paid)).toBe('0.00');
    expect(amount(balance.outstanding)).toBe('420.00'); // 500 - 80.
    await admin.post(`/financial-transactions/${partial.id}/reverse`, { reason: 'خطأ تسوية' })
      .set('Idempotency-Key', randomUUID()).expect(201);
    expect((await ctx.prisma.payrollEntry.findUniqueOrThrow({ where: { id: entry.id } })).paidAmount.toFixed(2)).toBe('0.00');
    expect((await ctx.prisma.debtAccount.findUniqueOrThrow({ where: { id: debt.id } })).remainingBalance.toFixed(2)).toBe('200.00');
    expect(await ctx.prisma.debtMovement.count({ where: { debtAccountId: debt.id } })).toBe(3);
    expect((await ctx.prisma.advanceAccount.findUniqueOrThrow({ where: { id: advance.advanceAccountId } })).remainingBalance.toFixed(2)).toBe('125.00');
  });

  it('يطبق فرق الفترة المغلقة مرة واحدة في فترة لاحقة', async () => {
    await rate('HOURLY', '100');
    await policy();
    await shift('2026-10-05', 60);
    const original = await close((await period()).id); // 100.
    const adjustment = (await admin.post('/payroll/adjustments', {
      employeeId, type: 'WAGE_DIFFERENCE', targetEntryId: original.id, amount: '25', reason: 'فرق أجر أكتوبر',
    }).expect(201)).body;
    await admin.post(`/payroll/adjustments/${adjustment.id}/approve`).expect(201);
    await shift('2026-11-05', 60);
    const next = await period('2026-11-05');
    expect(amount((await calc(next.id)).entries[0].netAmount)).toBe('125.00'); // 100 + 25.
    expect(amount((await calc(next.id)).entries[0].netAmount)).toBe('125.00');
    expect((await ctx.prisma.payrollEntry.findUniqueOrThrow({ where: { id: original.id } })).netAmount.toFixed(2)).toBe('100.00');
  });
});
