import { HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PayrollPeriod, Prisma } from '@abu-qamar/database';
import { ERROR_CODES } from '@abu-qamar/shared';
import { lockEmployee } from '../attendance/attendance-common';
import { minutesBetween } from '../attendance/attendance-math';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { paginate, toSkipTake } from '../common/dto/pagination.dto';
import { AppException, Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { addDays, formatDateOnly, parseDateOnly, todayInZone } from '../common/utils/dates';
import { resolvePlannedShifts } from '../schedules/schedule-math';
import { SettingsService } from '../settings/settings.module';
import { MaintenanceService } from '../maintenance/maintenance.module';
import { calculateEntry } from './calc/calculator';
import { monthEnd, monthKey, monthStart } from './calc/iso-dates';
import { resolvePayrollPeriod } from './calc/periods';
import { financiallyLinkedEntry, needsPayrollRefresh } from './payroll-entry-state';
import type { CalcComponent } from './calc/types';
import type { CreatePeriodDto, PeriodsQueryDto } from './dto/payroll.dto';

type Tx = Prisma.TransactionClient;
type Blocker = { code: string; employeeId?: string; recordId?: string; message: string };
const iso = formatDateOnly;
const span = ({ effectiveFrom, effectiveTo }: { effectiveFrom: Date; effectiveTo: Date | null }) =>
  ({ from: iso(effectiveFrom), to: effectiveTo && iso(effectiveTo) });
const employeeSelect = { id: true, fullName: true, code: true } as const;
const detailInclude = {
  entries: { orderBy: { employee: { code: 'asc' } }, include: { employee: { select: employeeSelect }, components: true } },
} satisfies Prisma.PayrollPeriodInclude;

type ComponentFields = Omit<CalcComponent, 'workDate' | 'type' | 'sourceType' | 'unit'> & {
  workDate: string | Date | null; type: string; sourceType: string | null; unit: string | null;
};

function componentSignature(components: ComponentFields[]): string {
  return JSON.stringify(components.map((item) => JSON.stringify([
    item.type, item.description, item.amount.toFixed(2), item.sourceType, item.sourceId,
    item.workDate instanceof Date ? iso(item.workDate) : item.workDate,
    item.quantity?.toFixed(4), item.unit, item.rate?.toFixed(4),
  ])).sort());
}
export async function lockPayroll(tx: Tx) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(406201)::text AS locked`;
}

@Injectable()
export class PayrollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayrollService.name);
  private timer?: ReturnType<typeof setInterval>;
  private lastPreparedDay?: string;
  private preparing = false;
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly maintenance: MaintenanceService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging') return;
    const tick = () => void this.prepareScheduled().catch(() => this.logger.warn('تعذّر تجهيز دورات الرواتب تلقائيًا'));
    this.timer = setInterval(tick, 15 * 60_000);
    tick();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async prepareScheduled() {
    if (this.preparing || this.maintenance.active) return;
    const release = this.maintenance.trackRequest();
    this.preparing = true;
    try {
      const settings = await this.settings.getAll();
      const day = iso(todayInZone(settings['general.timezone']));
      if (day === this.lastPreparedDay) return;
      const admin = await this.db.user.findFirst({
        where: { role: 'ADMIN', isActive: true }, select: { id: true, username: true },
      });
      if (!admin) return;
      await this.prepareCycles(admin);
      this.lastPreparedDay = day;
    } finally {
      this.preparing = false;
      release();
    }
  }

  async list(query: PeriodsQueryDto) {
    const where = { frequency: query.frequency, status: query.status };
    const [items, total] = await this.db.$transaction([
      this.db.payrollPeriod.findMany({
        where, ...toSkipTake(query), orderBy: [{ startDate: 'desc' }, { id: 'asc' }], include: { _count: { select: { entries: true } } },
      }),
      this.db.payrollPeriod.count({ where }),
    ]);
    return paginate(items, total, query);
  }

  async get(id: string, tx: Tx = this.db) {
    const row = await tx.payrollPeriod.findUnique({ where: { id }, include: detailInclude });
    if (!row) throw Errors.notFound('فترة الرواتب غير موجودة');
    return row;
  }

  async create(dto: CreatePeriodDto, actor: AuthContext, meta: RequestMeta) {
    let bounds;
    if (dto.from && dto.to && !dto.date) {
      if (dto.to < dto.from) throw Errors.validation('تاريخ النهاية يسبق تاريخ البداية');
      if (dto.to >= addDays(dto.from, 366)) throw Errors.validation('الفترة لا تتجاوز 366 يومًا');
      bounds = { start: iso(dto.from), end: iso(dto.to), label: iso(dto.from) + ' — ' + iso(dto.to) };
    } else if (dto.date && !dto.from && !dto.to) {
      const settings = await this.settings.getAll();
      bounds = resolvePayrollPeriod(dto.frequency, iso(dto.date), settings['general.weekStartsOn']);
    } else {
      throw Errors.validation('حدّد تاريخ البداية والنهاية للفترة');
    }
    return this.db.$transaction(async (tx) => {
      const row = await tx.payrollPeriod.create({ data: {
        frequency: dto.frequency, startDate: parseDateOnly(bounds.start)!, endDate: parseDateOnly(bounds.end)!,
        label: bounds.label, createdById: actor.user.id,
      } });
      await this.audit.log({ action: 'payroll.period.create', actor, meta, entityType: 'payroll_period', entityId: row.id, after: row }, tx);
      return row;
    });
  }

  async prepareCurrent(actor: AuthContext, meta: RequestMeta) {
    if (actor.user.role !== 'ADMIN') throw Errors.adminOnly();
    return this.prepareCycles(actor, meta);
  }

  private async prepareCycles(actor: AuthContext | { id: string; username: string }, meta?: RequestMeta) {
    return this.db.$transaction(async tx => {
      await lockPayroll(tx);
      const settings = await this.settings.getAll(tx);
      const today = todayInZone(settings['general.timezone']);
      const policies = await tx.employeePayPolicy.findMany({
        where: { employee: { status: 'ACTIVE' }, effectiveFrom: { lte: today },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] },
        distinct: ['payrollFrequency'], select: { payrollFrequency: true },
      });
      for (const { payrollFrequency: frequency } of policies) {
        const existing = await tx.payrollPeriod.findFirst({
          where: { frequency, startDate: { lte: today }, endDate: { gte: today } },
          orderBy: [{ startDate: 'desc' }, { endDate: 'asc' }, { id: 'asc' }],
        });
        if (existing && (existing.status === 'CLOSED' || existing.status === 'READY_FOR_APPROVAL')) continue;
        const bounds = resolvePayrollPeriod(frequency, iso(today), settings['general.weekStartsOn']);
        const period = existing ?? await tx.payrollPeriod.create({ data: {
          frequency, startDate: parseDateOnly(bounds.start)!, endDate: parseDateOnly(bounds.end)!,
          label: bounds.label, createdById: ('user' in actor ? actor.user : actor).id,
        } });
        await this.calculatePeriod(tx, period.id, 'calculate', actor, meta, settings['general.timezone']);
      }
      return { ok: true };
    }, { timeout: 30_000 });
  }

  async remove(id: string, actor: AuthContext, meta: RequestMeta) {
    if (actor.user.role !== 'ADMIN') throw Errors.adminOnly();
    return this.db.$transaction(async tx => {
      await lockPayroll(tx);
      await tx.$queryRaw`SELECT id FROM payroll_entries WHERE "periodId" = ${id}::uuid ORDER BY id FOR UPDATE`;
      const period = await this.get(id, tx);
      if (period.status !== 'DRAFT' && period.status !== 'IN_REVIEW') {
        throw Errors.conflict('يمكن حذف المسودات والفترات قيد المراجعة فقط');
      }
      const linked = await tx.payrollEntry.findFirst({
        where: { periodId: id, OR: [financiallyLinkedEntry, { adjustmentsApplied: { some: {} } }] },
        select: { id: true },
      });
      if (linked) throw Errors.conflict('لا يمكن حذف فترة مرتبطة بدفعة أو تسوية أو فرق راتب');

      await tx.payrollEntry.deleteMany({ where: { periodId: id } });
      await tx.payrollPeriod.delete({ where: { id } });
      await this.audit.log({ action: 'payroll.period.delete', actor, meta, entityType: 'payroll_period', entityId: id,
        before: { label: period.label, status: period.status, frequency: period.frequency,
          startDate: iso(period.startDate), endDate: iso(period.endDate), entries: period.entries.length } }, tx);
      return { deleted: true };
    }, { timeout: 30_000 });
  }

  async reopen(id: string, reason: string, actor: AuthContext, meta: RequestMeta) {
    if (actor.user.role !== 'ADMIN') throw Errors.adminOnly();
    return this.db.$transaction(async tx => {
      await lockPayroll(tx);
      // نفس قفل الصف الذي تستخدمه الدفعات والتسويات. بعد فتح الفترة ترفض خدمة الصرف أي طلب ينتظر القفل.
      await tx.$queryRaw`SELECT id FROM payroll_entries WHERE "periodId" = ${id}::uuid ORDER BY id FOR UPDATE`;
      const period = await this.get(id, tx);
      if (period.status !== 'CLOSED') throw Errors.conflict('الفترة غير مغلقة');
      const linked = await tx.payrollEntry.findFirst({
        where: { periodId: id, ...financiallyLinkedEntry },
        select: { id: true },
      });
      if (linked) throw Errors.conflict('لا يمكن إعادة فتح فترة لها دفعة أو تسوية أو فرق راتب مرتبط. عالج الفروقات في فترة مفتوحة');

      for (const entry of period.entries) {
        await this.audit.log({ action: 'payroll.entry.archived_on_reopen', actor, meta,
          entityType: 'payroll_entry', entityId: entry.id, before: JSON.parse(JSON.stringify(entry)),
          metadata: { periodId: id, reason } }, tx);
      }
      await tx.$queryRaw`SELECT set_config('aq.reopen_period', ${id}, true)`;
      const updated = await tx.payrollPeriod.update({ where: { id }, data: {
        status: 'DRAFT', approvedAt: null, approvedById: null, closedAt: null, closedById: null,
      } });
      await tx.payrollAdjustment.updateMany({
        where: { appliedEntry: { periodId: id }, status: 'APPLIED' },
        data: { status: 'APPROVED', appliedEntryId: null },
      });
      await tx.payrollEntry.deleteMany({ where: { periodId: id } });
      await this.audit.log({ action: 'payroll.period.reopen', actor, meta, entityType: 'payroll_period', entityId: id,
        before: { status: period.status, closedAt: period.closedAt, closedById: period.closedById },
        after: { status: updated.status }, metadata: { reason, archivedEntries: period.entries.length } }, tx);
      return updated;
    }, { timeout: 30_000 });
  }

  async refreshClosed(id: string, reason: string, actor: AuthContext, meta: RequestMeta) {
    if (actor.user.role !== 'ADMIN') throw Errors.adminOnly();
    const timezone = (await this.settings.getAll())['general.timezone'];
    return this.db.$transaction(async tx => {
      await lockPayroll(tx);
      await this.lockCalculationInputs(tx);
      await tx.$queryRaw`SELECT id FROM payroll_entries WHERE "periodId" = ${id}::uuid ORDER BY id FOR UPDATE`;
      const period = await this.get(id, tx);
      if (period.status !== 'CLOSED') throw Errors.conflict('تحديث المستحقات بهذه الطريقة متاح للفترات المغلقة فقط');
      const locked = await tx.payrollEntry.findMany({
        where: { periodId: id, ...financiallyLinkedEntry },
        select: { employeeId: true },
      });
      const protectedEmployees = new Set(locked.map(entry => entry.employeeId));
      const previous = new Map(period.entries.map(entry => [entry.employeeId, entry]));
      const { calculations, blockers } = await this.prepare(tx, period, timezone, {
        protectedEmployees, existingEmployees: new Set(previous.keys()),
      });
      const blocked = new Set(blockers.map(item => item.employeeId));
      const calculated = new Set(calculations.map(item => item.employeeId));
      for (const old of previous.values()) {
        if (!protectedEmployees.has(old.employeeId) && needsPayrollRefresh(old.snapshot) &&
            !calculated.has(old.employeeId) && !blocked.has(old.employeeId)) {
          blockers.push({ code: 'REFRESH_POLICY', employeeId: old.employeeId,
            message: 'تأكد أن دورة صرف الموظف تطابق هذه الفترة' });
        }
      }
      let added = 0;
      let updated = 0;
      for (const { employeeId, result } of calculations) {
        if (blocked.has(employeeId)) continue;
        const old = previous.get(employeeId);
        if (!old && result.components.length === 0) continue;
        const employee = old?.employee ?? await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: employeeSelect });
        const amounts = { grossAmount: result.gross, deductionsAmount: result.deductions, netAmount: result.net };
        const snapshot = JSON.parse(JSON.stringify({
          version: 1, period: { start: iso(period.startDate), end: iso(period.endDate), frequency: period.frequency },
          employee, ...amounts, days: result.days, components: result.components, warnings: result.warnings,
        })) as Prisma.InputJsonValue;
        const sameComponents = old && componentSignature(old.components) === componentSignature(result.components);
        if (old && old.netAmount.eq(result.net) && sameComponents && !needsPayrollRefresh(old.snapshot)) continue;
        if (old) {
          await tx.$queryRaw`SELECT set_config('aq.refresh_payroll_entry', ${old.id}, true)`;
          await tx.payrollEntry.update({ where: { id: old.id }, data: { ...amounts, snapshot } });
          updated++;
        } else {
          added++;
        }
        const entry = old ?? await tx.payrollEntry.create({
          data: { ...amounts, snapshot, employeeId, periodId: id, periodStart: period.startDate, periodEnd: period.endDate },
        });
        if (!sameComponents) {
          await tx.$queryRaw`SELECT set_config('aq.refresh_payroll_entry', ${entry.id}, true)`;
          if (old) await tx.payrollEntryComponent.deleteMany({ where: { entryId: entry.id } });
          await tx.payrollEntryComponent.createMany({ data: result.components.map(component => ({
            ...component, entryId: entry.id, workDate: component.workDate ? parseDateOnly(component.workDate) : null,
          })) });
        }
        await this.audit.log({ action: 'payroll.entry.refresh_closed', actor, meta, entityType: 'payroll_entry', entityId: entry.id,
          before: old ? JSON.parse(JSON.stringify(old)) : null, after: snapshot, metadata: { periodId: id, reason } }, tx);
      }
      const employeesWithBlockers = await tx.employee.findMany({
        where: { id: { in: blockers.flatMap(item => item.employeeId ? [item.employeeId] : []) } },
        select: { id: true, fullName: true },
      });
      const names = new Map(employeesWithBlockers.map(employee => [employee.id, employee.fullName]));
      const result = { added, updated, protected: locked.length,
        blockers: blockers.map(item => ({ ...item, employeeName: item.employeeId ? names.get(item.employeeId) : undefined })) };
      await this.audit.log({ action: 'payroll.period.refresh_closed', actor, meta, entityType: 'payroll_period', entityId: id,
        metadata: { reason, ...result } }, tx);
      return result;
    }, { timeout: 30_000 });
  }

  private async lockCalculationInputs(tx: Tx) {
    const employees = await tx.employee.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    for (const employee of employees) await lockEmployee(tx, employee.id);
    await tx.$executeRaw`LOCK TABLE work_sessions, overtime_entries, leave_records, pay_rates, employee_pay_policies, employee_schedules, schedule_shifts, employees IN SHARE MODE`;
  }

  private async prepare(tx: Tx, period: PayrollPeriod, timezone: string,
    refresh?: { protectedEmployees: Set<string>; existingEmployees: Set<string> }, onlyEmployeeId?: string) {
    const { id, startDate, endDate, frequency } = period;
    const overlap = { effectiveFrom: { lte: endDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: startDate } }] };
    const dates = { gte: startDate, lte: endDate };
    // قاسم أيام العمل المجدولة يخص الشهر كاملًا حتى عند الصرف أسبوعيًا أو نصف شهريًا.
    const scheduleStart = parseDateOnly(monthStart(monthKey(iso(startDate))))!;
    const scheduleEnd = parseDateOnly(monthEnd(monthKey(iso(endDate))))!;
    const scheduleOverlap = {
      effectiveFrom: { lte: scheduleEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: scheduleStart } }],
    };
    const employees = await tx.employee.findMany({
      where: { id: onlyEmployeeId },
      orderBy: { id: 'asc' },
      select: {
        id: true, terminationDate: true,
        payRates: { where: overlap, orderBy: { effectiveFrom: 'asc' } },
        payPolicies: { where: overlap, orderBy: { effectiveFrom: 'asc' } },
        schedules: { where: scheduleOverlap },
        scheduleShifts: { where: { startAt: { gte: addDays(scheduleStart, -1), lt: addDays(scheduleEnd, 2) } } },
        workSessions: { where: { workDate: dates, status: { not: 'VOIDED' } }, orderBy: { id: 'asc' } },
        overtimeEntries: { where: { workDate: dates }, orderBy: { id: 'asc' } },
        leaveRecords: { where: { startDate: { lte: endDate }, endDate: { gte: startDate }, status: { in: ['APPROVED', 'PENDING'] } }, orderBy: { id: 'asc' } },
        payrollEntries: { where: { periodId: { not: id }, periodStart: { lte: endDate }, periodEnd: { gte: startDate } } },
        adjustments: {
          where: refresh ? { status: 'APPLIED', appliedEntry: { periodId: id } }
            : { OR: [{ status: 'APPROVED', appliedEntryId: null, OR: [{ targetEntryId: null }, { targetEntry: { periodEnd: { lt: startDate } } }] }, { status: 'APPLIED', appliedEntry: { periodId: id } }] },
          orderBy: { id: 'asc' },
        },
      },
    });

    const blockers: Blocker[] = [];
    const calculations = [];
    for (const employee of employees) {
      const employeeId = employee.id;
      if (refresh?.protectedEmployees.has(employeeId)) continue;
      if (refresh && !refresh.existingEmployees.has(employeeId) && !employee.workSessions.length && !employee.leaveRecords.length) continue;
      if (employee.terminationDate && employee.terminationDate < startDate && !employee.adjustments.length) continue;
      // التكرار يتحدد بأول سياسة سارية في الفترة، أما الأجر وطريقة حسابه فلكل يوم على حدة.
      if ((employee.payPolicies[0]?.payrollFrequency ?? 'MONTHLY') !== frequency) continue;
      if (!employee.payRates.length && !employee.workSessions.length && !employee.leaveRecords.length &&
          !employee.overtimeEntries.length && !employee.adjustments.length) continue;
      if (employee.payrollEntries.length) {
        blockers.push({ code: 'PAYROLL_OVERLAP', employeeId, recordId: employee.payrollEntries[0].id, message: 'يوجد مستحق آخر للموظف يتداخل مع هذه الفترة' });
        continue;
      }
      for (const session of employee.workSessions) {
        if (session.status === 'OPEN') blockers.push({ code: 'OPEN_SHIFT', employeeId, recordId: session.id, message: 'يوجد انصراف غير مسجل' });
        else if (session.approvalStatus !== 'APPROVED') blockers.push({ code: 'ATTENDANCE_PENDING', employeeId, recordId: session.id, message: 'توجد وردية غير معتمدة' });
      }
      const sessions = employee.workSessions.filter((row) => row.status === 'CLOSED' && row.approvalStatus === 'APPROVED');
      for (const leave of employee.leaveRecords) {
        if (leave.status === 'PENDING') blockers.push({ code: 'LEAVE_PENDING', employeeId, recordId: leave.id, message: 'توجد إجازة أو حالة غياب بانتظار الاعتماد' });
        else if (employee.workSessions.some((row) => row.workDate >= leave.startDate && row.workDate <= leave.endDate)) {
          blockers.push({ code: 'LEAVE_OVERLAP', employeeId, recordId: leave.id, message: 'تتداخل الإجازة المعتمدة مع دوام مسجل' });
        }
      }
      // «مرفوض» دون صاحب قرار يعني أن اكتشافًا آليًا سابقًا أُلغي عند تصحيح الدوام.
      const overtimeRows = employee.overtimeEntries.filter((row) => row.status !== 'REJECTED' || row.decidedById !== null);
      const overtimeSessions = new Set<string>();
      const usableOvertime = [];
      for (const overtime of overtimeRows) {
        if (overtime.sessionId) {
          const session = employee.workSessions.find((row) => row.id === overtime.sessionId);
          if (!session || +session.workDate !== +overtime.workDate ||
              (session.status === 'CLOSED' && overtime.minutes > (session.workedMinutes ?? 0)) ||
              overtimeSessions.has(overtime.sessionId)) {
            blockers.push({ code: 'OVERTIME_OVERLAP', employeeId, recordId: overtime.id, message: 'سجل إضافي مكرر أو لا يطابق دقائق الوردية' });
            continue;
          }
          overtimeSessions.add(overtime.sessionId);
          if (overtime.status === 'APPROVED' && !sessions.some((row) => row.id === session.id)) {
            blockers.push({ code: 'OVERTIME_ATTENDANCE_PENDING', employeeId, recordId: overtime.id, message: 'اعتمد الوردية المرتبطة بالإضافي أولًا' });
            continue;
          }
        }
        usableOvertime.push(overtime);
        if (overtime.status === 'DETECTED' || overtime.status === 'PENDING_APPROVAL') {
          blockers.push({ code: 'OVERTIME_PENDING', employeeId, recordId: overtime.id, message: 'يوجد عمل إضافي بانتظار القرار' });
        }
      }
      const approvedLeaves = employee.leaveRecords.filter((row) => row.status === 'APPROVED').map((row) => ({
        id: row.id, startDate: iso(row.startDate), endDate: iso(row.endDate),
        paid: row.type === 'PAID_LEAVE' || row.type === 'PAID_EXCUSED_ABSENCE',
        affectsPay: row.affectsPay && (row.type === 'UNPAID_ABSENCE' || row.type === 'UNPAID_LEAVE'),
      }));
      const plannedMinutes = new Map<string, number>();
      if (approvedLeaves.some((row) => row.paid) && employee.payRates.some((rate) => rate.payType !== 'MONTHLY')) {
        const planned = resolvePlannedShifts(employee.schedules, employee.scheduleShifts, startDate, endDate, timezone);
        for (const shift of planned) {
          const date = iso(shift.date);
          plannedMinutes.set(date, (plannedMinutes.get(date) ?? 0) + minutesBetween(shift.startAt, shift.endAt));
        }
      }
      const result = calculateEntry({
        periodStart: iso(startDate), periodEnd: iso(endDate),
        rates: employee.payRates.map((row) => ({ ...row, ...span(row) })),
        policies: employee.payPolicies.map((row) => ({ ...row, ...span(row) })),
        sessions: sessions.map((row) => ({ ...row, workDate: iso(row.workDate), workedMinutes: row.workedMinutes ?? 0 })),
        overtime: usableOvertime.map((row) => ({ ...row, workDate: iso(row.workDate) })),
        leaves: approvedLeaves,
        plannedMinutes,
        schedules: employee.schedules.map((row) => ({
          ...span(row), isFlexible: row.isFlexible,
          weekDays: Array.isArray(row.weeklyPattern)
            ? row.weeklyPattern.flatMap((day) => day && typeof day === 'object' && !Array.isArray(day) && typeof day.day === 'number' ? [day.day] : [])
            : [],
        })),
        scheduledShiftDates: employee.scheduleShifts.map((row) => iso(todayInZone(timezone, row.startAt))),
        employmentEnd: employee.terminationDate && iso(employee.terminationDate),
        adjustments: employee.adjustments,
      });
      blockers.push(...result.warnings.filter((warning) => warning.blocking).map((warning) => ({ ...warning, employeeId })));
      calculations.push({ employeeId, result, adjustments: employee.adjustments });
    }
    if (!refresh && !calculations.length && !blockers.length) blockers.push({ code: 'NO_ENTRIES', message: 'لا توجد مستحقات قابلة للحساب في الفترة' });
    return { calculations, blockers };
  }

  async checklist(id: string) {
    const period = await this.get(id);
    if (period.status === 'CLOSED') return { blockers: [] };
    const settings = await this.settings.getAll();
    const { blockers } = await this.prepare(this.db, period, settings['general.timezone']);
    return { blockers };
  }

  async run(id: string, operation: 'calculate' | 'review' | 'approve' | 'close', actor: AuthContext, meta: RequestMeta) {
    const timezone = (await this.settings.getAll())['general.timezone'];
    return this.db.$transaction(async (tx) => {
      await lockPayroll(tx);
      return this.calculatePeriod(tx, id, operation, actor, meta, timezone);
    }, { timeout: 30000 });
  }

  async refreshForAttendance(tx: Tx, employeeId: string, workDate: Date, create: boolean, actor: AuthContext, meta: RequestMeta) {
    const settings = await this.settings.getAll(tx);
    const policy = await tx.employeePayPolicy.findFirst({
      where: { employeeId, effectiveFrom: { lte: workDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: workDate } }] },
      orderBy: { effectiveFrom: 'desc' },
    });
    const frequency = policy?.payrollFrequency ?? 'MONTHLY';
    const existing = await tx.payrollEntry.findFirst({
      where: { employeeId, periodStart: { lte: workDate }, periodEnd: { gte: workDate } }, include: { period: true },
    });
    let period = existing?.period;
    if (!period && create) {
      period = await tx.payrollPeriod.findFirst({
        where: { frequency, status: { not: 'CLOSED' }, startDate: { lte: workDate }, endDate: { gte: workDate } },
        orderBy: [{ startDate: 'desc' }, { endDate: 'asc' }, { id: 'asc' }],
      }) ?? undefined;
      if (!period) {
        const bounds = resolvePayrollPeriod(frequency, iso(workDate), settings['general.weekStartsOn']);
        const startDate = parseDateOnly(bounds.start)!;
        const endDate = parseDateOnly(bounds.end)!;
        period = await tx.payrollPeriod.upsert({
          where: { frequency_startDate_endDate: { frequency, startDate, endDate } }, update: {},
          create: { frequency, startDate, endDate, label: bounds.label, createdById: actor.user.id },
        });
      }
    }
    if (!period) return { blockers: [] };
    if (period.status === 'CLOSED') return { blockers: [{ code: 'CLOSED_PERIOD', employeeId,
      message: 'توجد فترة مغلقة تغطي هذا الدوام. راجع تحديث المستحقات غير المصروفة.' }] };
    return this.calculatePeriod(tx, period.id, 'calculate', actor, meta, settings['general.timezone'], employeeId);
  }

  private async calculatePeriod(tx: Tx, id: string, operation: 'calculate' | 'review' | 'approve' | 'close',
    actor: AuthContext | { id: string; username: string }, meta: RequestMeta | undefined, timezone: string, onlyEmployeeId?: string) {
      const period = await this.get(id, tx);
      const allowed = { review: 'DRAFT', approve: 'IN_REVIEW', close: 'READY_FOR_APPROVAL' };
      if (period.status === 'CLOSED' || (operation !== 'calculate' && period.status !== allowed[operation])) {
        throw Errors.conflict('حالة الفترة الحالية لا تسمح بهذا الإجراء');
      }
      if (operation === 'close' || operation === 'approve') await this.lockCalculationInputs(tx);
      const { blockers, calculations } = await this.prepare(tx, period, timezone, undefined, onlyEmployeeId);
      if (operation !== 'calculate' && operation !== 'review' && blockers.length) {
        throw new AppException(ERROR_CODES.CONFLICT, 'عالج موانع اعتماد الفترة أولًا', HttpStatus.CONFLICT, { blockers });
      }

      const previous = new Map(period.entries.filter(entry => !onlyEmployeeId || entry.employeeId === onlyEmployeeId)
        .map((entry) => [entry.employeeId, entry]));
      if (operation === 'close' || operation === 'approve') {
        const changed = previous.size !== calculations.length || calculations.some(({ employeeId, result }) => {
          const entry = previous.get(employeeId);
          return !entry || !entry.netAmount.eq(result.net) ||
            componentSignature(entry.components) !== componentSignature(result.components);
        });
        if (changed) {
          throw new AppException(ERROR_CODES.CONFLICT, 'تغيرت مدخلات الرواتب. أعد الحساب والمراجعة قبل الإغلاق',
            HttpStatus.CONFLICT, { blockers: [{ code: 'STALE_CALCULATION', message: 'تغيرت مدخلات حساب الرواتب بعد المراجعة' }] });
        }
      }

      for (const { employeeId, result, adjustments } of calculations) {
        const old = previous.get(employeeId);
        previous.delete(employeeId);
        const amounts = { grossAmount: result.gross, deductionsAmount: result.deductions, netAmount: result.net };
        const snapshot = operation === 'close'
          ? JSON.parse(JSON.stringify({ version: 1, period: { start: iso(period.startDate), end: iso(period.endDate), frequency: period.frequency },
            employee: old?.employee, ...amounts, days: result.days, components: result.components, warnings: result.warnings })) as Prisma.InputJsonValue
          : undefined;
        const entry = old
          ? await tx.payrollEntry.update({ where: { id: old.id }, data: { ...amounts, snapshot } })
          : await tx.payrollEntry.create({ data: { ...amounts, periodId: id, employeeId, periodStart: period.startDate, periodEnd: period.endDate } });
        if (operation !== 'close') {
          if (!old || componentSignature(old.components) !== componentSignature(result.components)) {
            await tx.payrollEntryComponent.deleteMany({ where: { entryId: entry.id } });
            await tx.payrollEntryComponent.createMany({ data: result.components.map((component) => ({
              ...component, entryId: entry.id, workDate: component.workDate ? parseDateOnly(component.workDate) : null,
            })) });
          }
          // تبقى التسوية محجوزة للمستحق نفسه عند تكرار الحساب.
          for (const adjustment of adjustments.filter((row) => row.status === 'APPROVED')) {
            await tx.payrollAdjustment.update({ where: { id: adjustment.id }, data: { status: 'APPLIED', appliedEntryId: entry.id } });
            await this.audit.log({ action: 'payroll.adjustment.apply', actor, meta, entityType: 'payroll_adjustment',
              entityId: adjustment.id, before: { status: 'APPROVED' }, after: { status: 'APPLIED', appliedEntryId: entry.id } }, tx);
          }
        }
      }
      for (const stale of previous.values()) {
        await tx.payrollAdjustment.updateMany({ where: { appliedEntryId: stale.id }, data: { status: 'APPROVED', appliedEntryId: null } });
        await tx.payrollEntry.delete({ where: { id: stale.id } });
      }
      const actorId = ('user' in actor ? actor.user : actor).id;
      const now = new Date();
      const data: Prisma.PayrollPeriodUncheckedUpdateInput = {
        calculate: period.status === 'READY_FOR_APPROVAL' ? { status: 'IN_REVIEW', approvedAt: null, approvedById: null } : {},
        review: { status: 'IN_REVIEW' },
        approve: { status: 'READY_FOR_APPROVAL', approvedAt: now, approvedById: actorId },
        close: { status: 'CLOSED', closedAt: now, closedById: actorId },
      }[operation] as Prisma.PayrollPeriodUncheckedUpdateInput;
      await tx.payrollPeriod.update({ where: { id }, data });
      if (operation === 'review') {
        await tx.notification.create({ data: { userId: actorId, type: 'PAYROLL_READY_FOR_REVIEW',
          title: 'الرواتب جاهزة للمراجعة', body: period.label, data: { periodId: id } } });
      }
      await this.audit.log({ action: `payroll.period.${operation}`, actor, meta, entityType: 'payroll_period', entityId: id,
        before: { status: period.status }, after: { status: data.status ?? period.status, entries: calculations.length, blockers: blockers.length } }, tx);
      return { ...await this.get(id, tx), blockers };
  }
}
