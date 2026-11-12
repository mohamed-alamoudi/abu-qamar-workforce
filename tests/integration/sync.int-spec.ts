import { randomUUID } from 'crypto';
import { createSupervisor, createTestApp, resetDatabase, setupAdmin, TestContext } from './helpers';

describe('مزامنة الحضور', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx?.app.close(); });
  beforeEach(async () => { await resetDatabase(ctx.prisma); });

  async function fixture() {
    const admin = await setupAdmin(ctx);
    const adminId = (await ctx.prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id;
    const department = await ctx.prisma.department.create({ data: { name: 'المبيعات' } });
    const employee = await ctx.prisma.employee.create({
      data: { fullName: 'موظف الاختبار', departmentId: department.id, createdById: adminId },
    });
    const supervisor = await createSupervisor(ctx, admin, ['attendance.check_in', 'attendance.check_out', 'attendance.correct']);
    const operation = {
      action: 'CHECK_IN', operationId: randomUUID(), deviceId: randomUUID(),
      employeeId: employee.id, createdAt: new Date().toISOString(),
      checkInAt: new Date(Date.now() - 120 * 60_000).toISOString(),
    };
    return { supervisor, operation };
  }

  it('applies a queued operation and returns the stored result on replay', async () => {
    const { supervisor, operation } = await fixture();
    const send = () => supervisor.client.post('/sync/attendance', { userId: supervisor.id, operations: [operation] });
    const applied = await send().expect(200);
    const duplicate = await send().expect(200);
    expect(applied.body.results[0]).toMatchObject({ status: 'APPLIED' });
    expect(duplicate.body.results[0]).toMatchObject({
      status: 'DUPLICATE', originalStatus: 'APPLIED', entityId: applied.body.results[0].entityId,
    });
    expect(await ctx.prisma.workSession.count()).toBe(1);
  });

  it('uses shared attendance rules for a disabled department', async () => {
    const { supervisor, operation } = await fixture();
    const department = await ctx.prisma.department.findFirstOrThrow();
    await ctx.prisma.department.update({ where: { id: department.id }, data: { isActive: false } });
    const response = await supervisor.client.post('/sync/attendance', { userId: supervisor.id, operations: [operation] }).expect(200);
    expect(response.body.results[0]).toMatchObject({ status: 'REJECTED' });
    expect(await ctx.prisma.workSession.count()).toBe(0);
  });

  it('applies a check-in followed by its offline checkout in a single batch', async () => {
    const { supervisor, operation } = await fixture();
    const checkout = {
      action: 'CHECK_OUT', operationId: randomUUID(), deviceId: operation.deviceId,
      createdAt: new Date().toISOString(), sessionId: operation.operationId,
      baseVersion: 1, checkOutAt: new Date(Date.parse(operation.checkInAt) + 60 * 60_000).toISOString(),
    };
    const response = await supervisor.client.post('/sync/attendance', {
      userId: supervisor.id, operations: [operation, checkout],
    }).expect(200);
    expect(response.body.results.map(({ status }: { status: string }) => status)).toEqual(['APPLIED', 'APPLIED']);
    expect(await ctx.prisma.workSession.findFirstOrThrow()).toMatchObject({ status: 'CLOSED', workedMinutes: 60, version: 2 });
    expect(await ctx.prisma.attendanceOperation.count()).toBe(2);
  });

  it('records a version conflict between two devices', async () => {
    const { supervisor, operation } = await fixture();
    const applied = await supervisor.client.post('/sync/attendance', { userId: supervisor.id, operations: [operation] }).expect(200);
    const checkout = {
      action: 'CHECK_OUT', operationId: randomUUID(), deviceId: operation.deviceId, createdAt: operation.createdAt,
      sessionId: applied.body.results[0].entityId, baseVersion: 1, checkOutAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    };
    const first = await supervisor.client.post('/sync/attendance', { userId: supervisor.id, operations: [checkout] }).expect(200);
    expect(first.body.results[0].status).toBe('APPLIED');
    const otherDevice = { ...checkout, operationId: randomUUID(), deviceId: randomUUID() };
    const second = await supervisor.client.post('/sync/attendance', { userId: supervisor.id, operations: [otherDevice] }).expect(200);
    expect(second.body.results[0]).toMatchObject({ status: 'CONFLICT', conflictData: { baseVersion: 1, currentVersion: 2 } });
    expect(await ctx.prisma.notification.count({ where: { type: 'ATTENDANCE_CONFLICT' } })).toBe(1);
  });

  it('records rejection when a permission was removed after the operation was queued', async () => {
    const { supervisor, operation } = await fixture();
    await ctx.prisma.userPermission.deleteMany({ where: { userId: supervisor.id } });
    const result = await supervisor.client.post('/sync/attendance', { userId: supervisor.id, operations: [operation] }).expect(200);
    expect(result.body.results[0]).toMatchObject({ status: 'REJECTED', operationId: operation.operationId });
    expect(await ctx.prisma.syncOperation.findUnique({ where: { operationId: operation.operationId } })).toMatchObject({ status: 'REJECTED' });
    expect(await ctx.prisma.notification.count({ where: { type: 'SYNC_FAILED' } })).toBe(1);
    expect(await ctx.prisma.workSession.count()).toBe(0);
  });

  it.each(['disabled', 'expired'])('does not accept an operation when the session is %s', async (condition) => {
    const { supervisor, operation } = await fixture();
    if (condition === 'disabled') {
      await ctx.prisma.user.update({ where: { id: supervisor.id }, data: { isActive: false } });
    } else {
      await ctx.prisma.session.updateMany({ where: { userId: supervisor.id }, data: { expiresAt: new Date(0) } });
    }
    const result = await supervisor.client.post('/sync/attendance', { userId: supervisor.id, operations: [operation] }).expect(condition === 'disabled' ? 403 : 401);
    expect(result.body.code).toBe(condition === 'disabled' ? 'ACCOUNT_DISABLED' : 'UNAUTHENTICATED');
    expect(await ctx.prisma.workSession.count()).toBe(0);
  });
});
