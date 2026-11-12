import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export const ACTIONS = ['CHECK_IN', 'CHECK_OUT', 'MANUAL', 'CORRECTION'] as const;
export type AttendanceAction = (typeof ACTIONS)[number];

export class AttendanceOperationDto {
  @IsUUID(undefined, { message: 'معرّف العملية غير صالح' })
  operationId!: string;

  @IsUUID(undefined, { message: 'معرّف الجهاز غير صالح' })
  deviceId!: string;

  @IsISO8601({ strict: true }, { message: 'وقت إنشاء العملية غير صالح' })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/, { message: 'وقت إنشاء العملية يحتاج منطقة زمنية' })
  createdAt!: string;

  @IsIn(ACTIONS, { message: 'نوع عملية الدوام غير صالح' })
  action!: AttendanceAction;

  @IsOptional()
  @IsInt({ message: 'الإصدار الأساسي يجب أن يكون عددًا صحيحًا' })
  @Min(1, { message: 'الإصدار الأساسي يجب أن يبدأ من واحد' })
  @Max(2_147_483_646, { message: 'الإصدار الأساسي أكبر من الحد المسموح' })
  baseVersion?: number;

  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف الموظف غير صالح' })
  employeeId?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف سجل الدوام غير صالح' })
  sessionId?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف القسم غير صالح' })
  departmentId?: string;

  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'وقت الحضور غير صالح' })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/, { message: 'وقت الحضور يحتاج منطقة زمنية' })
  checkInAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'وقت الانصراف غير صالح' })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/, { message: 'وقت الانصراف يحتاج منطقة زمنية' })
  checkOutAt?: string;

  @IsOptional()
  @IsString({ message: 'أدخل سبب التصحيح كنص' })
  @MaxLength(255, { message: 'سبب التصحيح يتجاوز 255 حرفًا' })
  reason?: string;
}

export class AttendanceBatchDto {
  @IsUUID(undefined, { message: 'معرّف الحساب غير صالح' })
  userId!: string;

  @IsArray({ message: 'أرسل العمليات في قائمة' })
  @ArrayMinSize(1, { message: 'الدفعة لا تحتوي أي عمليات' })
  @ArrayMaxSize(25, { message: 'الدفعة تقبل 25 عملية كحد أقصى' })
  @ValidateNested({ each: true, message: 'بيانات عملية الدوام غير صالحة' })
  @Type(() => AttendanceOperationDto)
  operations!: AttendanceOperationDto[];
}
