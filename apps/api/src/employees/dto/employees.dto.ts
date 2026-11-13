import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ToDateOnly } from '../../common/utils/dates';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : trim({ value }));

const DATE_MESSAGE = 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD';
const PHONE_REGEX = /^[0-9+\-\s()]{6,20}$/;
export const PAY_TYPES = ['HOURLY', 'DAILY', 'MONTHLY'] as const;
export const PAYROLL_FREQUENCIES = ['WEEKLY', 'SEMI_MONTHLY', 'MONTHLY'] as const;
export const DAILY_PAY_MODES = ['FULL', 'PROPORTIONAL'] as const;
export const ABSENCE_METHODS = ['ACTUAL_MONTH_DAYS', 'FIXED_DAYS', 'SCHEDULED_WORK_DAYS'] as const;

/** نوع الأجر وقيمته بتاريخ سريان (للأدمن فقط). */
export class PayRateDto {
  @IsIn(PAY_TYPES)
  payType: (typeof PAY_TYPES)[number];

  /** القيمة بعملة النظام: سعر الساعة أو أجر اليوم أو الراتب الشهري */
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'قيمة الأجر رقم بخانتين عشريتين على الأكثر' })
  @Min(0.01, { message: 'قيمة الأجر يجب أن تكون أكبر من صفر' })
  @Max(9_999_999)
  amount: number;

  /** تاريخ بداية السريان (افتراضيًا اليوم) */
  @IsOptional()
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  effectiveFrom?: Date;
}

/** سياسة احتساب الأجر بتاريخ سريان (للأدمن فقط). */
export class PayPolicyDto {
  @IsIn(PAYROLL_FREQUENCIES)
  payrollFrequency: (typeof PAYROLL_FREQUENCIES)[number];

  /** للأجر اليومي: كامل أو نسبي */
  @IsOptional()
  @IsIn(DAILY_PAY_MODES)
  dailyPayMode?: (typeof DAILY_PAY_MODES)[number];

  /** ساعات اليوم المرجعية (إلزامية للأجر اليومي النسبي — لا تُفترض 8 ساعات) */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.25)
  @Max(24)
  referenceDailyHours?: number;

  /** للأجر الشهري: طريقة خصم الغياب غير المدفوع */
  @IsOptional()
  @IsIn(ABSENCE_METHODS)
  absenceDeductionMethod?: (typeof ABSENCE_METHODS)[number];

  /** عدد الأيام الثابت (إلزامي مع FIXED_DAYS) */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  fixedMonthDays?: number;

  @IsOptional()
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  effectiveFrom?: Date;
}

export class CreateEmployeeDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName: string;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(PHONE_REGEX, { message: 'رقم الهاتف غير صالح' })
  phone?: string | null;

  @IsUUID()
  departmentId: string;

  /** الأجر الابتدائي — يحدده الأدمن فقط (إلزامي للأدمن، ممنوع على المراقب) */
  @IsOptional()
  @ValidateNested()
  @Type(() => PayRateDto)
  pay?: PayRateDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PayPolicyDto)
  policy?: PayPolicyDto;
}

export class UpdateEmployeeDto {
  /** رقم إصدار السجل الذي بُني عليه التعديل (لاكتشاف التعديل المتزامن) */
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(PHONE_REGEX, { message: 'رقم الهاتف غير صالح' })
  phone?: string | null;
}

export class TransferEmployeeDto {
  @IsUUID()
  departmentId: string;

  /** تاريخ الانتقال (افتراضيًا اليوم، ولا يكون في المستقبل) */
  @IsOptional()
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  effectiveFrom?: Date;
}

export class DeactivateEmployeeDto {
  /** تاريخ إنهاء العمل (افتراضيًا اليوم، ولا يكون في المستقبل) */
  @IsOptional()
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  terminationDate?: Date;
}

export class EmployeesQueryDto extends PaginationQueryDto {
  /** بحث في الاسم أو الكود أو الهاتف */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  /** يتطلب صلاحية عرض المعلومات المالية */
  @IsOptional()
  @IsIn(PAY_TYPES)
  payType?: (typeof PAY_TYPES)[number];

  @IsOptional()
  @IsIn(['fullName', 'code', 'createdAt'])
  sortBy: 'fullName' | 'code' | 'createdAt' = 'fullName';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'asc';
}

export class SearchQueryDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q: string;
}

/** تغيير الأجر، مع سياسة الاحتساب عند تغيّر نوع الأجر. */
export class ChangePayRateDto extends PayRateDto {
  @IsOptional()
  @IsBoolean({ message: 'اختر ما إذا كان التغيير يشمل المستحقات غير المصروفة' })
  refreshUnpaidPeriods?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => PayPolicyDto)
  policy?: PayPolicyDto;
}
