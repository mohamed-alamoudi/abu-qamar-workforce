import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { IsDate, IsIn, IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { assertOpenPayroll, effectiveOn, lockEmployee, type Db } from '../attendance/attendance-common';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { Auth, Meta } from '../common/auth/decorators';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { addDays, formatDateOnly, ToDateOnly } from '../common/utils/dates';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsModule, SettingsService } from '../settings/settings.module';
import { computeWeekOvertime, weekStartOf } from './overtime-math';

class DecisionDto {
  @IsIn(['PENDING_APPROVAL', 'APPROVED', 'REJECTED'], { message: 'القيمة المختارة غير صالحة' })
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
}

class PolicyDto {
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) employeeId?: string;
  @ToDateOnly() @IsDate({ message: 'أدخل تاريخًا صالحًا بصيغة YYYY-MM-DD' }) effectiveFrom: Date;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }, { message: 'الرقم أو دقته غير صالحين' }) @Min(0.001, { message: 'القيمة خارج الحد المسموح' }) @Max(99.999, { message: 'القيمة خارج الحد المسموح' }) multiplier?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }, { message: 'الرقم أو دقته غير صالحين' }) @Min(0, { message: 'القيمة خارج الحد المسموح' }) @Max(9999999999.99, { message: 'القيمة خارج الحد المسموح' }) specialHourlyRate?: number;
  @IsOptional() @IsInt({ message: 'أدخل عددًا صحيحًا' }) @Min(1, { message: 'القيمة خارج الحد المسموح' }) @Max(1440, { message: 'القيمة خارج الحد المسموح' }) dailyThresholdMinutes?: number;
  @IsOptional() @IsInt({ message: 'أدخل عددًا صحيحًا' }) @Min(1, { message: 'القيمة خارج الحد المسموح' }) @Max(10080, { message: 'القيمة خارج الحد المسموح' }) weeklyThresholdMinutes?: number;
}

function auditValues<T extends { multiplier: Prisma.Decimal; specialHourlyRate: Prisma.Decimal | null }>(row: T) {
  return { ...row, multiplier: row.multiplier.toString(), specialHourlyRate: row.specialHourlyRate?.toString() ?? null };
}

@Injectable()
export class OvertimeService {
  constructor(private readonly db: PrismaService, private readonly settings: SettingsService,
    private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  list() {
    return this.db.overtimeEntry.findMany({ take: 200, orderBy: { workDate: 'desc' },
      include: { employee: { select: { fullName: true } } } });
  }

  policies() {
    return this.db.overtimePolicy.findMany({ orderBy: { effectiveFrom: 'desc' } });
  }

  async setPolicy(dto: PolicyDto, actor: AuthContext, meta: RequestMeta) {
    const settings = await this.settings.getAll();
    return this.db.$transaction(async tx => {
      const employeeId = dto.employeeId ?? null;
      await lockEmployee(tx, employeeId ?? 'overtime-global');
      if (employeeId && !(await tx.employee.findUnique({ where: { id: employeeId } }))) throw Errors.notFound('الموظف غير موجود');
      const last = await tx.overtimePolicy.findFirst({ where: { employeeId }, orderBy: { effectiveFrom: 'desc' } });
      if (last && last.effectiveFrom >= dto.effectiveFrom) throw Errors.conflict('اختر تاريخًا بعد بداية آخر سياسة');
      if (last && (!last.effectiveTo || last.effectiveTo >= dto.effectiveFrom)) {
        await tx.overtimePolicy.update({ where: { id: last.id }, data: { effectiveTo: addDays(dto.effectiveFrom, -1) } });
      }
      const row = await tx.overtimePolicy.create({ data: { ...dto, employeeId,
        multiplier: dto.multiplier ?? settings['payroll.defaultOvertimeMultiplier'], createdById: actor.user.id } });
      await this.audit.log({ action: 'overtime.policy_created', entityType: 'overtime_policy', entityId: row.id, actor, meta, before: last ? auditValues(last) : undefined, after: auditValues(row) }, tx);
      return row;
    });
  }

  async refresh(tx: Db, employeeId: string, date: Date) {
    const config = await this.settings.getAll();
    const start = weekStartOf(date, config['general.weekStartsOn']);
    const end = addDays(start, 6);
    const sessions = await tx.workSession.findMany({
      where: { employeeId, status: 'CLOSED', workDate: { gte: start, lte: end } },
      orderBy: { checkInAt: 'asc' },
    });
    const entries = await tx.overtimeEntry.findMany({ where: { employeeId, sessionId: { not: null }, OR: [
      { workDate: { gte: start, lte: end } }, { sessionId: { in: sessions.map(session => session.id) } },
    ] } });
    const days = new Map<string, { sessions: typeof sessions; multiplier: Prisma.Decimal; specialHourlyRate: Prisma.Decimal | null;
      dailyThresholdMinutes: number | null; weeklyThresholdMinutes: number | null; date: string; workedMinutes: number }>();
    for (const session of sessions) {
      const key = formatDateOnly(session.workDate);
      let day = days.get(key);
      if (!day) {
        const filter = effectiveOn(session.workDate);
        const policy = await tx.overtimePolicy.findFirst({ where: { employeeId, ...filter } }) ??
          await tx.overtimePolicy.findFirst({ where: { employeeId: null, ...filter } });
        day = { sessions: [], date: key, workedMinutes: 0,
          multiplier: policy?.multiplier ?? new Prisma.Decimal(config['payroll.defaultOvertimeMultiplier']),
          specialHourlyRate: policy?.specialHourlyRate ?? null,
          dailyThresholdMinutes: policy ? policy.dailyThresholdMinutes : null,
          weeklyThresholdMinutes: policy?.weeklyThresholdMinutes ?? null };
        days.set(key, day);
      }
      day.sessions.push(session);
      day.workedMinutes += session.workedMinutes ?? 0;
    }
    const totals = computeWeekOvertime([...days.values()]);
    const desired = new Map<string, { workDate: Date; minutes: number; multiplier: Prisma.Decimal; specialHourlyRate: Prisma.Decimal | null }>();
    for (const day of days.values()) {
      let remaining = totals.get(day.date) ?? 0;
      for (const session of [...day.sessions].reverse()) {
        const minutes = Math.min(remaining, session.workedMinutes ?? 0);
        if (!minutes) continue;
        remaining -= minutes;
        desired.set(session.id, { minutes, workDate: session.workDate, multiplier: day.multiplier, specialHourlyRate: day.specialHourlyRate });
      }
    }
    for (const entry of entries) {
      const next = desired.get(entry.sessionId!);
      desired.delete(entry.sessionId!);
      if (next && (entry.status !== 'REJECTED' || entry.decidedById) && entry.minutes === next.minutes && +entry.workDate === +next.workDate &&
        entry.multiplier.equals(next.multiplier) && String(entry.specialHourlyRate) === String(next.specialHourlyRate)) continue;
      if (await tx.payrollEntry.findFirst({ where: { employeeId, periodStart: { lte: entry.workDate },
        periodEnd: { gte: entry.workDate }, period: { status: 'CLOSED' } } })) continue;
      if (!next) {
        if (entry.status !== 'REJECTED') await tx.overtimeEntry.update({ where: { id: entry.id }, data: { status: 'REJECTED', decidedAt: null, decidedById: null } });
      } else {
        await assertOpenPayroll(tx, employeeId, next.workDate);
        await tx.overtimeEntry.update({ where: { id: entry.id }, data: { ...next, status: 'DETECTED', decidedAt: null, decidedById: null } });
      }
    }
    for (const [sessionId, data] of desired) {
      await assertOpenPayroll(tx, employeeId, data.workDate);
      await tx.overtimeEntry.create({ data: { ...data, employeeId, sessionId } });
    }
  }

  async decide(id: string, status: DecisionDto['status'], actor: AuthContext, meta: RequestMeta) {
    if (actor.user.role !== 'ADMIN') throw Errors.adminOnly();
    const row = await this.db.$transaction(async tx => {
      const initial = await tx.overtimeEntry.findUnique({ where: { id } });
      if (!initial) throw Errors.notFound('سجل الإضافي غير موجود');
      await lockEmployee(tx, initial.employeeId);
      const before = await tx.overtimeEntry.findUniqueOrThrow({ where: { id } });
      await assertOpenPayroll(tx, before.employeeId, before.workDate);
      const expected = status === 'PENDING_APPROVAL' ? 'DETECTED' : 'PENDING_APPROVAL';
      if (before.status !== expected) throw Errors.conflict('حالة سجل الإضافي لا تسمح بهذه العملية');
      if (status === 'APPROVED' && before.sessionId) {
        const session = await tx.workSession.findUnique({ where: { id: before.sessionId } });
        if (session?.status !== 'CLOSED' || session.approvalStatus !== 'APPROVED') throw Errors.conflict('اعتمد سجل الدوام أولًا');
      }
      const after = await tx.overtimeEntry.update({ where: { id }, data: { status,
        decidedById: status === 'PENDING_APPROVAL' ? null : actor.user.id, decidedAt: status === 'PENDING_APPROVAL' ? null : new Date() } });
      await this.audit.log({ action: 'overtime.transition', entityType: 'overtime_entry', entityId: id, actor, meta, before: auditValues(before), after: auditValues(after) }, tx);
      return after;
    });
    if (status === 'PENDING_APPROVAL') await this.notifications.notifyAdmin({ type: 'OVERTIME_PENDING',
      title: 'إضافي بانتظار الاعتماد', body: 'يوجد سجل عمل إضافي يحتاج إلى مراجعة', data: { overtimeId: id } });
    return row;
  }
}

@Controller('overtime')
class OvertimeController {
  constructor(private readonly service: OvertimeService) {}
  @Get() list() { return this.service.list(); }
  @Get('policies') policies() { return this.service.policies(); }
  @Post('policies') policy(@Body() dto: PolicyDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.setPolicy(dto, actor, meta);
  }
  @Post(':id/decision') decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto,
    @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.decide(id, dto.status, actor, meta);
  }
}

@Module({ imports: [SettingsModule, NotificationsModule], controllers: [OvertimeController], providers: [OvertimeService], exports: [OvertimeService] })
export class OvertimeModule {}
