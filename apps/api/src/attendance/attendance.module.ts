import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDate, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { Auth, Meta, RequireAnyPermission, RequirePermissions } from '../common/auth/decorators';
import { PaginationQueryDto, toSkipTake } from '../common/dto/pagination.dto';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { ToDateOnly } from '../common/utils/dates';
import { NotificationsModule } from '../notifications/notifications.module';
import { OvertimeModule } from '../overtime/overtime.module';
import { INSTANT_REGEX, SchedulesModule } from '../schedules/schedules.module';
import { SettingsModule } from '../settings/settings.module';
import { AttendanceService } from './attendance.service';

class OperationDto {
  @IsOptional() @Matches(/^[A-Za-z0-9_-]{1,64}$/) clientOperationId?: string;
  @IsOptional() @IsInt({ message: 'أدخل عددًا صحيحًا' }) @Min(1, { message: 'القيمة خارج الحد المسموح' }) baseVersion?: number;
}
class EmployeeDto extends OperationDto {
  @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) employeeId: string;
}
class CheckInDto extends EmployeeDto {
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) departmentId?: string;
}
class CheckOutDto extends EmployeeDto {
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) sessionId?: string;
}
class ManualDto extends CheckInDto {
  @Matches(INSTANT_REGEX, { message: 'أدخل وقتًا صالحًا بصيغة YYYY-MM-DDTHH:mm' }) checkInAt: string;
  @IsOptional() @Matches(INSTANT_REGEX, { message: 'أدخل وقتًا صالحًا بصيغة YYYY-MM-DDTHH:mm' }) checkOutAt?: string;
}
class CorrectionDto extends OperationDto {
  @IsOptional() @IsInt({ message: 'أدخل عددًا صحيحًا' }) @Min(1, { message: 'القيمة خارج الحد المسموح' }) version?: number;
  @IsOptional() @Matches(INSTANT_REGEX, { message: 'أدخل وقتًا صالحًا بصيغة YYYY-MM-DDTHH:mm' }) checkInAt?: string;
  @IsOptional() @Matches(INSTANT_REGEX, { message: 'أدخل وقتًا صالحًا بصيغة YYYY-MM-DDTHH:mm' }) checkOutAt?: string;
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) departmentId?: string;
  @IsString({ message: 'القيمة النصية غير صالحة' }) @MaxLength(255, { message: 'القيمة خارج الحد المسموح' }) reason: string;
}
class VersionDto {
  @IsInt({ message: 'أدخل عددًا صحيحًا' }) @Min(1, { message: 'القيمة خارج الحد المسموح' }) version: number;
}
class TransitionDto extends VersionDto {
  @IsOptional() @IsString({ message: 'القيمة النصية غير صالحة' }) @MaxLength(255, { message: 'القيمة خارج الحد المسموح' }) reason?: string;
}
class BreakDto extends VersionDto {
  @IsBoolean({ message: 'اختر نعم أو لا' }) isPaid: boolean;
}
class BulkTransitionDto {
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) employeeId?: string;
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) departmentId?: string;
  @IsOptional() @ToDateOnly() @IsDate({ message: 'أدخل تاريخًا صالحًا بصيغة YYYY-MM-DD' }) from?: Date;
  @IsOptional() @ToDateOnly() @IsDate({ message: 'أدخل تاريخًا صالحًا بصيغة YYYY-MM-DD' }) to?: Date;
}

class ListDto extends PaginationQueryDto {
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) employeeId?: string;
  @IsOptional() @IsUUID(undefined, { message: 'معرّف السجل غير صالح' }) departmentId?: string;
  @IsOptional() @ToDateOnly() @IsDate({ message: 'أدخل تاريخًا صالحًا بصيغة YYYY-MM-DD' }) from?: Date;
  @IsOptional() @ToDateOnly() @IsDate({ message: 'أدخل تاريخًا صالحًا بصيغة YYYY-MM-DD' }) to?: Date;
  @IsOptional() @IsIn(['OPEN', 'CLOSED', 'VOIDED'], { message: 'القيمة المختارة غير صالحة' }) status?: 'OPEN' | 'CLOSED' | 'VOIDED';
  @IsOptional() @IsIn(['DRAFT', 'IN_REVIEW', 'APPROVED'], { message: 'القيمة المختارة غير صالحة' }) approvalStatus?: 'DRAFT' | 'IN_REVIEW' | 'APPROVED';
}

@ApiTags('attendance')
@ApiCookieAuth()
@Controller('attendance')
class AttendanceController {
  constructor(private readonly service: AttendanceService, private readonly db: PrismaService) {}

  @Get()
  @RequirePermissions('attendance.view')
  list(@Query() dto: ListDto) {
    if (dto.from && dto.to && dto.from > dto.to) throw Errors.validation('تاريخ النهاية يسبق البداية');
    const { skip, take } = toSkipTake(dto);
    return this.service.list({ employeeId: dto.employeeId, departmentId: dto.departmentId, status: dto.status ?? { not: 'VOIDED' },
      approvalStatus: dto.approvalStatus, workDate: { gte: dto.from, lte: dto.to } }, skip, take);
  }

  @Get('employees')
  @RequireAnyPermission('attendance.view', 'attendance.check_in', 'attendance.check_out', 'attendance.correct', 'leaves.record', 'leaves.view')
  employees() {
    return this.db.employee.findMany({ orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, code: true, status: true, departmentId: true } });
  }

  @Get('open')
  @RequireAnyPermission('attendance.view', 'attendance.check_in', 'attendance.check_out')
  open(@Query() dto: PaginationQueryDto) {
    const { skip, take } = toSkipTake(dto);
    return this.service.list({ status: 'OPEN', employee: { status: 'ACTIVE' } }, skip, take);
  }

  @Get(':id/corrections')
  @RequirePermissions('attendance.view')
  history(@Param('id', ParseUUIDPipe) id: string) { return this.service.history(id); }

  @Post('check-in')
  @RequirePermissions('attendance.check_in')
  checkIn(@Body() dto: CheckInDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.checkIn(dto, actor, meta);
  }

  @Post('check-out')
  @RequirePermissions('attendance.check_out')
  checkOut(@Body() dto: CheckOutDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.checkOut(dto, actor, meta);
  }

  @Post('manual')
  @RequirePermissions('attendance.correct')
  manual(@Body() dto: ManualDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.manual(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('attendance.correct')
  correct(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectionDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    if (!dto.version && !dto.baseVersion) throw Errors.validation('رقم إصدار السجل مطلوب');
    return this.service.correct(id, dto, actor, meta);
  }

  @Post('bulk/review')
  @RequirePermissions('attendance.correct')
  bulkReview(@Body() dto: BulkTransitionDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.bulkTransition('review', dto, actor, meta);
  }

  @Post('bulk/approve')
  bulkApprove(@Body() dto: BulkTransitionDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.bulkTransition('approve', dto, actor, meta);
  }

  @Post(':id/review')
  @RequirePermissions('attendance.correct')
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.transition(id, 'review', dto.version, actor, meta, dto.reason);
  }

  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.transition(id, 'approve', dto.version, actor, meta, dto.reason);
  }

  @Post(':id/void')
  voidSession(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.transition(id, 'void', dto.version, actor, meta, dto.reason);
  }

  @Post(':id/breaks/start')
  @RequirePermissions('attendance.check_in')
  breakStart(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BreakDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.recordBreak(id, true, dto.version, actor, meta, dto.isPaid);
  }

  @Post(':id/breaks/end')
  @RequirePermissions('attendance.check_out')
  breakEnd(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.service.recordBreak(id, false, dto.version, actor, meta);
  }
}

@Module({ imports: [SettingsModule, SchedulesModule, OvertimeModule, NotificationsModule],
  controllers: [AttendanceController], providers: [AttendanceService], exports: [AttendanceService] })
export class AttendanceModule { }
export { AttendanceService } from './attendance.service';
