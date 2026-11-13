import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, type WorkSession } from '@abu-qamar/database';
import { can, type PermissionKey } from '@abu-qamar/shared';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { AppException, Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { addDays, formatDateOnly } from '../common/utils/dates';
import { MaintenanceService } from '../maintenance/maintenance.module';
import { NotificationsService } from '../notifications/notifications.service';
import { OvertimeService } from '../overtime/overtime.module';
import { computeDeviations } from '../schedules/schedule-math';
import { SchedulesService } from '../schedules/schedules.service';
import { SettingsService } from '../settings/settings.module';
import { assertOpenPayroll, lockEmployee, resolveInstant, type Db, type TimeInput } from './attendance-common';
import { computeWorkedMinutes, localDateOf } from './attendance-math';

export interface OperationOptions { clientOperationId?: string; baseVersion?: number }
export interface CheckInInput extends OperationOptions { employeeId: string; departmentId?: string; at?: TimeInput }
export interface CheckOutInput extends OperationOptions { employeeId: string; sessionId?: string; at?: TimeInput }
export interface ManualInput extends OperationOptions { employeeId: string; departmentId?: string; checkInAt: TimeInput; checkOutAt?: TimeInput }
export interface CorrectionInput extends OperationOptions { version?: number; checkInAt?: TimeInput; checkOutAt?: TimeInput; departmentId?: string; reason: string }
type Operation = 'check-in' | 'check-out' | 'manual' | 'correct';
const include = {
  employee: { select: { id: true, fullName: true, code: true, status: true } },
  department: { select: { id: true, name: true } },
  breaks: { orderBy: { startAt: 'asc' } },
} satisfies Prisma.WorkSessionInclude;

export function dayBoundary(date: Date, timezone: string): Date {
  return DateTime.fromISO(formatDateOnly(date), { zone: timezone }).startOf('day').toJSDate();
}

const automaticAbsenceReason = 'غياب تلقائي عن يوم عمل مجدول';
const overlapMessage = 'تتداخل الوردية مع دوام مسجل للموظف. تحقّق من الانصراف والورديات السابقة';

@Injectable()
export class AttendanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(AttendanceService.name);

  constructor(private readonly db: PrismaService, private readonly audit: AuditService,
    private readonly settings: SettingsService, private readonly schedules: SchedulesService,
    private readonly overtime: OvertimeService, private readonly notifications: NotificationsService,
    private readonly maintenance: MaintenanceService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.scanMissing().catch(() => this.logger.error('تعذّر فحص الورديات المفتوحة'));
      void this.scanAbsences().catch(() => this.logger.error('تعذّر فحص الغياب التلقائي'));
    }, 5 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() { clearInterval(this.timer); }

  async scanMissing() {
    if (this.maintenance.active) return;
    const release = this.maintenance.trackRequest();
    try {
      await this.scanOpenShifts();
    } finally {
      release();
    }
  }

  async scanAbsences(now = new Date()) {
    if (this.maintenance.active) return;
    const release = this.maintenance.trackRequest();
    try {
      const zone = await this.timezone();
      const today = localDateOf(now, zone);
      const admin = await this.db.user.findFirst({ where: { role: 'ADMIN', isActive: true }, select: { id: true, username: true } });
      if (!admin) return;
      const from = addDays(today, -2);
      const candidates = await this.schedules.missed(from, addDays(today, -1), undefined, now);
      const days = new Map(candidates.map(item => [item.employee.id + item.date, item]));
      for (const { employee, date } of days.values()) {
        const day = new Date(date + 'T00:00:00Z');
        const notification = await this.db.$transaction(async tx => {
          await lockEmployee(tx, employee.id);
          const staff = await tx.employee.findUnique({ where: { id: employee.id } });
          if (!staff || staff.status !== 'ACTIVE' || localDateOf(staff.createdAt, zone) > day) return;
          const shifts = (await this.schedules.plannedFor([employee.id], day, day, zone, tx)).get(employee.id) ?? [];
          if (!shifts.length || shifts.some(shift => +shift.endAt + 2 * 3_600_000 > +now)) return;
          const closed = await tx.payrollEntry.findFirst({ where: {
            employeeId: employee.id, periodStart: { lte: day }, periodEnd: { gte: day }, period: { status: 'CLOSED' },
          }, select: { id: true } });
          if (closed) return;
          const start = dayBoundary(day, zone);
          const end = dayBoundary(addDays(day, 1), zone);
          const attendance = await tx.workSession.findFirst({ where: {
            employeeId: employee.id, status: { not: 'VOIDED' }, checkInAt: { lt: end },
            OR: [{ checkOutAt: { gt: start } }, { checkOutAt: null }],
          } });
          if (attendance) return;
          const leave = await tx.leaveRecord.findFirst({ where: {
            employeeId: employee.id, startDate: { lte: day }, endDate: { gte: day },
            OR: [{ status: { in: ['PENDING', 'APPROVED'] } }, { reason: automaticAbsenceReason }],
          } });
          if (leave) return;
          const created = await tx.leaveRecord.create({ data: {
            employeeId: employee.id, startDate: day, endDate: day, type: 'UNPAID_ABSENCE',
            reason: automaticAbsenceReason, status: 'PENDING', affectsPay: true, recordedById: admin.id,
          } });
          await this.audit.log({ action: 'leave.auto_recorded', entityType: 'leave_record', entityId: created.id,
            metadata: { employeeId: employee.id, date }, after: created }, tx);
          return this.notifications.notifyAdmin({ type: 'LEAVE_PENDING', title: 'غياب غير مدفوع بانتظار المراجعة',
            body: employee.fullName + ' · ' + date, data: { leaveId: created.id } }, tx);
        });
        this.notifications.deliver(notification);
      }
    } finally {
      release();
    }
  }

  private async scanOpenShifts() {
    const zone = await this.timezone();
    const open = await this.db.workSession.findMany({ where: { status: 'OPEN', checkInAt: { lt: new Date(Date.now() - 60 * 60_000) } },
      include: { employee: { select: { fullName: true } } } });
    for (const session of open) {
      const now = new Date();
      const shifts = (await this.schedules.plannedFor([session.employeeId], addDays(session.workDate, -1),
        session.workDate, zone)).get(session.employeeId) ?? [];
      const planned = shifts.find(shift => shift.startAt <= session.checkInAt && shift.endAt > session.checkInAt)
        ?? shifts.find(shift => shift.date.getTime() === session.workDate.getTime() && shift.startAt > session.checkInAt);
      const deadline = planned ? +planned.endAt + 60 * 60_000 : +session.checkInAt + 12 * 60 * 60_000;
      if (+now < deadline) continue;
      await this.db.$transaction(async tx => {
        await lockEmployee(tx, session.employeeId);
        const current = await tx.workSession.findUnique({ where: { id: session.id } });
        if (current?.status !== 'OPEN' || current.version !== session.version) return;
        const exists = await tx.notification.findFirst({ where: { type: 'MISSING_CHECKOUT',
          data: { path: ['sessionId'], equals: session.id } } });
        if (exists) return;
        await this.notifications.notifyAdmin({ type: 'MISSING_CHECKOUT', title: 'انصراف غير مسجل',
          body: `وردية ${session.employee.fullName} ما زالت مفتوحة`, data: { sessionId: session.id } }, tx);
      });
    }
  }

  async list(where: Prisma.WorkSessionWhereInput, skip: number, take: number) {
    const [rows, total, zone] = await Promise.all([
      this.db.workSession.findMany({ where, skip, take, orderBy: [{ checkInAt: 'desc' }, { id: 'asc' }], include }),
      this.db.workSession.count({ where }), this.timezone(),
    ]);
    const deviations = new Map<string, ReturnType<typeof computeDeviations>>();
    for (const row of rows) {
      const key = row.employeeId + formatDateOnly(row.workDate);
      if (deviations.has(key)) continue;
      const from = addDays(row.workDate, -1);
      const [planned, sessions] = await Promise.all([
        this.schedules.plannedFor([row.employeeId], from, addDays(row.workDate, 1), zone),
        this.db.workSession.findMany({ where: { employeeId: row.employeeId, status: { not: 'VOIDED' },
          workDate: { gte: from, lte: addDays(row.workDate, 1) } } }),
      ]);
      deviations.set(key, computeDeviations(planned.get(row.employeeId) ?? [], sessions));
    }
    const openIds = rows.filter(row => row.status === 'OPEN').map(row => row.id);
    const notices = openIds.length ? await this.db.notification.findMany({
      where: { type: 'MISSING_CHECKOUT', OR: openIds.map(id => ({ data: { path: ['sessionId'], equals: id } })) },
      select: { data: true },
    }) : [];
    const missing = new Set(notices.map(notice => (notice.data as { sessionId?: string } | null)?.sessionId));
    return { total, timezone: zone, items: rows.map(row => ({
      missingCheckOut: missing.has(row.id),
      ...row, workDate: formatDateOnly(row.workDate),
      deviation: deviations.get(row.employeeId + formatDateOnly(row.workDate))?.get(row.id) ?? null,
    })) };
  }

  history(id: string) {
    return this.db.attendanceCorrection.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'desc' },
      include: { correctedBy: { select: { fullName: true } } } });
  }

  checkIn(input: CheckInInput, actor: AuthContext, meta: RequestMeta, transaction?: Db) {
    return this.create('check-in', { ...input, checkInAt: input.at ?? new Date() }, actor, meta, transaction);
  }

  manual(input: ManualInput, actor: AuthContext, meta: RequestMeta, transaction?: Db) {
    return this.create('manual', input, actor, meta, transaction);
  }

  private async create(kind: 'check-in' | 'manual', input: ManualInput, actor: AuthContext, meta: RequestMeta, transaction?: Db) {
    this.authorize(actor, kind === 'manual' ? 'attendance.correct' : 'attendance.check_in');
    return this.operation(kind, input, actor, async tx => {
      await lockEmployee(tx, input.employeeId);
      const employee = await tx.employee.findUnique({ where: { id: input.employeeId } });
      if (!employee) throw Errors.notFound('الموظف غير موجود');
      const zone = await this.timezone();
      const checkInAt = resolveInstant(input.checkInAt, zone, 'وقت الحضور');
      const checkOutAt = input.checkOutAt ? resolveInstant(input.checkOutAt, zone, 'وقت الانصراف') : null;
      const workDate = localDateOf(checkInAt, zone);
      if (employee.status !== 'ACTIVE' || (employee.terminationDate && workDate > employee.terminationDate)) {
        throw Errors.conflict('الموظف متوقف في تاريخ الوردية');
      }
      const departmentId = input.departmentId ?? employee.departmentId;
      await this.assertDepartment(tx, departmentId, kind === 'check-in');
      await this.assertInterval(tx, employee.id, checkInAt, checkOutAt, zone);
      const row = await tx.workSession.create({ data: {
        employeeId: employee.id, departmentId, workDate, checkInAt, checkOutAt, originalCheckInAt: checkInAt,
        originalCheckOutAt: checkOutAt, status: checkOutAt ? 'CLOSED' : 'OPEN',
        workedMinutes: checkOutAt ? computeWorkedMinutes(checkInAt, checkOutAt, []) : null,
        source: input.clientOperationId ? 'OFFLINE_SYNC' : kind === 'manual' ? 'MANUAL' : 'QUICK',
        createdById: actor.user.id, clientOperationId: input.clientOperationId,
      }, include });
      if (checkOutAt) await this.overtime.refresh(tx, employee.id, workDate);
      await this.log(tx, kind, actor, meta, row);
      return row;
    }, transaction);
  }

  async checkOut(input: CheckOutInput, actor: AuthContext, meta: RequestMeta, transaction?: Db) {
    this.authorize(actor, 'attendance.check_out');
    return this.operation('check-out', input, actor, async tx => {
      await lockEmployee(tx, input.employeeId);
      const row = await tx.workSession.findFirst({ where: { id: input.sessionId, employeeId: input.employeeId, status: 'OPEN' }, include });
      if (!row) throw Errors.conflict('لا توجد وردية مفتوحة لهذا الموظف');
      if (row.employee.status !== 'ACTIVE') throw Errors.conflict('الموظف متوقف. لا يمكن تسجيل الانصراف');
      this.assertVersion(row, input.baseVersion);
      await assertOpenPayroll(tx, row.employeeId, row.workDate);
      const zone = await this.timezone();
      const checkOutAt = input.at ? resolveInstant(input.at, zone, 'وقت الانصراف') : new Date();
      await this.assertInterval(tx, row.employeeId, row.checkInAt, checkOutAt, zone, row.id);
      this.assertBreaks(row.breaks, row.checkInAt, checkOutAt);
      const after = await tx.workSession.update({ where: { id: row.id }, data: {
        checkOutAt, originalCheckOutAt: row.originalCheckOutAt ?? checkOutAt, status: 'CLOSED',
        workedMinutes: computeWorkedMinutes(row.checkInAt, checkOutAt, row.breaks),
        version: { increment: 1 }, updatedById: actor.user.id,
      }, include });
      await this.overtime.refresh(tx, row.employeeId, row.workDate);
      await this.log(tx, 'check-out', actor, meta, after, row);
      return after;
    }, transaction);
  }

  async correct(id: string, input: CorrectionInput, actor: AuthContext, meta: RequestMeta, transaction?: Db) {
    this.authorize(actor, 'attendance.correct');
    return this.operation('correct', input, actor, async tx => {
      const row = await this.lockedSession(tx, id, input.baseVersion ?? input.version);
      if (!input.reason.trim()) throw Errors.validation('أدخل سبب التصحيح');
      const zone = await this.timezone();
      const checkInAt = input.checkInAt ? resolveInstant(input.checkInAt, zone, 'وقت الحضور') : row.checkInAt;
      const checkOutAt = input.checkOutAt ? resolveInstant(input.checkOutAt, zone, 'وقت الانصراف') : row.checkOutAt;
      const workDate = input.checkInAt ? localDateOf(checkInAt, zone) : row.workDate;
      if (row.employee.status === 'INACTIVE') {
        const { terminationDate } = await tx.employee.findUniqueOrThrow({ where: { id: row.employeeId }, select: { terminationDate: true } });
        if (terminationDate && workDate > terminationDate) throw Errors.conflict('لا يمكن نقل الوردية إلى ما بعد تاريخ إيقاف الموظف');
      }
      await assertOpenPayroll(tx, row.employeeId, workDate);
      const departmentId = input.departmentId ?? row.departmentId;
      if (+checkInAt === +row.checkInAt && checkOutAt?.getTime() === row.checkOutAt?.getTime() && departmentId === row.departmentId) {
        throw Errors.validation('غيّر وقت الحضور أو الانصراف أو قسم الوردية قبل الحفظ');
      }
      if (departmentId !== row.departmentId) await this.assertDepartment(tx, departmentId, false);
      await this.assertInterval(tx, row.employeeId, checkInAt, checkOutAt, zone, id);
      this.assertBreaks(row.breaks, checkInAt, checkOutAt);
      const after = await tx.workSession.update({ where: { id }, data: {
        checkInAt, checkOutAt, workDate, departmentId, status: checkOutAt ? 'CLOSED' : 'OPEN', approvalStatus: 'DRAFT',
        workedMinutes: checkOutAt ? computeWorkedMinutes(checkInAt, checkOutAt, row.breaks) : null,
        version: { increment: 1 }, updatedById: actor.user.id,
      }, include });
      await tx.attendanceCorrection.create({ data: { sessionId: id, correctedById: actor.user.id,
        reason: input.reason.trim(), before: this.snapshot(row), after: this.snapshot(after) } });
      if (row.approvalStatus !== 'DRAFT') await tx.attendanceApproval.create({ data: { sessionId: id,
        fromStatus: row.approvalStatus, toStatus: 'DRAFT', actorId: actor.user.id, note: input.reason.trim() } });
      await tx.overtimeEntry.updateMany({ where: { sessionId: id, status: { in: ['APPROVED', 'PENDING_APPROVAL'] } },
        data: { status: 'DETECTED', decidedAt: null, decidedById: null } });
      await this.overtime.refresh(tx, row.employeeId, row.workDate);
      if (+workDate !== +row.workDate) await this.overtime.refresh(tx, row.employeeId, workDate);
      await this.log(tx, 'correct', actor, meta, after, row);
      return after;
    }, transaction);
  }

  async bulkTransition(action: 'review' | 'approve',
    scope: { employeeId?: string; departmentId?: string; from?: Date; to?: Date }, actor: AuthContext, meta: RequestMeta) {
    if (action === 'review') this.authorize(actor, 'attendance.correct');
    else if (actor.user.role !== 'ADMIN') throw Errors.adminOnly();
    if (scope.from && scope.to && scope.from > scope.to) throw Errors.validation('تاريخ النهاية يسبق البداية');

    const candidates = await this.db.workSession.findMany({
      where: {
        employeeId: scope.employeeId, departmentId: scope.departmentId,
        workDate: { gte: scope.from, lte: scope.to },
        status: 'CLOSED', checkOutAt: { not: null },
        approvalStatus: action === 'review' ? 'DRAFT' : 'IN_REVIEW',
      },
      select: { id: true, version: true },
    });
    let updated = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      try {
        await this.transition(candidate.id, action, candidate.version, actor, meta);
        updated++;
      } catch (error) {
        if (!(error instanceof AppException) || ![404, 409].includes(error.getStatus())) throw error;
        skipped++;
      }
    }
    return { updated, skipped };
  }

  async transition(id: string, action: 'review' | 'approve' | 'void', version: number, actor: AuthContext, meta: RequestMeta, reason?: string) {
    if (action === 'review') this.authorize(actor, 'attendance.correct');
    else if (actor.user.role !== 'ADMIN') throw Errors.adminOnly();
    return this.db.$transaction(async tx => {
      const row = await this.lockedSession(tx, id, version);
      if (action === 'void') {
        if (!reason?.trim()) throw Errors.validation('أدخل سبب الإلغاء');
        const after = await tx.workSession.update({ where: { id }, data: { status: 'VOIDED', voidedAt: new Date(),
          voidReason: reason.trim(), version: { increment: 1 }, updatedById: actor.user.id }, include });
        await this.overtime.refresh(tx, row.employeeId, row.workDate);
        await this.log(tx, action, actor, meta, after, row);
        return after;
      }
      const expected = action === 'review' ? 'DRAFT' : 'IN_REVIEW';
      const toStatus = action === 'review' ? 'IN_REVIEW' : 'APPROVED';
      if (row.status !== 'CLOSED' || row.approvalStatus !== expected) throw Errors.conflict('حالة الوردية لا تسمح بهذه العملية');
      const after = await tx.workSession.update({ where: { id }, data: {
        approvalStatus: toStatus, version: { increment: 1 }, updatedById: actor.user.id,
      }, include });
      await tx.attendanceApproval.create({ data: { sessionId: id, fromStatus: expected, toStatus, actorId: actor.user.id, note: reason } });
      await this.log(tx, action, actor, meta, after, row);
      return after;
    });
  }

  async recordBreak(id: string, start: boolean, version: number, actor: AuthContext, meta: RequestMeta, isPaid = false) {
    this.authorize(actor, start ? 'attendance.check_in' : 'attendance.check_out');
    return this.db.$transaction(async tx => {
      const row = await this.lockedSession(tx, id, version);
      if (row.status !== 'OPEN') throw Errors.conflict('الاستراحة متاحة أثناء وردية مفتوحة');
      const active = row.breaks.find(item => !item.endAt);
      const now = new Date();
      if (start) {
        if (active || now < row.checkInAt || row.breaks.some(item => item.endAt && item.endAt > now)) throw Errors.conflict('لا يمكن بدء استراحة الآن');
        await tx.workBreak.create({ data: { sessionId: id, startAt: now, isPaid, createdById: actor.user.id } });
      } else {
        if (!active || now <= active.startAt) throw Errors.conflict('لا توجد استراحة قابلة للإنهاء');
        await tx.workBreak.update({ where: { id: active.id }, data: { endAt: now } });
      }
      const after = await tx.workSession.update({ where: { id }, data: { version: { increment: 1 }, updatedById: actor.user.id }, include });
      await this.log(tx, start ? 'break_started' : 'break_ended', actor, meta, after, row);
      return after;
    });
  }

  private async operation(kind: Operation, options: OperationOptions, actor: AuthContext, run: (tx: Db) => Promise<WorkSession>, transaction?: Db) {
    const clientId = options.clientOperationId;
    const write = async (tx: Db) => {
      if (clientId) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) throw Errors.validation('معرّف العملية غير صالح');
        await lockEmployee(tx, 'attendance-operation:' + clientId);
        const prior = await tx.attendanceOperation.findUnique({ where: { id: clientId } });
        if (prior) {
          if (prior.actorId !== actor.user.id || prior.kind !== kind) throw Errors.conflict('معرّف العملية مستخدم مسبقًا');
          return tx.workSession.findUniqueOrThrow({ where: { id: prior.sessionId }, include });
        }
      }
      const row = await run(tx);
      if (clientId) await tx.attendanceOperation.create({ data: { id: clientId, sessionId: row.id, actorId: actor.user.id, kind } });
      return row;
    };
    if (transaction) return write(transaction);
    try {
      return await this.db.$transaction(write);
    } catch (error) {
      if (error instanceof Error && (error.message === overlapMessage || error.message.includes('work_sessions_no_overlap'))) {
        await this.notifications.notifyAdmin({ type: 'ATTENDANCE_CONFLICT', title: 'تعارض في الدوام', body: overlapMessage });
        throw Errors.conflict(overlapMessage);
      }
      throw error;
    }
  }

  private async lockedSession(tx: Db, id: string, version?: number) {
    const initial = await tx.workSession.findUnique({ where: { id }, select: { employeeId: true } });
    if (!initial) throw Errors.notFound('سجل الدوام غير موجود');
    await lockEmployee(tx, initial.employeeId);
    const row = await tx.workSession.findUniqueOrThrow({ where: { id }, include });
    this.assertVersion(row, version);
    if (row.status === 'VOIDED') throw Errors.conflict('سجل الدوام ملغى');
    await assertOpenPayroll(tx, row.employeeId, row.workDate);
    return row;
  }

  private assertVersion(row: WorkSession, version?: number) {
    if (version !== undefined && version !== row.version) throw Errors.conflict('تغيّر سجل الدوام. حدّث الصفحة ثم أعد المحاولة');
  }

  private async assertInterval(tx: Db, employeeId: string, start: Date, end: Date | null, zone: string, exclude?: string) {
    if (end && end <= start) throw Errors.validation('وقت الانصراف يجب أن يلي وقت الحضور');
    if (start > new Date() || (end && end > new Date())) throw Errors.validation('أوقات الدوام لا تكون في المستقبل');
    await assertOpenPayroll(tx, employeeId, localDateOf(start, zone));
    const overlapping = await tx.workSession.findFirst({ where: {
      employeeId, id: exclude ? { not: exclude } : undefined, status: { not: 'VOIDED' },
      checkInAt: end ? { lt: end } : undefined, OR: [{ checkOutAt: null }, { checkOutAt: { gt: start } }],
    } });
    if (overlapping) throw Errors.conflict(overlapMessage);
    const firstDate = localDateOf(start, zone);
    const lastDate = end ? localDateOf(new Date(+end - 1), zone) : firstDate;
    const leaves = await tx.leaveRecord.findMany({ where: { employeeId, status: { in: ['PENDING', 'APPROVED'] },
      startDate: { lte: lastDate }, endDate: { gte: firstDate } } });
    for (const leave of leaves) {
      const automatic = leave.status === 'PENDING' && leave.reason === automaticAbsenceReason &&
        await tx.auditLog.findFirst({ where: { entityId: leave.id, action: 'leave.auto_recorded' }, select: { id: true } });
      if (!automatic) throw Errors.conflict('تتداخل الوردية مع إجازة أو غياب مسجل للموظف');
      await tx.leaveRecord.update({ where: { id: leave.id }, data: { status: 'CANCELLED' } });
      await this.audit.log({ action: 'leave.auto_cancelled_by_attendance', entityType: 'leave_record', entityId: leave.id,
        metadata: { employeeId } }, tx);
    }
  }

  private assertBreaks(breaks: { startAt: Date; endAt: Date | null }[], start: Date, end: Date | null) {
    if (breaks.some(item => item.startAt < start || (end && (!item.endAt || item.endAt > end)))) {
      throw Errors.conflict('أنه الاستراحة المفتوحة وتأكد من وقوع الاستراحات داخل حدود الوردية');
    }
  }

  private async assertDepartment(tx: Db, id: string, active: boolean) {
    const department = await tx.department.findUnique({ where: { id } });
    if (!department || (active && !department.isActive)) throw Errors.validation('اختر قسمًا صالحًا للوردية');
  }

  private authorize(actor: AuthContext, permission: PermissionKey) {
    if (!can(actor.user, permission)) throw Errors.forbidden();
  }

  private async timezone() { return (await this.settings.getAll())['general.timezone']; }

  private snapshot(row: WorkSession) {
    return { checkInAt: row.checkInAt.toISOString(), checkOutAt: row.checkOutAt?.toISOString() ?? null,
      workDate: formatDateOnly(row.workDate), departmentId: row.departmentId, status: row.status,
      workedMinutes: row.workedMinutes, approvalStatus: row.approvalStatus, version: row.version };
  }

  private log(tx: Db, action: string, actor: AuthContext, meta: RequestMeta, after: WorkSession, before?: WorkSession) {
    return this.audit.log({ action: 'attendance.' + action, actor, meta, entityType: 'work_session', entityId: after.id,
      before, after }, tx);
  }
}
