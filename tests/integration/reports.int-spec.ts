import ExcelJS from 'exceljs';
import type { IncomingMessage } from 'node:http';
import { ADMIN, Client, TestContext, createSupervisor, createTestApp, resetDatabase, setupAdmin } from './helpers';

const date = (value: string) => new Date(value);
const day = date('2026-01-15');
const previous = date('2026-01-14');
const next = date('2026-01-16');
const midnight = date('2026-01-14T22:00:00.000Z');
const end = date('2026-01-15T22:00:00.000Z');
const range = 'from=2026-01-15&to=2026-01-15';
type Report = 'attendance' | 'absence' | 'financial' | 'payments';

function collect(res: IncomingMessage, done: (error: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
  res.on('error', (error: Error) => done(error, Buffer.concat(chunks)));
}

describe('التقارير', () => {
  let ctx: TestContext;
  let admin: Client;
  let employeeId: string;
  let secondEmployeeId: string;
  let departmentId: string;
  let executorId: string;

  const get = (report: Report, query = '') => admin.get(`/reports/${report}?${range}${query ? `&${query}` : ''}`);

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    admin = await setupAdmin(ctx);
    const db = ctx.prisma;
    const { id: createdById } = await db.user.findUniqueOrThrow({ where: { username: ADMIN.username } });
    executorId = createdById;
    const produce = await db.department.create({ data: { name: 'الخضار' } });
    const sales = await db.department.create({ data: { name: 'المبيعات' } });
    departmentId = produce.id;
    const first = await db.employee.create({ data: { fullName: 'أحمد محمود', departmentId, createdById } });
    const second = await db.employee.create({ data: { fullName: 'مريم سالم', departmentId: sales.id, createdById } });
    await db.employee.create({ data: { fullName: 'سمير صالح', departmentId, createdById } });
    employeeId = first.id;
    secondEmployeeId = second.id;
    const checkInAt = date('2026-01-15T06:15:00.000Z');
    const checkOutAt = date('2026-01-15T14:00:00.000Z');
    await db.scheduleShift.create({ data: { employeeId, departmentId, startAt: date('2026-01-15T06:00:00.000Z'), endAt: checkOutAt } });
    const closed = {
      status: 'CLOSED' as const, checkInAt, checkOutAt, originalCheckInAt: checkInAt,
      originalCheckOutAt: checkOutAt, createdById,
    };
    const session = await db.workSession.create({
      data: { ...closed, employeeId, departmentId, workDate: day, workedMinutes: 435, approvalStatus: 'APPROVED' },
    });
    await db.workBreak.create({ data: {
      sessionId: session.id, createdById, startAt: date('2026-01-15T09:00:00.000Z'), endAt: date('2026-01-15T09:30:00.000Z'),
    } });
    await db.overtimeEntry.create({ data: {
      employeeId, sessionId: session.id, workDate: day, minutes: 25, multiplier: '1.5',
      status: 'APPROVED', decidedById: createdById, decidedAt: checkOutAt,
    } });
    await db.workSession.createMany({ data: [
      { ...closed, employeeId: second.id, departmentId: sales.id, workDate: day, workedMinutes: 465 },
      { ...closed, employeeId, departmentId, workDate: day, status: 'VOIDED', voidedAt: checkOutAt, voidReason: 'أُلغي في الاختبار', workedMinutes: 465 },
      { ...closed, employeeId, departmentId, workDate: next, workedMinutes: 60,
        checkInAt: end, originalCheckInAt: end, checkOutAt: date('2026-01-15T23:00:00Z'), originalCheckOutAt: date('2026-01-15T23:00:00Z') },
    ] });
    await db.leaveRecord.createMany({ data: [
      { employeeId, recordedById: createdById, type: 'PAID_LEAVE', startDate: previous, endDate: day, affectsPay: false },
      { employeeId: second.id, recordedById: createdById, type: 'UNPAID_ABSENCE', startDate: day, endDate: next, affectsPay: true },
      { employeeId, recordedById: createdById, type: 'UNPAID_ABSENCE', startDate: next, endDate: next, affectsPay: true },
    ] });

    const period = await db.payrollPeriod.create({ data: {
      frequency: 'WEEKLY', startDate: previous, endDate: day, label: 'أسبوع الاختبار', createdById,
    } });
    const entry = await db.payrollEntry.create({ data: {
      periodId: period.id, periodStart: previous, periodEnd: day, employeeId, grossAmount: '1.25',
      deductionsAmount: '0.15', netAmount: '1.10', paidAmount: '0.10',
    } });
    const secondEntry = await db.payrollEntry.create({ data: {
      periodId: period.id, periodStart: previous, periodEnd: day, employeeId: second.id,
      grossAmount: '2.20', netAmount: '2.20', paidAmount: '0.20',
    } });
    await db.payrollEntryComponent.create({ data: {
      entryId: entry.id, type: 'REGULAR_WAGE', description: 'أجر أساسي', amount: '1.25',
    } });
    await db.payrollPeriod.update({ where: { id: period.id }, data: {
      status: 'CLOSED', approvedAt: end, approvedById: createdById, closedAt: end, closedById: createdById,
    } });
    const later = await db.payrollPeriod.create({ data: { frequency: 'WEEKLY', startDate: next, endDate: next, label: 'فترة لاحقة', status: 'CLOSED', createdById } });
    await db.payrollEntry.create({ data: {
      periodId: later.id, periodStart: next, periodEnd: next, employeeId, grossAmount: '40.00', netAmount: '40.00',
    } });
    const txn = { employeeId, createdById, type: 'SALARY_PAYMENT' as const, method: 'CASH' as const, payrollEntryId: entry.id };
    await db.financialTransaction.createMany({ data: [
      { ...txn, idempotencyKey: 'report-payment-start', occurredAt: midnight, amount: '0.10' },
      { ...txn, idempotencyKey: 'report-payment-inside', employeeId: second.id, payrollEntryId: secondEntry.id, occurredAt: date('2026-01-15T21:59:59.999Z'), amount: '0.20', method: 'BANK_TRANSFER' },
      { ...txn, idempotencyKey: 'report-payment-before', occurredAt: date('2026-01-14T21:59:59.999Z'), amount: '12.00' },
      { ...txn, idempotencyKey: 'report-payment-after', occurredAt: end, amount: '15.00' },
    ] });
    const advance = await db.advanceAccount.create({ data: {
      employeeId, principalAmount: '0.80', remainingBalance: '0.60', disbursedAt: midnight, createdById,
    } });
    await db.debtAccount.create({ data: {
      employeeId, principalAmount: '4.90', remainingBalance: '3.90', incurredAt: midnight, createdById,
    } });
    const settlement = await db.financialTransaction.create({ data: {
      employeeId, type: 'SETTLEMENT', amount: '0.20', occurredAt: midnight, createdById, idempotencyKey: 'report-settlement',
    } });
    await db.settlementAllocation.create({ data: {
      transactionId: settlement.id, targetType: 'ADVANCE', advanceAccountId: advance.id, amount: '0.20',
    } });
  });

  afterAll(async () => { await ctx?.app.close(); });

  describe('الدوام', () => {
    it('يجمع دقائق العمل والاستراحة والتأخير ويستثني الملغى واليوم التالي', async () => {
      const response = await get('attendance', 'columns=workedMinutes,unpaidBreakMinutes,lateMinutes,workDate,overtimeApprovedMinutes&pageSize=1').expect(200);
      expect(response.body).toMatchObject({ total: 2, totalPages: 2, totals: {
        workedMinutes: 900, unpaidBreakMinutes: 30, lateMinutes: 15, overtimeApprovedMinutes: 25,
      } });
      const second = await get('attendance', `employeeId=${secondEmployeeId}&columns=lateMinutes`).expect(200);
      expect(second.body.items[0].lateMinutes).toBeNull();
      const late = await get('attendance', 'lateOnly=true&view=employees').expect(200);
      expect(late.body).toMatchObject({ total: 1, totals: { workedMinutes: 435, lateMinutes: 15 } });
    });
  });

  describe('الغياب', () => {
    it('يحسب التقاطع مع الفترة ويستند إلى سجلات الإجازة فقط', async () => {
      const response = await get('absence', 'view=employees').expect(200);
      expect(response.body).toMatchObject({ total: 2, totals: { daysInRange: 2, paidDays: 1, unpaidDays: 1, absenceDays: 1 } });
      const paid = await get('absence', 'pay=paid').expect(200);
      expect(paid.body).toMatchObject({ total: 1, totals: { paidDays: 1, unpaidDays: 0 } });
    });
  });

  describe('المالية', () => {
    it('يجمع صافي المستحق والمدفوع والرصيد بدقة حسب نهاية الفترة', async () => {
      const response = await get('financial', 'columns=netAmount,paidAmount,unpaidAmount').expect(200);
      expect(response.body).toMatchObject({ total: 2, totals: { netAmount: '3.30', paidAmount: '0.30', unpaidAmount: '3.00' } });
      const entries = await get('financial', 'view=entries&columns=regularWage,netAmount').expect(200);
      expect(entries.body.totals).toEqual({ regularWage: '1.25', netAmount: '3.30' });
      const advances = await get('financial', 'view=advances').expect(200);
      expect(advances.body.totals).toEqual({ principalAmount: '0.80', repaidAmount: '0.20', remainingBalance: '0.60' });
      const debts = await get('financial', 'view=debts').expect(200);
      expect(debts.body.totals).toEqual({ principalAmount: '4.90', repaidAmount: '1.00', remainingBalance: '3.90' });
      const settlements = await get('financial', 'view=settlements&targetType=ADVANCE').expect(200);
      expect(settlements.body).toMatchObject({ total: 1, totals: { amount: '0.20' } });
    });
  });

  describe('الدفعات', () => {
    it('يطبق منتصف الليل المحلي ويجمع حسب مفاتيح التجميع الأربعة', async () => {
      const response = await get('payments').expect(200);
      expect(response.body).toMatchObject({ timezone: 'Asia/Gaza', total: 2, totals: { amount: '0.30' } });
      for (const [view, total] of [['byEmployee', 2], ['byPeriod', 1], ['byMethod', 2], ['byExecutor', 1]]) {
        const grouped = await get('payments', `view=${view}`).expect(200);
        expect(grouped.body).toMatchObject({ total, totals: { amount: '0.30', paymentsCount: 2 } });
      }
      const outside = await get('payments', 'view=byMethod&page=9&pageSize=1').expect(200);
      expect(outside.body).toMatchObject({ total: 2, items: [] });
      const executor = await get('payments', `executorId=${executorId}&method=CASH`).expect(200);
      expect(executor.body).toMatchObject({ total: 1, totals: { amount: '0.10' } });
    });
  });

  it.each([
    ['attendance', 'workedMinutes', 435],
    ['absence', 'paidDays', 1],
    ['financial', 'netAmount', '1.10'],
    ['payments', 'amount', '0.10'],
  ] as const)('%s يطبّق نطاق الموظف والقسم، والبحث، وقائمة الأعمدة', async (report, column, total) => {
    const all = await get(report).expect(200);
    expect(all.body.total).toBe(2);
    for (const scope of [`employeeId=${employeeId}`, `departmentId=${departmentId}`, `search=${encodeURIComponent('أحمد')}`]) {
      const response = await get(report, `${scope}&columns=${column}`).expect(200);
      expect(response.body.total).toBe(1);
      expect(response.body.totals).toEqual({ [column]: total });
      expect(Object.keys(response.body.items[0]).sort()).toEqual(['id', 'employeeId', column].sort());
    }
    await get(report, 'columns=passwordHash').expect(400);
    await get(report, 'view=constructor').expect(400);
  });

  it('يعزل التقارير والتصدير حسب الصلاحية', async () => {
    const { client } = await createSupervisor(ctx, admin, ['reports.attendance']);
    await client.get(`/reports/attendance?${range}`).expect(200);
    for (const report of ['absence', 'financial', 'payments']) {
      await client.get(`/reports/${report}?${range}`).expect(403);
      await client.get(`/reports/${report}?${range}&format=xlsx`).expect(403);
      await client.get(`/reports/${report}?${range}&format=pdf`).expect(403);
    }
  });

  it.each([
    ['attendance', 'workDate,workedMinutes', 'ساعات العمل', 435 / 1440],
    ['absence', 'startDate,paidDays', 'أيام مدفوعة', 1],
    ['financial', 'employeeName,netAmount', 'صافي المستحق', 1.10],
    ['payments', 'occurredAt,amount', 'المبلغ', 0.10],
  ] as const)('%s يصدر Excel بقيم رقمية وPDF بخط مضمن ويسجل التدقيق', async (report, columns, label, firstValue) => {
    const selected = `employeeId=${employeeId}&columns=${columns}`;
    const xlsx = await get(report, `${selected}&format=xlsx`).buffer(true).parse(collect).expect(200);
    expect(xlsx.headers['content-disposition']).toMatch(/\.xlsx"$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.body);
    const sheet = workbook.worksheets[0];
    expect(sheet.views[0].rightToLeft).toBe(true);
    expect(sheet.getCell('B5').value).toBe(label);
    const value = sheet.getCell('B6').value;
    // ExcelJS يعيد تفسير تنسيق المدة كزمن مبني على عدد الأيام.
    if (value instanceof Date) {
      expect((value.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000).toBeCloseTo(firstValue);
    } else {
      expect(value).toBeCloseTo(firstValue);
    }
    expect(sheet.getCell('A7').value).toBe('الإجمالي');
    if (report !== 'financial') expect(sheet.getCell('A6').value).toBeInstanceOf(Date);
    const pdf = await get(report, `${selected}&format=pdf`).buffer(true).parse(collect).expect(200);
    const content = (pdf.body as Buffer).toString('latin1');
    expect(content).toMatch(/^%PDF-/);
    expect(content).toMatch(/\/FontFile2\b/);
    expect(content).toMatch(/NotoNaskhArabic/);
    expect(content).toMatch(/%%EOF\s*$/);
    const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'report.exported', actorId: executorId } });
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ report, format: 'xlsx', rowCount: 1 }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ report, format: 'pdf', rowCount: 1 }) }),
    ]));
  });

  it('يرفض التصدير فوق الحد دون تسجيل عملية تصدير', async () => {
    const db = ctx.prisma;
    const where = { action: 'report.exported' };
    const before = await db.auditLog.count({ where });
    const occurredAt = date('2026-01-20T10:00Z');
    await db.financialTransaction.createMany({ data: Array.from({ length: 5_001 }, (_, index) => ({
      employeeId, createdById: executorId, type: 'SALARY_PAYMENT', amount: '0.01',
      idempotencyKey: `report-cap-${index}`, occurredAt,
    })) });
    const response = await admin.get('/reports/payments?from=2026-01-20&to=2026-01-20&format=xlsx').expect(400);
    expect(response.body.message).toContain('حد التصدير 5000 صف');
    expect(await db.auditLog.count({ where })).toBe(before);
  });
});
