import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsBoolean, IsDate, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { assertOpenPayroll, lockEmployee, type Db } from '../attendance/attendance-common';
import { dayBoundary } from '../attendance/attendance.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { Auth, Meta, RequirePermissions } from '../common/auth/decorators';
import { PaginationQueryDto, toSkipTake } from '../common/dto/pagination.dto';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { addDays, ToDateOnly } from '../common/utils/dates';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsModule, SettingsService } from '../settings/settings.module';

const types = ['PAID_LEAVE', 'UNPAID_LEAVE', 'PAID_EXCUSED_ABSENCE', 'UNPAID_ABSENCE'] as const;
const statuses = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
class LeaveDto {
  @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) employeeId: string;
  @IsIn(types, { message: 'القيمة المختارة غير صالحة' }) type: typeof types[number];
  @ToDateOnly() @IsDate({ message: 'أدخل تاريخًا صالحًا بصيغة YYYY-MM-DD' }) startDate: Date;
  @ToDateOnly() @IsDate({ message: 'أدخل تاريخًا صالحًا بصيغة YYYY-MM-DD' }) endDate: Date;
  @IsOptional() @IsString({ message: 'القيمة النصية غير صالحة' }) @MaxLength(255, { message: 'القيمة خارج الحد المسموح' }) reason?: string;
  @IsBoolean({ message: 'اختر نعم أو لا' }) affectsPay: boolean;
}
class LeaveQuery extends PaginationQueryDto {
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) employeeId?: string;
  @IsOptional() @IsIn(statuses, { message: 'القيمة المختارة غير صالحة' }) status?: typeof statuses[number];
}
class DecisionDto {
  @IsIn(['APPROVED', 'REJECTED', 'CANCELLED'], { message: 'القيمة المختارة غير صالحة' }) status: 'APPROVED' | 'REJECTED' | 'CANCELLED';
}

@Injectable()
class LeavesService {
  constructor(private readonly db: PrismaService, private readonly audit: AuditService,
    private readonly settings: SettingsService, private readonly notifications: NotificationsService) {}

  async list(dto: LeaveQuery) {
    const where = { employeeId: dto.employeeId, status: dto.status };
    const { skip, take } = toSkipTake(dto);
    const [items, total] = await Promise.all([
      this.db.leaveRecord.findMany({ where, skip, take, orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
        include: { employee: { select: { fullName: true, code: true } }, recordedBy: { select: { fullName: true } } } }),
      this.db.leaveRecord.count({ where }),
    ]);
    return { items, total };
  }

  async record(dto: LeaveDto, actor: AuthContext, meta: RequestMeta) {
    if (dto.endDate < dto.startDate) throw Errors.validation('تاريخ النهاية يسبق البداية');
    if (dto.affectsPay && dto.type.startsWith('PAID_')) throw Errors.validation('لا يمكن خصم إجازة أو غياب مدفوع من الأجر');
    const row = await this.db.$transaction(async tx => {
      await lockEmployee(tx, dto.employeeId);
      if (!(await tx.employee.findUnique({ where: { id: dto.employeeId } }))) throw Errors.notFound('الموظف غير موجود');
      await assertOpenPayroll(tx, dto.employeeId, dto.startDate, dto.endDate);
      await this.assertNoAttendance(tx, dto);
      const overlap = await tx.leaveRecord.findFirst({ where: { employeeId: dto.employeeId, status: { in: ['APPROVED', 'PENDING'] },
        startDate: { lte: dto.endDate }, endDate: { gte: dto.startDate } } });
      if (overlap) throw Errors.conflict('تتداخل الفترة مع إجازة أو غياب مسجل');
      const after = await tx.leaveRecord.create({ data: { ...dto, recordedById: actor.user.id } });
      await this.audit.log({ action: 'leave.recorded', entityType: 'leave_record', entityId: after.id, actor, meta, after }, tx);
      return after;
    });
    await this.notifications.notifyAdmin({ type: 'LEAVE_PENDING', title: 'إجازة أو غياب بانتظار الاعتماد',
      body: 'يوجد طلب إجازة أو غياب يحتاج إلى مراجعة', data: { leaveId: row.id } });
    return row;
  }

  async decide(id: string, status: DecisionDto['status'], actor: AuthContext, meta: RequestMeta) {
    return this.db.$transaction(async tx => {
      const initial = await tx.leaveRecord.findUnique({ where: { id } });
      if (!initial) throw Errors.notFound('سجل الإجازة أو الغياب غير موجود');
      await lockEmployee(tx, initial.employeeId);
      const before = await tx.leaveRecord.findUniqueOrThrow({ where: { id } });
      if (before.status !== 'PENDING' && !(before.status === 'APPROVED' && status === 'CANCELLED')) {
        throw Errors.conflict('حالة السجل لا تسمح بهذه العملية');
      }
      await assertOpenPayroll(tx, before.employeeId, before.startDate, before.endDate);
      if (status === 'APPROVED') await this.assertNoAttendance(tx, before);
      const after = await tx.leaveRecord.update({ where: { id }, data: { status, decidedById: actor.user.id, decidedAt: new Date() } });
      await this.audit.log({ action: 'leave.transition', entityType: 'leave_record', entityId: id, actor, meta, before, after }, tx);
      return after;
    });
  }

  private async assertNoAttendance(tx: Db, row: { employeeId: string; startDate: Date; endDate: Date }) {
    const zone = (await this.settings.getAll())['general.timezone'];
    const start = dayBoundary(row.startDate, zone);
    const end = dayBoundary(addDays(row.endDate, 1), zone);
    const overlap = await tx.workSession.findFirst({ where: { employeeId: row.employeeId,
      status: { not: 'VOIDED' }, checkInAt: { lt: end },
      OR: [{ checkOutAt: { gt: start } }, ...(start <= new Date() ? [{ checkOutAt: null }] : [])] } });
    if (overlap) throw Errors.conflict('تتداخل الفترة مع وردية دوام مسجلة للموظف');
  }
}

@Controller('leaves')
class LeavesController {
  constructor(private readonly service: LeavesService) {}

  @Get()
  @RequirePermissions('leaves.view')
  list(@Query() query: LeaveQuery) { return this.service.list(query); }

  @Post()
  @RequirePermissions('leaves.record')
  record(@Body() dto: LeaveDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) { return this.service.record(dto, actor, meta); }

  @Post(':id/decision')
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.decide(id, dto.status, actor, meta);
  }
}

@Module({ imports: [SettingsModule, NotificationsModule], controllers: [LeavesController], providers: [LeavesService] })
export class LeavesModule {}
