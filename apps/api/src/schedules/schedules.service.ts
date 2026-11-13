import { Injectable } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { AuditService } from '../audit/audit.service';
import { assertOpenPayroll, type Db, effectiveOn, formatLocal, resolveInstant, type TimeInput } from '../attendance/attendance-common';
import { localDateOf, MAX_SESSION_MINUTES, minutesBetween, truncateToMinute } from '../attendance/attendance-math';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { addDays, formatDateOnly, todayInZone } from '../common/utils/dates';
import { SettingsService } from '../settings/settings.module';
import { type PlannedShift, readWeeklyPattern, resolvePlannedShifts, validateWeeklyPattern, type WeeklyPatternEntry } from './schedule-math';

export type ScheduleKind = 'FLEXIBLE' | 'FIXED' | 'VARIABLE';

export interface CreateScheduleInput {
  employeeId: string;
  name?: string | null;
  kind: ScheduleKind;
  weeklyPattern?: WeeklyPatternEntry[];
  effectiveFrom?: Date;
}

export interface CreateShiftInput {
  employeeId: string;
  departmentId?: string | null;
  startAt: TimeInput;
  endAt: TimeInput;
}

/** أقصى مدى لاستعلامات الورديات المجدولة/الفائتة (يوم). */
const MAX_RANGE_DAYS = 92;

/** نوع الجدول يُشتق من حقليه: مرن، أو ثابت بنمط أسبوعي، أو متغير بورديات مؤرخة. */
export function scheduleKind(schedule: { isFlexible: boolean; weeklyPattern: unknown }): ScheduleKind {
  if (schedule.isFlexible) return 'FLEXIBLE';
  return readWeeklyPattern(schedule.weeklyPattern).length > 0 ? 'FIXED' : 'VARIABLE';
}

/**
 * جداول العمل. إدارتها للأدمن فقط، فكل جدول محفوظ يُعدّ «معتمدًا»:
 * التأخير والانصراف المبكر يُحسبان فقط مقابل وردية ملزِمة ناتجة عن جدول ثابت أو وردية مؤرخة.
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private async timezone(): Promise<string> {
    return (await this.settings.getAll())['general.timezone'];
  }

  // ───────────────────────────── الالتزامات (للحضور والإضافي والتقارير) ─────────────────────────────

  /** الورديات الملزِمة لكل موظف بين تاريخين محليين (شاملين). الموظف بلا التزام لا يظهر في الخريطة. */
  async plannedFor(employeeIds: string[], from: Date, to: Date, timezone: string, db: Db = this.prisma): Promise<Map<string, PlannedShift[]>> {
    const result = new Map<string, PlannedShift[]>();
    const ids = [...new Set(employeeIds)];
    if (ids.length === 0 || from > to) return result;
    const [schedules, shifts] = await Promise.all([
      db.employeeSchedule.findMany({
        where: { employeeId: { in: ids }, effectiveFrom: { lte: to }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] },
      }),
      db.scheduleShift.findMany({
        // هامش يوم من الطرفين لتغطية فرق المنطقة الزمنية؛ التصفية الدقيقة بالتاريخ المحلي لاحقًا
        where: { employeeId: { in: ids }, startAt: { gte: addDays(from, -1), lt: addDays(to, 2) } },
      }),
    ]);
    for (const id of ids) {
      const planned = resolvePlannedShifts(
        schedules.filter((s) => s.employeeId === id),
        shifts.filter((s) => s.employeeId === id),
        from,
        to,
        timezone,
      );
      if (planned.length > 0) result.set(id, planned);
    }
    return result;
  }

  // ───────────────────────────── القراءة ─────────────────────────────

  async list(employeeId: string) {
    await this.findEmployee(employeeId);
    const rows = await this.prisma.employeeSchedule.findMany({
      where: { employeeId },
      orderBy: { effectiveFrom: 'desc' },
      include: { createdBy: { select: { username: true } } },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      kind: scheduleKind(s),
      weeklyPattern: readWeeklyPattern(s.weeklyPattern),
      effectiveFrom: formatDateOnly(s.effectiveFrom),
      effectiveTo: s.effectiveTo ? formatDateOnly(s.effectiveTo) : null,
      createdBy: s.createdBy.username,
      createdAt: s.createdAt,
    }));
  }

  /** الورديات الملزِمة لموظف بين تاريخين (مؤرخة + الناتجة عن النمط الأسبوعي). */
  async planned(employeeId: string, from: Date, to: Date) {
    this.assertRange(from, to);
    await this.findEmployee(employeeId);
    const timezone = await this.timezone();
    const planned = (await this.plannedFor([employeeId], from, to, timezone)).get(employeeId) ?? [];
    const departments = await this.departmentNames(planned.map((p) => p.departmentId));
    return planned.map((p) => this.plannedView(p, departments));
  }

  /**
   * ورديات ملزِمة انتهى وقتها دون أي حضور ودون إجازة مسجلة.
   * هذه القائمة ترصد الورديات المنتهية التي تحتاج مراجعة.
   * الموظف المرن لا يظهر هنا إلا إن كانت له وردية مؤرخة صريحة.
   */
  async missed(from: Date, to: Date, employeeId?: string, now = new Date()) {
    this.assertRange(from, to);
    const timezone = await this.timezone();
    const employees = await this.prisma.employee.findMany({
      where: employeeId ? { id: employeeId } : { OR: [{ status: 'ACTIVE' }, { terminationDate: { gte: from } }] },
      select: { id: true, code: true, fullName: true, status: true, terminationDate: true, department: { select: { id: true, name: true } } },
    });
    if (employees.length === 0) return [];
    const ids = employees.map((e) => e.id);
    const plannedByEmployee = await this.plannedFor(ids, from, to, timezone);
    if (plannedByEmployee.size === 0) return [];

    const [sessions, leaves] = await Promise.all([
      this.prisma.workSession.findMany({
        where: { employeeId: { in: [...plannedByEmployee.keys()] }, status: { not: 'VOIDED' }, checkInAt: { gte: addDays(from, -2), lt: addDays(to, 3) } },
        select: { employeeId: true, checkInAt: true, checkOutAt: true },
      }),
      this.prisma.leaveRecord.findMany({
        where: {
          employeeId: { in: [...plannedByEmployee.keys()] },
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: to },
          endDate: { gte: from },
        },
        select: { employeeId: true, startDate: true, endDate: true },
      }),
    ]);
    const departments = await this.departmentNames([...plannedByEmployee.values()].flat().map((p) => p.departmentId));

    const result = [];
    for (const employee of employees) {
      for (const shift of plannedByEmployee.get(employee.id) ?? []) {
        if (shift.endAt > now) continue;
        if (employee.terminationDate && shift.date > employee.terminationDate) continue;
        const attended = sessions.some(
          (s) =>
            s.employeeId === employee.id &&
            s.checkInAt.getTime() < shift.endAt.getTime() &&
            (s.checkOutAt === null || s.checkOutAt.getTime() > shift.startAt.getTime()),
        );
        if (attended) continue;
        const onLeave = leaves.some((l) => l.employeeId === employee.id && l.startDate <= shift.date && l.endDate >= shift.date);
        if (onLeave) continue;
        result.push({
          employee: { id: employee.id, code: employee.code, fullName: employee.fullName, department: employee.department },
          ...this.plannedView(shift, departments),
        });
      }
    }
    return result.sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  }

  async listShifts(employeeId: string, from: Date, to: Date) {
    this.assertRange(from, to);
    await this.findEmployee(employeeId);
    const timezone = await this.timezone();
    const rows = await this.prisma.scheduleShift.findMany({
      where: { employeeId, startAt: { gte: addDays(from, -1), lt: addDays(to, 2) } },
      orderBy: { startAt: 'asc' },
      include: { department: { select: { id: true, name: true } } },
    });
    return rows
      .map((s) => ({ ...s, date: localDateOf(s.startAt, timezone) }))
      .filter((s) => s.date >= from && s.date <= to)
      .map((s) => ({
        id: s.id,
        date: formatDateOnly(s.date),
        startAt: s.startAt,
        endAt: s.endAt,
        plannedMinutes: minutesBetween(s.startAt, s.endAt),
        department: s.department,
      }));
  }

  // ───────────────────────────── الكتابة (للأدمن) ─────────────────────────────

  /**
   * جدول جديد بتاريخ سريان: يُغلق الجدول المفتوح في اليوم السابق ويبدأ الجديد.
   * التاريخ نفسه يُعدّ تصحيحًا للجدول في مكانه، والتاريخ الأقدم من آخر جدول مرفوض.
   */
  async create(input: CreateScheduleInput, actor: AuthContext, meta: RequestMeta) {
    const employee = await this.findEmployee(input.employeeId);
    const timezone = await this.timezone();
    const effectiveFrom = input.effectiveFrom ?? todayInZone(timezone);
    await assertOpenPayroll(this.prisma, employee.id, effectiveFrom);

    let weeklyPattern: WeeklyPatternEntry[] | null = null;
    if (input.kind === 'FIXED') {
      const pattern = (input.weeklyPattern ?? []).map((e) => ({ day: e.day, start: e.start, end: e.end }));
      const problem = validateWeeklyPattern(pattern);
      if (problem) throw Errors.validation(problem);
      weeklyPattern = pattern;
    } else if (input.weeklyPattern && input.weeklyPattern.length > 0) {
      throw Errors.validation('النمط الأسبوعي يُحدَّد للجدول الثابت فقط');
    }
    const data = {
      name: input.name?.trim() || null,
      isFlexible: input.kind === 'FLEXIBLE',
      weeklyPattern: weeklyPattern === null ? Prisma.DbNull : (weeklyPattern as unknown as Prisma.InputJsonValue),
    };

    await this.prisma.$transaction(async (tx) => {
      const latest = await tx.employeeSchedule.findFirst({ where: { employeeId: employee.id }, orderBy: { effectiveFrom: 'desc' } });
      if (latest && effectiveFrom < latest.effectiveFrom) {
        throw Errors.conflict(`تاريخ السريان يجب ألا يسبق آخر جدول مسجّل (${formatDateOnly(latest.effectiveFrom)})`);
      }
      if (latest && effectiveFrom.getTime() === latest.effectiveFrom.getTime()) {
        await tx.employeeSchedule.update({ where: { id: latest.id }, data: { ...data, effectiveTo: null } });
      } else {
        if (latest && (latest.effectiveTo === null || latest.effectiveTo >= effectiveFrom)) {
          await tx.employeeSchedule.update({ where: { id: latest.id }, data: { effectiveTo: addDays(effectiveFrom, -1) } });
        }
        await tx.employeeSchedule.create({ data: { ...data, employeeId: employee.id, effectiveFrom, createdById: actor.user.id } });
      }
      await this.audit.log(
        {
          action: 'employee.schedule_changed',
          actor,
          entityType: 'employee',
          entityId: employee.id,
          before: latest ? { kind: scheduleKind(latest), effectiveFrom: formatDateOnly(latest.effectiveFrom) } : null,
          after: { kind: input.kind, name: data.name, weeklyPattern, effectiveFrom: formatDateOnly(effectiveFrom) },
          meta,
        },
        tx,
      );
    });
    return this.list(employee.id);
  }

  /** إنهاء الجدول الساري في تاريخ محدد (يعود الموظف بعده بلا جدول). */
  async end(id: string, effectiveTo: Date, actor: AuthContext, meta: RequestMeta) {
    const schedule = await this.prisma.employeeSchedule.findUnique({ where: { id } });
    if (!schedule) throw Errors.notFound('الجدول غير موجود');
    if (schedule.effectiveTo !== null) throw Errors.conflict('هذا الجدول منتهٍ مسبقًا');
    if (effectiveTo < schedule.effectiveFrom) throw Errors.validation('تاريخ الانتهاء لا يسبق تاريخ بداية الجدول');
    await assertOpenPayroll(this.prisma, schedule.employeeId, addDays(effectiveTo, 1));
    await this.prisma.$transaction(async (tx) => {
      await tx.employeeSchedule.update({ where: { id }, data: { effectiveTo } });
      await this.audit.log(
        {
          action: 'employee.schedule_ended',
          actor,
          entityType: 'employee',
          entityId: schedule.employeeId,
          before: { effectiveTo: null },
          after: { effectiveTo: formatDateOnly(effectiveTo), effectiveFrom: formatDateOnly(schedule.effectiveFrom) },
          meta,
        },
        tx,
      );
    });
    return this.list(schedule.employeeId);
  }

  /** وردية مجدولة بتاريخ محدد (للجدول المتغير، أو لالتزام استثنائي، أو للعمل في قسم آخر). */
  async createShift(input: CreateShiftInput, actor: AuthContext, meta: RequestMeta) {
    const employee = await this.findEmployee(input.employeeId);
    const timezone = await this.timezone();
    const startAt = truncateToMinute(resolveInstant(input.startAt, timezone, 'وقت بداية الوردية'));
    const endAt = truncateToMinute(resolveInstant(input.endAt, timezone, 'وقت نهاية الوردية'));
    if (endAt <= startAt) throw Errors.validation('نهاية الوردية يجب أن تكون بعد بدايتها');
    if (minutesBetween(startAt, endAt) > MAX_SESSION_MINUTES) throw Errors.validation('مدة الوردية لا تتجاوز 24 ساعة');
    const date = localDateOf(startAt, timezone);
    await assertOpenPayroll(this.prisma, employee.id, date);

    if (input.departmentId) {
      const department = await this.prisma.department.findUnique({ where: { id: input.departmentId } });
      if (!department) throw Errors.validation('القسم غير موجود');
      if (!department.isActive) throw Errors.validation('القسم معطّل');
    }
    const overlapping = await this.prisma.scheduleShift.findFirst({
      where: { employeeId: employee.id, startAt: { lt: endAt }, endAt: { gt: startAt } },
    });
    if (overlapping) {
      throw Errors.conflict(
        `تتداخل مع وردية مجدولة للموظف (${formatLocal(overlapping.startAt, timezone)} — ${formatLocal(overlapping.endAt, timezone)})`,
      );
    }
    const schedule = await this.prisma.employeeSchedule.findFirst({ where: { employeeId: employee.id, ...effectiveOn(date) } });

    const id = await this.prisma.$transaction(async (tx) => {
      const shift = await tx.scheduleShift.create({
        data: { employeeId: employee.id, scheduleId: schedule?.id ?? null, departmentId: input.departmentId ?? null, startAt, endAt },
      });
      await this.audit.log(
        {
          action: 'employee.schedule_shift_added',
          actor,
          entityType: 'employee',
          entityId: employee.id,
          after: { startAt: formatLocal(startAt, timezone), endAt: formatLocal(endAt, timezone), departmentId: input.departmentId ?? null },
          meta,
        },
        tx,
      );
      return shift.id;
    });
    const created = await this.prisma.scheduleShift.findUniqueOrThrow({ where: { id }, include: { department: { select: { id: true, name: true } } } });
    return {
      id: created.id,
      date: formatDateOnly(date),
      startAt: created.startAt,
      endAt: created.endAt,
      plannedMinutes: minutesBetween(created.startAt, created.endAt),
      department: created.department,
    };
  }

  async deleteShift(id: string, actor: AuthContext, meta: RequestMeta) {
    const shift = await this.prisma.scheduleShift.findUnique({ where: { id } });
    if (!shift) throw Errors.notFound('الوردية المجدولة غير موجودة');
    const timezone = await this.timezone();
    await assertOpenPayroll(this.prisma, shift.employeeId, localDateOf(shift.startAt, timezone));
    await this.prisma.$transaction(async (tx) => {
      await tx.scheduleShift.delete({ where: { id } });
      await this.audit.log(
        {
          action: 'employee.schedule_shift_removed',
          actor,
          entityType: 'employee',
          entityId: shift.employeeId,
          before: { startAt: formatLocal(shift.startAt, timezone), endAt: formatLocal(shift.endAt, timezone) },
          meta,
        },
        tx,
      );
    });
    return { ok: true };
  }

  // ───────────────────────────── أدوات ─────────────────────────────

  private plannedView(shift: PlannedShift, departments: Map<string, string>) {
    return {
      id: shift.id,
      origin: shift.origin,
      date: formatDateOnly(shift.date),
      startAt: shift.startAt,
      endAt: shift.endAt,
      plannedMinutes: minutesBetween(shift.startAt, shift.endAt),
      department: shift.departmentId ? { id: shift.departmentId, name: departments.get(shift.departmentId) ?? '' } : null,
    };
  }

  private async departmentNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.department.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(rows.map((d) => [d.id, d.name]));
  }

  private assertRange(from: Date, to: Date): void {
    if (to < from) throw Errors.validation('تاريخ النهاية يجب ألا يسبق تاريخ البداية');
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw Errors.validation(`المدى الأقصى ${MAX_RANGE_DAYS} يومًا`);
  }

  private async findEmployee(id: string) {
    const employee = await this.prisma.employee.findUnique({ where: { id } });
    if (!employee) throw Errors.notFound('الموظف غير موجود');
    return employee;
  }
}
