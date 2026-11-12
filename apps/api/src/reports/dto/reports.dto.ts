import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { ToDateOnly } from '../../common/utils/dates';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
const toBoolean = ({ value }: { value: unknown }) => (value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value);
const DATE_MESSAGE = 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD';
const CHOICE = { message: 'قيمة الفلتر غير صالحة' };
const FLAG = { message: 'قيمة الفلتر يجب أن تكون نعم أو لا' };

export const EXPORT_FORMATS = ['json', 'xlsx', 'pdf'] as const;
export type ReportFormat = (typeof EXPORT_FORMATS)[number];

/** الاستعلام المشترك بين التقارير الأربعة: النطاق، الفترة، البحث، الأعمدة، الترقيم، صيغة الإخراج. */
export class ReportQueryDto {
  /** رقم الصفحة (يبدأ من 1) */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'رقم الصفحة يجب أن يكون عددًا صحيحًا' })
  @Min(1, { message: 'رقم الصفحة يبدأ من 1' })
  @Max(10_000_000, { message: 'رقم الصفحة أكبر من الحد المسموح' })
  page: number = 1;

  /** عدد الصفوف في الصفحة (الأقصى 200) */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'حجم الصفحة يجب أن يكون عددًا صحيحًا' })
  @Min(1, { message: 'حجم الصفحة يبدأ من صف واحد' })
  @Max(200, { message: 'الحد الأقصى لحجم الصفحة 200 صف' })
  pageSize: number = 25;

  /** بداية الفترة (شاملة) بالتاريخ المحلي — الافتراضي أول الشهر الحالي */
  @IsOptional()
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  from?: Date;

  /** نهاية الفترة (شاملة) بالتاريخ المحلي — الافتراضي اليوم */
  @IsOptional()
  @ToDateOnly()
  @IsDate({ message: DATE_MESSAGE })
  to?: Date;

  /** تقرير موظف واحد */
  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف الموظف غير صالح' })
  employeeId?: string;

  /** تقرير قسم واحد (يُتجاهل إن حُدِّد موظف) */
  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف القسم غير صالح' })
  departmentId?: string;

  /** بحث في اسم الموظف أو كوده (وفي المرجع والمستلم في تقرير الدفعات) */
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'البحث يجب أن يكون نصًا' })
  @MaxLength(100, { message: 'البحث يقبل حتى 100 حرف' })
  search?: string;

  /** طريقة العرض داخل التقرير (تختلف حسب التقرير) */
  @IsOptional()
  @IsString({ message: 'طريقة العرض يجب أن تكون نصًا' })
  @Matches(/^[A-Za-z]{1,32}$/, { message: 'طريقة العرض غير صالحة' })
  view?: string;

  /** الأعمدة المطلوبة مفصولة بفواصل — تُفحص مقابل القائمة البيضاء للتقرير */
  @IsOptional()
  @IsString({ message: 'قائمة الأعمدة يجب أن تكون نصًا' })
  @MaxLength(1000, { message: 'قائمة الأعمدة أطول من الحد المسموح' })
  @Matches(/^[A-Za-z,\s]*$/, { message: 'قائمة الأعمدة غير صالحة' })
  columns?: string;

  /** صيغة الإخراج: json (الافتراضي) أو xlsx أو pdf */
  @IsOptional()
  @IsIn(EXPORT_FORMATS, { message: 'صيغة التصدير غير صالحة' })
  format: ReportFormat = 'json';

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'اتجاه الترتيب غير صالح' })
  sortDir?: 'asc' | 'desc';
}

export class AttendanceReportQueryDto extends ReportQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED'], CHOICE)
  status?: 'OPEN' | 'CLOSED';

  @IsOptional()
  @IsIn(['DRAFT', 'IN_REVIEW', 'APPROVED'], CHOICE)
  approvalStatus?: 'DRAFT' | 'IN_REVIEW' | 'APPROVED';

  /** الورديات المتأخرة فقط (حيث يوجد جدول) */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean(FLAG)
  lateOnly?: boolean;
}

export class AbsenceReportQueryDto extends ReportQueryDto {
  @IsOptional()
  @IsIn(['PAID_LEAVE', 'UNPAID_LEAVE', 'PAID_EXCUSED_ABSENCE', 'UNPAID_ABSENCE'], CHOICE)
  type?: 'PAID_LEAVE' | 'UNPAID_LEAVE' | 'PAID_EXCUSED_ABSENCE' | 'UNPAID_ABSENCE';

  /** الافتراضي: المعتمدة والمعلّقة (دون المرفوضة والملغاة). ALL لكل الحالات */
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL'], CHOICE)
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'ALL';

  /** paid = الأنواع المدفوعة، unpaid = غير المدفوعة */
  @IsOptional()
  @IsIn(['paid', 'unpaid'], CHOICE)
  pay?: 'paid' | 'unpaid';
}

export class FinancialReportQueryDto extends ReportQueryDto {
  /** الافتراضي: الفترات المغلقة فقط. ALL لكل الحالات */
  @IsOptional()
  @IsIn(['DRAFT', 'IN_REVIEW', 'READY_FOR_APPROVAL', 'CLOSED', 'ALL'], CHOICE)
  periodStatus?: 'DRAFT' | 'IN_REVIEW' | 'READY_FOR_APPROVAL' | 'CLOSED' | 'ALL';

  /** لعرضَي السلف والديون */
  @IsOptional()
  @IsIn(['OPEN', 'SETTLED', 'CANCELLED'], CHOICE)
  accountStatus?: 'OPEN' | 'SETTLED' | 'CANCELLED';

  /** ما له رصيد غير مدفوع / متبقٍ فقط */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean(FLAG)
  outstandingOnly?: boolean;

  /** لعرض التسويات */
  @IsOptional()
  @IsIn(['PAYROLL_ENTRY', 'ADVANCE', 'DEBT', 'ADJUSTMENT'], CHOICE)
  targetType?: 'PAYROLL_ENTRY' | 'ADVANCE' | 'DEBT' | 'ADJUSTMENT';
}

export class PaymentsReportQueryDto extends ReportQueryDto {
  @IsOptional()
  @IsIn(['CASH', 'BANK_TRANSFER', 'E_WALLET'], CHOICE)
  method?: 'CASH' | 'BANK_TRANSFER' | 'E_WALLET';

  /** الافتراضي: دفعات الرواتب. ALL = دفعات الرواتب وصرف السلف */
  @IsOptional()
  @IsIn(['SALARY_PAYMENT', 'ADVANCE_DISBURSEMENT', 'ALL'], CHOICE)
  type?: 'SALARY_PAYMENT' | 'ADVANCE_DISBURSEMENT' | 'ALL';

  /** الافتراضي: المسجَّلة فقط (دون المعكوسة) */
  @IsOptional()
  @IsIn(['POSTED', 'REVERSED', 'ALL'], CHOICE)
  status?: 'POSTED' | 'REVERSED' | 'ALL';

  /** من نفّذ الدفعة */
  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف منفّذ الدفعة غير صالح' })
  executorId?: string;

  /** فترة الرواتب التي تغطيها الدفعة */
  @IsOptional()
  @IsUUID(undefined, { message: 'معرّف فترة الرواتب غير صالح' })
  periodId?: string;
}
