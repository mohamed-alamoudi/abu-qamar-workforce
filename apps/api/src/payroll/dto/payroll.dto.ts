import { Transform } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ToDateOnly } from '../../common/utils/dates';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
const DATE_MESSAGE = 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD';

export const PAYROLL_FREQUENCIES = ['WEEKLY', 'SEMI_MONTHLY', 'MONTHLY'] as const;
export const PERIOD_STATUSES = ['DRAFT', 'IN_REVIEW', 'READY_FOR_APPROVAL', 'CLOSED'] as const;
export const ADJUSTMENT_TYPES = ['BONUS', 'DEDUCTION', 'WAGE_DIFFERENCE'] as const;
export const ADJUSTMENT_STATUSES = ['PENDING', 'APPROVED', 'APPLIED', 'CANCELLED'] as const;

export class CreatePeriodDto {
  @IsIn(PAYROLL_FREQUENCIES, { message: 'القيمة المختارة غير صالحة' })
  frequency: (typeof PAYROLL_FREQUENCIES)[number];

  /** أي تاريخ داخل الفترة المطلوبة؛ الخادم يشتق حدودها (الأسبوع من يوم بدايته، نصف الشهر، الشهر) */
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  date: Date;
}

export class PeriodsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(PERIOD_STATUSES, { message: 'القيمة المختارة غير صالحة' })
  status?: (typeof PERIOD_STATUSES)[number];

  @IsOptional()
  @IsIn(PAYROLL_FREQUENCIES, { message: 'القيمة المختارة غير صالحة' })
  frequency?: (typeof PAYROLL_FREQUENCIES)[number];
}

export class CreateAdjustmentDto {
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  employeeId: string;

  @IsIn(ADJUSTMENT_TYPES, { message: 'القيمة المختارة غير صالحة' })
  type: (typeof ADJUSTMENT_TYPES)[number];

  /** المكافأة والخصم موجبان؛ فرق الراتب موجب لصالح الموظف وسالب عليه */
  @IsString({ message: 'أدخل قيمة نصية' })
  @Matches(/^-?(?!0(?:\.0{1,2})?$)(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, { message: 'أدخل مبلغًا غير صفري بخانتين عشريتين على الأكثر' })
  amount: string;

  @Transform(trim)
  @IsString({ message: 'أدخل قيمة نصية' })
  @MinLength(2, { message: 'اكتب سبب التسوية' })
  @MaxLength(230, { message: 'السبب لا يتجاوز 230 حرفًا' })
  reason: string;

  /** المستحق في الفترة المغلقة الذي يصححه فرق الراتب (اختياري) */
  @IsOptional()
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  targetEntryId?: string;
}

export class AdjustmentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  employeeId?: string;

  @IsOptional()
  @IsIn(ADJUSTMENT_STATUSES, { message: 'القيمة المختارة غير صالحة' })
  status?: (typeof ADJUSTMENT_STATUSES)[number];
}
