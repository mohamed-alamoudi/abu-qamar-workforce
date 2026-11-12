import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { AdminOnly, Auth, Meta, RequireAnyPermission } from '../common/auth/decorators';
import { ToDateOnly } from '../common/utils/dates';
import { SettingsModule } from '../settings/settings.module';
import { SchedulesService } from './schedules.service';

const DATE_MESSAGE = 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD';
const TIME_MESSAGE = 'الوقت يجب أن يكون بصيغة HH:mm';
const INSTANT_MESSAGE = 'الوقت يجب أن يكون بصيغة YYYY-MM-DDTHH:mm';
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
/** وقت محلي بلا إزاحة (يُفسَّر بمنطقة النظام) أو ISO بإزاحة صريحة */
export const INSTANT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
export const SCHEDULE_KINDS = ['FLEXIBLE', 'FIXED', 'VARIABLE'] as const;

export class WeeklyPatternEntryDto {
  /** يوم الأسبوع بترقيم JavaScript: 0 = الأحد … 6 = السبت */
  @IsInt({ message: 'أدخل عددًا صحيحًا' })
  @Min(0, { message: 'القيمة خارج الحد المسموح' })
  @Max(6, { message: 'القيمة خارج الحد المسموح' })
  day: number;

  @Matches(TIME_REGEX, { message: TIME_MESSAGE })
  start: string;

  /** نهاية أصغر من أو تساوي البداية = وردية تمتد إلى اليوم التالي */
  @Matches(TIME_REGEX, { message: TIME_MESSAGE })
  end: string;
}

export class CreateScheduleDto {
  @IsUUID(undefined, { message: 'معرّف السجل غير صالح' })
  employeeId: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'القيمة النصية غير صالحة' })
  @MaxLength(100, { message: 'القيمة خارج الحد المسموح' })
  name?: string;

  /** FLEXIBLE = مرن بلا التزام · FIXED = نمط أسبوعي ثابت · VARIABLE = ورديات مؤرخة متغيرة */
  @IsIn(SCHEDULE_KINDS, { message: 'القيمة المختارة غير صالحة' })
  kind: (typeof SCHEDULE_KINDS)[number];

  @IsOptional()
  @IsArray({ message: 'القائمة غير صالحة' })
  @ArrayMaxSize(28, { message: 'القيمة خارج الحد المسموح' })
  @ValidateNested({ each: true })
  @Type(() => WeeklyPatternEntryDto)
  weeklyPattern?: WeeklyPatternEntryDto[];

  /** تاريخ بداية السريان (افتراضيًا اليوم) */
  @IsOptional()
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  effectiveFrom?: Date;
}

export class EndScheduleDto {
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  effectiveTo: Date;
}

export class CreateScheduleShiftDto {
  @IsUUID(undefined, { message: 'معرّف السجل غير صالح' })
  employeeId: string;

  /** القسم الذي يعمل فيه خلال هذه الوردية إن اختلف عن قسمه */
  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف السجل غير صالح' })
  departmentId?: string;

  @Matches(INSTANT_REGEX, { message: INSTANT_MESSAGE })
  startAt: string;

  @Matches(INSTANT_REGEX, { message: INSTANT_MESSAGE })
  endAt: string;
}

export class EmployeeQueryDto {
  @IsUUID(undefined, { message: 'معرّف السجل غير صالح' })
  employeeId: string;
}

export class DateRangeQueryDto {
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  from: Date;

  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  to: Date;

  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف السجل غير صالح' })
  employeeId?: string;
}

export class EmployeeRangeQueryDto {
  @IsUUID(undefined, { message: 'معرّف السجل غير صالح' })
  employeeId: string;

  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  from: Date;

  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  to: Date;
}

@ApiTags('schedules')
@ApiCookieAuth()
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @RequireAnyPermission('attendance.view', 'employees.view')
  @ApiOperation({ summary: 'جداول عمل موظف بتاريخ سريانها' })
  list(@Query() query: EmployeeQueryDto) {
    return this.schedules.list(query.employeeId);
  }

  @Post()
  @AdminOnly()
  @ApiOperation({ summary: 'تحديد جدول عمل (مرن / ثابت أسبوعي / متغير) بتاريخ سريان — للأدمن' })
  create(@Body() dto: CreateScheduleDto, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.schedules.create(dto, auth, meta);
  }

  @Post(':id/end')
  @HttpCode(200)
  @AdminOnly()
  @ApiOperation({ summary: 'إنهاء الجدول الساري في تاريخ محدد — للأدمن' })
  end(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EndScheduleDto, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.schedules.end(id, dto.effectiveTo, auth, meta);
  }

  @Get('planned')
  @RequireAnyPermission('attendance.view', 'employees.view')
  @ApiOperation({ summary: 'الورديات الملزِمة لموظف بين تاريخين (مؤرخة + النمط الأسبوعي)' })
  planned(@Query() query: EmployeeRangeQueryDto) {
    return this.schedules.planned(query.employeeId, query.from, query.to);
  }

  @Get('missed')
  @RequireAnyPermission('attendance.view', 'leaves.view')
  @ApiOperation({ summary: 'ورديات ملزِمة انتهت دون حضور ولا إجازة (للمراجعة — لا يُنشأ غياب تلقائيًا)' })
  missed(@Query() query: DateRangeQueryDto) {
    return this.schedules.missed(query.from, query.to, query.employeeId);
  }

  @Get('shifts')
  @RequireAnyPermission('attendance.view', 'employees.view')
  @ApiOperation({ summary: 'الورديات المؤرخة لموظف بين تاريخين' })
  shifts(@Query() query: EmployeeRangeQueryDto) {
    return this.schedules.listShifts(query.employeeId, query.from, query.to);
  }

  @Post('shifts')
  @AdminOnly()
  @ApiOperation({ summary: 'إضافة وردية مجدولة بتاريخ محدد — للأدمن' })
  createShift(@Body() dto: CreateScheduleShiftDto, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.schedules.createShift(dto, auth, meta);
  }

  @Delete('shifts/:id')
  @AdminOnly()
  @ApiOperation({ summary: 'حذف وردية مجدولة (ليست سجل دوام) — للأدمن' })
  deleteShift(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.schedules.deleteShift(id, auth, meta);
  }
}

@Module({
  imports: [SettingsModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
