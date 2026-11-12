import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

const Trim = () => Transform(({ value }) => typeof value === 'string' ? value.trim() : value);
export class MoneyDto {
  @IsString({ message: 'أدخل قيمة نصية' })
  @Matches(/^(?!0(?:\.0{1,2})?$)(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, { message: 'أدخل مبلغًا موجبًا بخانتين عشريتين على الأكثر' })
  amount: string;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true }, { message: 'وقت العملية غير صالح' })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/, { message: 'حدّد الوقت والمنطقة الزمنية' })
  occurredAt?: string;
}

export class PaymentDetailsDto extends MoneyDto {
  @IsIn(['CASH', 'BANK_TRANSFER', 'E_WALLET'], { message: 'القيمة المختارة غير صالحة' })
  method: 'CASH' | 'BANK_TRANSFER' | 'E_WALLET';

  @IsOptional()
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  paidById?: string;

  @Trim()
  @IsString({ message: 'أدخل قيمة نصية' })
  @MinLength(1, { message: 'هذا الحقل مطلوب' })
  @MaxLength(150, { message: 'النص لا يتجاوز 150 حرفًا' })
  receivedBy: string;

  @Trim()
  @IsString({ message: 'أدخل قيمة نصية' })
  @MinLength(1, { message: 'هذا الحقل مطلوب' })
  @MaxLength(100, { message: 'النص لا يتجاوز 100 حرفًا' })
  reference: string;

  @IsOptional()
  @Trim()
  @IsString({ message: 'أدخل قيمة نصية' })
  @MaxLength(255, { message: 'النص لا يتجاوز 255 حرفًا' })
  note?: string;
}

export class PaymentDto extends PaymentDetailsDto {
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  payrollEntryId: string;
}

export class AdvanceDto extends PaymentDetailsDto {
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  employeeId: string;
}

export class DebtDto extends MoneyDto {
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  employeeId: string;

  @IsOptional()
  @Trim()
  @IsString({ message: 'أدخل قيمة نصية' })
  @MaxLength(255, { message: 'النص لا يتجاوز 255 حرفًا' })
  reason?: string;
}

export class SettlementDto extends MoneyDto {
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  payrollEntryId: string;

  @IsIn(['ADVANCE', 'DEBT'], { message: 'القيمة المختارة غير صالحة' })
  targetType: 'ADVANCE' | 'DEBT';

  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  targetId: string;

  @Trim()
  @IsString({ message: 'أدخل قيمة نصية' })
  @MinLength(2, { message: 'اكتب سببًا من حرفين على الأقل' })
  @MaxLength(255, { message: 'النص لا يتجاوز 255 حرفًا' })
  reason: string;
}

export class ReversalDto {
  @Trim()
  @IsString({ message: 'أدخل قيمة نصية' })
  @MinLength(2, { message: 'اكتب سببًا من حرفين على الأقل' })
  @MaxLength(255, { message: 'النص لا يتجاوز 255 حرفًا' })
  reason: string;
}

export class LedgerQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'المعرّف غير صالح' })
  employeeId?: string;
}
