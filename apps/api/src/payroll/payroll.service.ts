import { HttpStatus, Injectable } from '@nestjs/common';
import { PayrollPeriod, Prisma } from '@abu-qamar/database';
import { ERROR_CODES } from '@abu-qamar/shared';
import { minutesBetween } from '../attendance/attendance-math';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { paginate, toSkipTake } from '../common/dto/pagination.dto';
import { AppException, Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { addDays, formatDateOnly, parseDateOnly, todayInZone } from '../common/utils/dates';
import { resolvePlannedShifts } from '../schedules/schedule-math';
import { SettingsService } from '../settings/settings.module';
import { calculateEntry } from './calc/calculator';
import { monthEnd, monthKey, monthStart } from './calc/iso-dates';
import { resolvePayrollPeriod } from './calc/periods';
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
export class PayrollService {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

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
    const settings = await this.settings.getAll();
    const bounds = resolvePayrollPeriod(dto.frequency, iso(dto.date), settings['general.weekStartsOn']);
    return this.db.$transaction(async (tx) => {
      const row = await tx.payrollPeriod.create({ data: {
        frequency: dto.frequency, startDate: parseDateOnly(bounds.start)!, endDate: parseDateOnly(bounds.end)!,
        label: bounds.label, createdById: actor.user.id,
      } });
      await this.audit.log({ action: 'payroll.period.create', actor, meta, entityType: 'payroll_period', entityId: row.id, after: row }, tx);
      return row;
    });
  }

  private async prepare(tx: Tx, period: PayrollPeriod, timezone: string) {
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
          where: { OR: [{ status: 'APPROVED', appliedEntryId: null, OR: [{ targetEntryId: null }, { targetEntry: { periodEnd: { lt: startDate } } }] }, { status: 'APPLIED', appliedEntry: { periodId: id } }] },
          orderBy: { id: 'asc' },
        },
      },
    });

    const blockers: Blocker[] = [];
    const calculations = [];
    for (const employee of employees) {
      const employeeId = employee.id;
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
    if (!calculations.length && !blockers.length) blockers.push({ code: 'NO_ENTRIES', message: 'لا توجد مستحقات قابلة للحساب في الفترة' });
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
      const period = await this.get(id, tx);
      const allowed = { review: 'DRAFT', approve: 'IN_REVIEW', close: 'READY_FOR_APPROVAL' };
      if (period.status === 'CLOSED' || (operation !== 'calculate' && period.status !== allowed[operation])) {
        throw Errors.conflict('حالة الفترة الحالية لا تسمح بهذا الإجراء');
      }
      if (operation === 'close' || operation === 'approve') {
        // نفس مفتاح قفل الموظف في الحضور. ننتظر أي كتابة سبق أن فحصت حالة الفترة.
        const employeeIds = await tx.employee.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
        for (const employee of employeeIds) {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${employee.id}, 0))::text AS locked`;
        }
        // يثبت المدخلات حتى تُكتب النسخة النهائية، بما فيها صفوف قد تُضاف أثناء الإغلاق.
        await tx.$executeRaw`LOCK TABLE work_sessions, overtime_entries, leave_records, pay_rates,
          employee_pay_policies, employee_schedules, schedule_shifts, employees IN SHARE MODE`;
      }
      const { blockers, calculations } = await this.prepare(tx, period, timezone);
      if (operation !== 'calculate' && operation !== 'review' && blockers.length) {
        throw new AppException(ERROR_CODES.CONFLICT, 'عالج موانع اعتماد الفترة أولًا', HttpStatus.CONFLICT, { blockers });
      }

      const previous = new Map(period.entries.map((entry) => [entry.employeeId, entry]));
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
      const now = new Date();
      const data: Prisma.PayrollPeriodUncheckedUpdateInput = {
        calculate: period.status === 'READY_FOR_APPROVAL' ? { status: 'IN_REVIEW', approvedAt: null, approvedById: null } : {},
        review: { status: 'IN_REVIEW' },
        approve: { status: 'READY_FOR_APPROVAL', approvedAt: now, approvedById: actor.user.id },
        close: { status: 'CLOSED', closedAt: now, closedById: actor.user.id },
      }[operation] as Prisma.PayrollPeriodUncheckedUpdateInput;
      await tx.payrollPeriod.update({ where: { id }, data });
      if (operation === 'review') {
        await tx.notification.create({ data: { userId: actor.user.id, type: 'PAYROLL_READY_FOR_REVIEW',
          title: 'الرواتب جاهزة للمراجعة', body: period.label, data: { periodId: id } } });
      }
      await this.audit.log({ action: `payroll.period.${operation}`, actor, meta, entityType: 'payroll_period', entityId: id,
        before: { status: period.status }, after: { status: data.status ?? period.status, entries: calculations.length, blockers: blockers.length } }, tx);
      return { ...await this.get(id, tx), blockers };
    }, { timeout: 30000 });
  }
}
