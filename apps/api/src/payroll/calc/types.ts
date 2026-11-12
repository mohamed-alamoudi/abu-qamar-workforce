import { Prisma } from '@abu-qamar/database';

/**
 * أنواع نواة حساب الأجور. النواة صرفة: لا تصل إلى قاعدة البيانات ولا إلى الساعة،
 * والتواريخ فيها نصوص محلية 'YYYY-MM-DD' (تُقارن أبجديًا)، والمبالغ Decimal دائمًا.
 */
export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export type IsoDate = string;

export type PayType = 'HOURLY' | 'DAILY' | 'MONTHLY';
export type DailyPayMode = 'FULL' | 'PROPORTIONAL';
export type AbsenceDeductionMethod = 'ACTUAL_MONTH_DAYS' | 'FIXED_DAYS' | 'SCHEDULED_WORK_DAYS';
export type PayrollFrequency = 'WEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY';
export type OvertimeStatus = 'DETECTED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
export type ComponentType = 'REGULAR_WAGE' | 'OVERTIME' | 'BONUS' | 'DEDUCTION' | 'ABSENCE_DEDUCTION' | 'ADJUSTMENT';
export type AdjustmentType = 'BONUS' | 'DEDUCTION' | 'WAGE_DIFFERENCE';

export interface RateInput {
  payType: PayType;
  amount: Decimal;
  from: IsoDate;
  to: IsoDate | null;
}

export interface PolicyInput {
  dailyPayMode: DailyPayMode | null;
  referenceDailyHours: Decimal | null;
  absenceDeductionMethod: AbsenceDeductionMethod | null;
  fixedMonthDays: number | null;
  from: IsoDate;
  to: IsoDate | null;
}

/** وردية مغلقة ومعتمدة. workedMinutes صافية من الاستراحات غير المدفوعة، و workDate يوم بدايتها المحلي. */
export interface SessionInput {
  id: string;
  workDate: IsoDate;
  workedMinutes: number;
}

/** كل سجلات الإضافي في الفترة بكل حالاتها: المعتمد يُدفع، وغير المعتمد يُستبعد من الأجر العادي أيضًا. */
export interface OvertimeInput {
  id: string;
  workDate: IsoDate;
  minutes: number;
  multiplier: Decimal;
  specialHourlyRate: Decimal | null;
  status: OvertimeStatus;
}

/** إجازة/غياب معتمد. affectsPay = يُخصم من الأجر الشهري. */
export interface LeaveInput {
  id: string;
  startDate: IsoDate;
  endDate: IsoDate;
  affectsPay: boolean;
  paid?: boolean;
}

export interface ScheduleInput {
  from: IsoDate;
  to: IsoDate | null;
  isFlexible: boolean;
  /** أيام العمل الأسبوعية بترقيم JavaScript (0 = الأحد … 6 = السبت) */
  weekDays: number[];
}

export interface AdjustmentInput {
  id: string;
  type: AdjustmentType;
  /** BONUS و DEDUCTION موجبان دائمًا؛ WAGE_DIFFERENCE بإشارته (موجب لصالح الموظف) */
  amount: Decimal;
  reason: string;
}

export interface CalcInput {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  rates: RateInput[];
  policies: PolicyInput[];
  sessions: SessionInput[];
  overtime: OvertimeInput[];
  leaves: LeaveInput[];
  schedules: ScheduleInput[];
  /** تواريخ محلية لورديات مجدولة بتاريخ محدد (جداول متغيرة) */
  scheduledShiftDates: IsoDate[];
  plannedMinutes?: ReadonlyMap<IsoDate, number>;
  /** آخر يوم عمل (تاريخ إنهاء العمل) إن وُجد — الراتب الشهري لا يُستحق بعده */
  employmentEnd: IsoDate | null;
  adjustments: AdjustmentInput[];
}

export interface CalcComponent {
  type: ComponentType;
  description: string;
  workDate: IsoDate | null;
  quantity: Decimal | null;
  unit: 'hour' | 'day' | null;
  rate: Decimal | null;
  /** موجب للاستحقاق وسالب للخصم — مقرَّب إلى خانتين */
  amount: Decimal;
  sourceType: 'work_session' | 'overtime_entry' | 'leave_record' | 'payroll_adjustment' | null;
  sourceId: string | null;
}

export type WarningCode =
  | 'NO_RATE'
  | 'NO_POLICY'
  | 'OVERTIME_RATE_UNKNOWN'
  | 'NO_SCHEDULE_FOR_PAID_LEAVE'
  | 'NO_SCHEDULE_FOR_DEDUCTION'
  | 'ABSENCE_CAPPED'
  | 'NEGATIVE_NET';

export interface CalcWarning {
  code: WarningCode;
  message: string;
  /** المانع يوقف إغلاق الفترة حتى يُعالج */
  blocking: boolean;
  date: IsoDate | null;
}

/** تفصيل يومي غير مقرَّب، للعرض وللنسخة الثابتة عند الإغلاق. */
export interface CalcDay {
  date: IsoDate;
  payType: PayType | null;
  rate: string | null;
  workedMinutes: number;
  /** الدقائق التي دخلت الأجر العادي */
  regularMinutes: number;
  overtimeApprovedMinutes: number;
  /** إضافي غير معتمد أو مرفوض: لا يُدفع عاديًا ولا إضافيًا */
  overtimeExcludedMinutes: number;
}

export interface CalcResult {
  components: CalcComponent[];
  gross: Decimal;
  deductions: Decimal;
  net: Decimal;
  warnings: CalcWarning[];
  days: CalcDay[];
}
