import { AttendanceService } from '../../apps/api/src/attendance/attendance.service';
import { Client, createSupervisor, createTestApp, resetDatabase, setupAdmin, type TestContext } from './helpers';

describe('الحضور والانصراف', () => {
  let ctx: TestContext;
  let admin: Client;
  let adminId: string;
  let employeeId: string;
  let otherDepartment: string;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx?.app.close(); });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await setupAdmin(ctx);
    adminId = (await admin.get('/auth/me')).body.user.id;
    const home = await admin.post('/departments', { name: 'الصندوق' });
    otherDepartment = (await admin.post('/departments', { name: 'المخبز' })).body.id;
    employeeId = (await admin.post('/employees', { fullName: 'أحمد سالم', departmentId: home.body.id,
      pay: { payType: 'HOURLY', amount: 20, effectiveFrom: '2026-01-01' } })).body.id;
    expect(employeeId).toBeDefined();
  });

  const manual = (checkInAt: string, checkOutAt?: string, extra: object = {}) =>
    admin.post('/attendance/manual', { employeeId, checkInAt, checkOutAt, ...extra });

  it('يرسل ويعتمد كل الورديات المؤهلة في النطاق عبر أكثر من صفحة', async () => {
    const first = await manual('2026-03-01T08:00', '2026-03-01T09:00').expect(201);
    const original = await ctx.prisma.workSession.findUniqueOrThrow({ where: { id: first.body.id } });
    await ctx.prisma.workSession.createMany({
      data: Array.from({ length: 20 }, (_, i) => {
        const day = String(i + 2).padStart(2, '0');
        const start = new Date('2026-03-' + day + 'T06:00:00Z');
        const end = new Date(+start + 3_600_000);
        return {
          employeeId, departmentId: original.departmentId, createdById: adminId,
          workDate: new Date('2026-03-' + day), checkInAt: start, checkOutAt: end,
          originalCheckInAt: start, originalCheckOutAt: end, status: 'CLOSED', workedMinutes: 60,
        };
      }),
    });
    const excluded = await manual('2026-03-22T08:00', '2026-03-22T09:00', { departmentId: otherDepartment }).expect(201);
    const open = await manual('2026-03-23T08:00').expect(201);
    const supervisor = await createSupervisor(ctx, admin, ['attendance.correct']);
    const viewer = await createSupervisor(ctx, admin, ['attendance.view'], { username: 'bulk_viewer' });
    const scope = { departmentId: original.departmentId, from: '2026-03-01', to: '2026-03-23' };
    await viewer.client.post('/attendance/bulk/review', scope).expect(403);
    await admin.post('/attendance/bulk/review', { from: '2026-03-23', to: '2026-03-01' }).expect(400);
    await admin.post('/attendance/bulk/approve', scope).expect(201, { updated: 0, skipped: 0 });
    await supervisor.client.post('/attendance/bulk/review', scope).expect(201, { updated: 21, skipped: 0 });
    await supervisor.client.post('/attendance/bulk/approve', scope).expect(403);
    await supervisor.client.post('/attendance/bulk/approve/preview', scope).expect(403);
    await admin.post('/attendance/bulk/approve/preview', scope).expect(201, { ready: 21, needsReview: 1 });
    await admin.post('/attendance/bulk/approve', scope).expect(201, { updated: 21, skipped: 0 });
    await admin.post('/attendance/bulk/approve', scope).expect(201, { updated: 0, skipped: 0 });
    expect(await ctx.prisma.workSession.count({ where: { approvalStatus: 'APPROVED', version: 3 } })).toBe(21);
    expect(await ctx.prisma.attendanceApproval.count()).toBe(42);
    expect(await ctx.prisma.workSession.count({
      where: { id: { in: [excluded.body.id, open.body.id] }, approvalStatus: 'DRAFT' },
    })).toBe(2);
  });

  it('يسجل غياب يوم مجدول مرة واحدة ويقبل حضورًا وصل متأخرًا', async () => {
    const date = '2026-03-01';
    await ctx.prisma.employee.update({ where: { id: employeeId }, data: { createdAt: new Date('2026-02-01T10:00Z') } });
    await admin.post('/schedules', { employeeId, kind: 'FIXED', effectiveFrom: '2026-02-01',
      weeklyPattern: [{ day: 0, start: '08:00', end: '16:00' }] }).expect(201);
    const service = ctx.app.get(AttendanceService);
    await service.scanAbsences(new Date('2026-03-01T20:00Z'));
    expect(await ctx.prisma.leaveRecord.count()).toBe(0);
    const nextDay = new Date('2026-03-02T08:00Z');
    await Promise.all([service.scanAbsences(nextDay), service.scanAbsences(nextDay)]);
    const record = await ctx.prisma.leaveRecord.findFirstOrThrow();
    expect(record).toMatchObject({ startDate: new Date(date), type: 'UNPAID_ABSENCE', status: 'PENDING', affectsPay: true });
    await manual(date + 'T08:00', date + 'T16:00').expect(201);
    expect(await ctx.prisma.leaveRecord.findUnique({ where: { id: record.id } })).toMatchObject({ status: 'CANCELLED' });
    await service.scanAbsences(nextDay);
    expect(await ctx.prisma.leaveRecord.count()).toBe(1);
  });

  it('يمنع إضافة وردية جديدة للموظف الموقوف ويحفظ سجله السابق', async () => {
    const old = await manual('2026-03-01T08:00', '2026-03-01T09:00').expect(201);
    await admin.post('/employees/' + employeeId + '/deactivate', { terminationDate: '2026-03-02' }).expect(200);
    await admin.post('/attendance/check-in', { employeeId }).expect(409);
    await manual('2026-03-02T08:00', '2026-03-02T09:00').expect(409);
    await manual('2026-03-01T10:00').expect(409);
    expect(await ctx.prisma.workSession.count({ where: { employeeId } })).toBe(1);
    const history = await admin.get('/attendance?employeeId=' + employeeId).expect(200);
    expect(history.body.items[0]).toMatchObject({ id: old.body.id });
  });

  it('يسجل حضورًا وانصرافًا سريعين ويمنع حضورين متزامنين', async () => {
    const results = await Promise.all([admin.post('/attendance/check-in', { employeeId, departmentId: otherDepartment }),
      admin.post('/attendance/check-in', { employeeId, departmentId: otherDepartment })]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    const opened = results.find(result => result.status === 201)!;
    expect(opened.body).toMatchObject({ status: 'OPEN', departmentId: otherDepartment });
    const closed = await admin.post('/attendance/check-out', { employeeId, sessionId: opened.body.id, baseVersion: 1, clientOperationId: 'quick-out' });
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({ status: 'CLOSED', version: 2, originalCheckOutAt: closed.body.checkOutAt });
    const retry = await admin.post('/attendance/check-out', { employeeId, sessionId: opened.body.id, baseVersion: 1, clientOperationId: 'quick-out' });
    expect(retry.body).toMatchObject({ id: closed.body.id, version: 2 });
    expect(await ctx.prisma.notification.count({ where: { type: 'ATTENDANCE_CONFLICT' } })).toBe(1);
  });

  it('يدعم ورديات متعددة ويحسب الوردية الليلية في تاريخ بدايتها المحلي', async () => {
    const first = await manual('2026-03-01T08:00', '2026-03-01T12:00', { clientOperationId: 'manual-a' });
    const retry = await manual('2026-03-01T08:00', '2026-03-01T12:00', { clientOperationId: 'manual-a' });
    expect(retry.body.id).toBe(first.body.id);
    expect((await manual('2026-03-01T12:00', '2026-03-01T15:00')).status).toBe(201);
    const night = await manual('2026-03-01T22:00', '2026-03-02T03:30');
    expect(night.body).toMatchObject({ workDate: '2026-03-01T00:00:00.000Z', workedMinutes: 330 });
    const overlap = await manual('2026-03-02T03:00', '2026-03-02T04:00');
    expect(overlap.status).toBe(409);
    expect(overlap.body.message).toContain('تتداخل');
    expect((await admin.get('/attendance?from=2026-03-01&to=2026-03-01')).body.total).toBe(3);
  });

  it('يخصم الاستراحة غير المدفوعة ويحمي الوردية أثناء الاستراحة المفتوحة', async () => {
    const start = new Date(Date.now() - 180 * 60_000);
    const opened = await manual(start.toISOString());
    const id = opened.body.id;
    const paid = await admin.post(`/attendance/${id}/breaks/start`, { version: 1, isPaid: true });
    expect(paid.status).toBe(201);
    expect((await admin.post('/attendance/check-out', { employeeId })).status).toBe(409);
    expect((await admin.post(`/attendance/${id}/breaks/end`, { version: 2 })).status).toBe(201);
    const unpaid = await admin.post(`/attendance/${id}/breaks/start`, { version: 3, isPaid: false });
    expect(unpaid.status).toBe(201);
    const end = await admin.post(`/attendance/${id}/breaks/end`, { version: 4 });
    expect(end.status).toBe(201);
    const [paidRow, unpaidRow] = end.body.breaks;
    await ctx.prisma.workBreak.update({ where: { id: paidRow.id }, data: {
      startAt: new Date(+start + 30 * 60_000), endAt: new Date(+start + 45 * 60_000),
    } });
    await ctx.prisma.workBreak.update({ where: { id: unpaidRow.id }, data: {
      startAt: new Date(+start + 60 * 60_000), endAt: new Date(+start + 90 * 60_000),
    } });
    const closed = await admin.post('/attendance/check-out', { employeeId, baseVersion: 5 });
    expect(closed.body.workedMinutes).toBe(150);
  });

  it('يحفظ الأصل وسبب التصحيح ويسجل الاعتماد والإلغاء مع فحص الإصدار', async () => {
    const created = await manual('2026-03-01T08:00', '2026-03-01T15:00');
    const id = created.body.id;
    const payload = { baseVersion: 1, clientOperationId: 'correction-a', checkInAt: '2026-03-01T08:30', reason: 'مراجعة سجل الدوام' };
    const changed = await admin.patch(`/attendance/${id}`, payload);
    expect(changed.body).toMatchObject({ originalCheckInAt: created.body.checkInAt, originalCheckOutAt: created.body.checkOutAt, version: 2, workedMinutes: 390 });
    expect((await admin.patch(`/attendance/${id}`, payload)).body.version).toBe(2);
    expect((await admin.patch(`/attendance/${id}`, { ...payload, clientOperationId: 'correction-b' })).status).toBe(409);
    const history = await admin.get(`/attendance/${id}/corrections`);
    expect(history.body).toHaveLength(1);
    expect(history.body[0]).toMatchObject({ correctedById: adminId, reason: payload.reason,
      before: { checkInAt: created.body.checkInAt }, after: { checkInAt: changed.body.checkInAt } });
    expect((await admin.post(`/attendance/${id}/approve`, { version: 2 })).status).toBe(409);
    expect((await admin.post(`/attendance/${id}/review`, { version: 2 })).body.approvalStatus).toBe('IN_REVIEW');
    expect((await admin.post(`/attendance/${id}/approve`, { version: 3 })).body.approvalStatus).toBe('APPROVED');
    expect((await admin.post(`/attendance/${id}/void`, { version: 4, reason: 'إدخال غير صحيح' })).body.status).toBe('VOIDED');
    expect((await manual('2026-03-01T08:00', '2026-03-01T15:00')).status).toBe(201);
  });

  it('يكتشف الانصراف الناقص ويرسل إشعارًا واحدًا لكل وردية', async () => {
    const opened = await manual('2026-03-01T08:00');
    const service = ctx.app.get(AttendanceService);
    await Promise.all([service.scanMissing(), service.scanMissing()]);
    const records = await ctx.prisma.notification.findMany({ where: { type: 'MISSING_CHECKOUT' } });
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toEqual({ sessionId: opened.body.id });
  });

  it('يقيس التأخير والانصراف المبكر لجدول ثابت أو مؤرخ فقط', async () => {
    await manual('2026-03-01T08:15', '2026-03-01T15:50');
    expect((await admin.get('/attendance')).body.items[0].deviation).toBeNull();
    const fixed = await admin.post('/schedules', { employeeId, kind: 'FIXED', effectiveFrom: '2026-02-01',
      weeklyPattern: [{ day: 0, start: '08:00', end: '16:00' }] });
    expect(fixed.status).toBe(201);
    expect((await admin.get('/attendance')).body.items[0].deviation).toMatchObject({ lateMinutes: 15, earlyLeaveMinutes: 10 });
    expect((await admin.post('/schedules', { employeeId, kind: 'FLEXIBLE', effectiveFrom: '2026-03-02' })).status).toBe(201);
    expect((await admin.get('/schedules/missed?from=2026-03-08&to=2026-03-08')).body).toEqual([]);
    expect((await admin.post('/schedules', { employeeId, kind: 'VARIABLE', effectiveFrom: '2026-03-09' })).status).toBe(201);
    expect((await admin.post('/schedules/shifts', { employeeId, startAt: '2026-03-10T08:00', endAt: '2026-03-10T16:00' })).status).toBe(201);
    await manual('2026-03-10T08:20', '2026-03-10T16:00');
    expect((await admin.get('/attendance')).body.items[0].deviation).toMatchObject({ lateMinutes: 20, earlyLeaveMinutes: 0 });
    expect(await ctx.prisma.leaveRecord.count()).toBe(0);
  });

  it('يرفض تداخل الإجازة مع وردية تعبر منتصف الليل ويشترط الاعتماد', async () => {
    await manual('2026-03-01T22:00', '2026-03-02T04:00');
    const leave = { employeeId, type: 'UNPAID_ABSENCE', affectsPay: true, startDate: '2026-03-02', endDate: '2026-03-02' };
    expect((await admin.post('/leaves', leave)).status).toBe(409);
    const supervisor = await createSupervisor(ctx, admin, ['leaves.view', 'leaves.record']);
    const pending = await supervisor.client.post('/leaves', { ...leave, startDate: '2026-03-03', endDate: '2026-03-03' });
    expect(pending.body.status).toBe('PENDING');
    const path = `/leaves/${pending.body.id}/decision`;
    expect((await supervisor.client.post(path, { status: 'APPROVED' })).status).toBe(403);
    expect((await admin.post(path, { status: 'APPROVED' })).body.status).toBe('APPROVED');
    expect((await manual('2026-03-03T08:00', '2026-03-03T09:00')).status).toBe(409);
    expect(await ctx.prisma.notification.count({ where: { type: 'LEAVE_PENDING' } })).toBe(1);
  });

  it('يكتشف الإضافي وفق السياسة السارية ويقصر اعتماده على الأدمن', async () => {
    expect((await admin.post('/overtime/policies', { effectiveFrom: '2026-02-01', dailyThresholdMinutes: 300 })).status).toBe(201);
    const general = await manual('2026-03-01T08:00', '2026-03-01T15:00');
    const defaultEntry = await ctx.prisma.overtimeEntry.findFirstOrThrow({ where: { sessionId: general.body.id } });
    expect(defaultEntry.multiplier.toString()).toBe('1.5');
    expect((await admin.post('/overtime/policies', { employeeId, effectiveFrom: '2026-03-02', dailyThresholdMinutes: 360,
      multiplier: 2, specialHourlyRate: 50 })).status).toBe(201);
    const row = await manual('2026-03-03T08:00', '2026-03-03T15:00');
    const entry = await ctx.prisma.overtimeEntry.findFirstOrThrow({ where: { sessionId: row.body.id } });
    expect(entry).toMatchObject({ status: 'DETECTED', minutes: 60 });
    expect(entry.specialHourlyRate?.toString()).toBe('50');
    const path = `/overtime/${entry.id}/decision`;
    expect((await admin.post(path, { status: 'PENDING_APPROVAL' })).body.status).toBe('PENDING_APPROVAL');
    const supervisor = await createSupervisor(ctx, admin, ['attendance.view', 'attendance.correct']);
    expect((await supervisor.client.post(path, { status: 'APPROVED' })).status).toBe(403);
    expect((await admin.post(path, { status: 'APPROVED' })).status).toBe(409);
    await admin.post(`/attendance/${row.body.id}/review`, { version: 1 });
    await admin.post(`/attendance/${row.body.id}/approve`, { version: 2 });
    expect((await admin.post(path, { status: 'APPROVED' })).body.status).toBe('APPROVED');
    expect(await ctx.prisma.notification.count({ where: { type: 'OVERTIME_PENDING' } })).toBe(1);
  });

  it('يفرض صلاحيات الحضور المستقلة على الخادم', async () => {
    const supervisor = await createSupervisor(ctx, admin, ['attendance.check_in']);
    expect((await supervisor.client.get('/attendance')).status).toBe(403);
    expect((await supervisor.client.post('/attendance/manual', { employeeId, checkInAt: '2026-03-01T08:00' })).status).toBe(403);
    const open = await supervisor.client.post('/attendance/check-in', { employeeId });
    expect(open.status).toBe(201);
    expect((await supervisor.client.post('/attendance/check-out', { employeeId })).status).toBe(403);
    expect((await supervisor.client.post(`/attendance/${open.body.id}/approve`, { version: 1 })).status).toBe(403);
  });

  it('يرفض تعديل أو إلغاء وردية في فترة رواتب مغلقة', async () => {
    const row = await manual('2026-03-01T08:00', '2026-03-01T15:00');
    const period = await ctx.prisma.payrollPeriod.create({ data: { frequency: 'MONTHLY', label: 'مارس',
      startDate: new Date('2026-03-01'), endDate: new Date('2026-03-31'), createdById: adminId } });
    await ctx.prisma.payrollEntry.create({ data: { periodId: period.id, employeeId, periodStart: period.startDate,
      periodEnd: period.endDate, netAmount: 100 } });
    await ctx.prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: adminId } });
    const changed = await admin.patch(`/attendance/${row.body.id}`, { version: 1, checkInAt: '2026-04-01T08:00', reason: 'تصحيح' });
    expect(changed.status).toBe(409);
    expect(changed.body.message).toContain('مغلقة');
    await admin.post('/attendance/bulk/review', { employeeId }).expect(201, { updated: 0, skipped: 1 });
    expect(await ctx.prisma.attendanceApproval.count()).toBe(0);
    expect((await admin.post(`/attendance/${row.body.id}/void`, { version: 1, reason: 'إلغاء' })).status).toBe(409);
  });
});
