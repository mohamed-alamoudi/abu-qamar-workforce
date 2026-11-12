import { dayOfWeek, daysInMonth, eachDay, inRange, monthEnd, monthKey, monthLabel, monthStart } from './iso-dates';
import {
  CalcComponent,
  CalcDay,
  CalcInput,
  CalcResult,
  CalcWarning,
  Decimal,
  IsoDate,
  PolicyInput,
  RateInput,
  ScheduleInput,
} from './types';

/**
 * نواة حساب مستحق موظف واحد ضمن فترة رواتب — دالة صرفة.
 *
 * قاعدة التقريب: كل الحسابات الوسيطة بدقة Decimal كاملة (الضرب قبل القسمة)، ولا يُقرَّب إلا
 * المبلغ النهائي لكل بند إلى خانتين عشريتين بطريقة «نصف إلى الأعلى» (0.005 → 0.01، ‎−0.005 → ‎−0.01).
 * الإجماليات مجموع البنود المقرَّبة، فمجموع ما يراه المستخدم يطابق الإجمالي دائمًا.
 */

const ZERO = new Decimal(0);
const SIXTY = new Decimal(60);

export function roundMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

const round4 = (value: Decimal) => value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

/** 150 دقيقة → «2:30» */
export function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

const money = (value: Decimal) => value.toFixed(2);

function effectiveOn<T extends { from: IsoDate; to: IsoDate | null }>(rows: T[], date: IsoDate): T | null {
  return rows.find((row) => inRange(date, row.from, row.to)) ?? null;
}

/** أيام العمل المجدولة: نمط أسبوعي لجدول غير مرن، أو وردية مجدولة بتاريخ محدد. */
class ScheduleIndex {
  private readonly shiftDates: Set<IsoDate>;
  private readonly workDaysByMonth = new Map<string, number>();

  constructor(
    private readonly schedules: ScheduleInput[],
    shiftDates: IsoDate[],
  ) {
    this.shiftDates = new Set(shiftDates);
  }

  private fixedSchedule(date: IsoDate): ScheduleInput | null {
    const schedule = effectiveOn(this.schedules, date);
    return schedule && !schedule.isFlexible ? schedule : null;
  }

  /** هل للموظف التزام عمل معرَّف (جدول غير مرن) يغطي هذا اليوم؟ */
  hasSchedule(date: IsoDate): boolean {
    return this.fixedSchedule(date) !== null || this.shiftDates.has(date);
  }

  isWorkDay(date: IsoDate): boolean {
    return this.shiftDates.has(date) || (this.fixedSchedule(date)?.weekDays.includes(dayOfWeek(date)) ?? false);
  }

  workDaysInMonth(month: string): number {
    let count = this.workDaysByMonth.get(month);
    if (count === undefined) {
      count = eachDay(monthStart(month), monthEnd(month)).filter((d) => this.isWorkDay(d)).length;
      this.workDaysByMonth.set(month, count);
    }
    return count;
  }
}

interface Group {
  rate: Decimal;
  minutes: number;
  days: number;
  ref?: Decimal;
  month?: string;
  leaveId?: string;
  divisor?: number;
  firstDate: IsoDate;
}

function bump(map: Map<string, Group>, key: string, init: Omit<Group, 'minutes' | 'days'>, minutes: number, days: number): void {
  const group = map.get(key) ?? { ...init, minutes: 0, days: 0 };
  group.minutes += minutes;
  group.days += days;
  map.set(key, group);
}

export function calculateEntry(input: CalcInput): CalcResult {
  const { periodStart, periodEnd } = input;
  const warnings: CalcWarning[] = [];
  const warn = (code: CalcWarning['code'], message: string, blocking: boolean, date: IsoDate | null = null) => {
    if (!warnings.some((w) => w.code === code && w.date === date)) warnings.push({ code, message, blocking, date });
  };
  const inPeriod = (date: IsoDate) => date >= periodStart && date <= periodEnd;
  const rateOn = (date: IsoDate): RateInput | null => effectiveOn(input.rates, date);
  const policyOn = (date: IsoDate): PolicyInput | null => effectiveOn(input.policies, date);
  const employed = (date: IsoDate) => input.employmentEnd === null || date <= input.employmentEnd;

  // ── تجميع الدقائق لكل يوم عمل (الوردية الليلية تتبع يوم بدايتها workDate) ──
  const worked = new Map<IsoDate, number>();
  for (const s of input.sessions) {
    if (inPeriod(s.workDate)) worked.set(s.workDate, (worked.get(s.workDate) ?? 0) + s.workedMinutes);
  }
  const overtimeAll = new Map<IsoDate, number>();
  const overtimeApproved = new Map<IsoDate, number>();
  for (const o of input.overtime) {
    if (!inPeriod(o.workDate)) continue;
    overtimeAll.set(o.workDate, (overtimeAll.get(o.workDate) ?? 0) + o.minutes);
    if (o.status === 'APPROVED') overtimeApproved.set(o.workDate, (overtimeApproved.get(o.workDate) ?? 0) + o.minutes);
  }

  const hourly = new Map<string, Group>();
  const dailyFull = new Map<string, Group>();
  const dailyProportional = new Map<string, Group>();
  const monthly = new Map<string, Group>();
  const days: CalcDay[] = [];

  for (const date of eachDay(periodStart, periodEnd)) {
    const rate = rateOn(date);
    const minutes = worked.get(date) ?? 0;
    const otAll = overtimeAll.get(date) ?? 0;
    const otApproved = overtimeApproved.get(date) ?? 0;
    // الدقائق المصنفة إضافيًا (بأي حالة) لا تدخل الأجر العادي: المعتمد يُدفع كإضافي، وغير المعتمد لا يُدفع
    const regular = Math.max(0, minutes - otAll);

    if (minutes > 0 || otAll > 0) {
      days.push({
        date,
        payType: rate?.payType ?? null,
        rate: rate ? money(rate.amount) : null,
        workedMinutes: minutes,
        regularMinutes: regular,
        overtimeApprovedMinutes: otApproved,
        overtimeExcludedMinutes: otAll - otApproved,
      });
    }

    if (!rate) {
      if (minutes > 0 || otApproved > 0) warn('NO_RATE', `دوام بتاريخ ${date} دون أجر سارٍ في ذلك اليوم`, true, date);
      continue;
    }
    const key = rate.amount.toString();
    if (rate.payType === 'HOURLY') {
      if (regular > 0) bump(hourly, key, { rate: rate.amount, firstDate: date }, regular, 0);
    } else if (rate.payType === 'DAILY') {
      if (regular === 0) continue;
      const policy = policyOn(date);
      if (!policy?.dailyPayMode) {
        warn('NO_POLICY', `لا توجد سياسة أجر يومي (كامل/نسبي) سارية بتاريخ ${date}`, true, date);
      } else if (policy.dailyPayMode === 'FULL') {
        // أجر اليوم مرة واحدة مهما تعددت الورديات
        bump(dailyFull, key, { rate: rate.amount, firstDate: date }, 0, 1);
      } else if (!policy.referenceDailyHours || policy.referenceDailyHours.lte(0)) {
        warn('NO_POLICY', `الأجر اليومي النسبي بتاريخ ${date} بلا ساعات مرجعية`, true, date);
      } else {
        const ref = policy.referenceDailyHours;
        bump(dailyProportional, `${key}|${ref.toString()}`, { rate: rate.amount, ref, firstDate: date }, regular, 0);
      }
    } else if (employed(date)) {
      const month = monthKey(date);
      bump(monthly, `${key}|${month}`, { rate: rate.amount, month, firstDate: date }, 0, 1);
    }
  }

  const components: CalcComponent[] = [];

  // ── الأجر العادي ──
  for (const g of hourly.values()) {
    components.push({
      type: 'REGULAR_WAGE',
      description: `أجر بالساعة: ${formatMinutes(g.minutes)} ساعة × ${money(g.rate)}`,
      workDate: null,
      quantity: round4(new Decimal(g.minutes).div(SIXTY)),
      unit: 'hour',
      rate: g.rate,
      amount: roundMoney(g.rate.times(g.minutes).div(SIXTY)),
      sourceType: 'work_session',
      sourceId: null,
    });
  }
  for (const g of dailyFull.values()) {
    components.push({
      type: 'REGULAR_WAGE',
      description: `أجر يومي كامل: ${g.days} يوم × ${money(g.rate)}`,
      workDate: null,
      quantity: new Decimal(g.days),
      unit: 'day',
      rate: g.rate,
      amount: roundMoney(g.rate.times(g.days)),
      sourceType: 'work_session',
      sourceId: null,
    });
  }
  for (const g of dailyProportional.values()) {
    const refMinutes = (g.ref as Decimal).times(SIXTY);
    components.push({
      type: 'REGULAR_WAGE',
      description: `أجر يومي نسبي: ${formatMinutes(g.minutes)} ساعة من يوم مرجعي ${(g.ref as Decimal).toString()} ساعة × ${money(g.rate)}`,
      workDate: null,
      quantity: round4(new Decimal(g.minutes).div(refMinutes)),
      unit: 'day',
      rate: g.rate,
      amount: roundMoney(g.rate.times(g.minutes).div(refMinutes)),
      sourceType: 'work_session',
      sourceId: null,
    });
  }
  let monthlyAccrued = ZERO;
  for (const g of monthly.values()) {
    const month = g.month as string;
    const total = daysInMonth(month);
    // شهر كامل = الراتب كما هو دون قسمة؛ جزء من الشهر = بنسبة أيام التقويم
    const amount = g.days === total ? roundMoney(g.rate) : roundMoney(g.rate.times(g.days).div(total));
    monthlyAccrued = monthlyAccrued.plus(amount);
    components.push({
      type: 'REGULAR_WAGE',
      description:
        g.days === total
          ? `راتب شهري: ${monthLabel(month)} كاملًا`
          : `راتب شهري: ${g.days} من ${total} يومًا في ${monthLabel(month)} × ${money(g.rate)}`,
      workDate: null,
      quantity: new Decimal(g.days),
      unit: 'day',
      rate: round4(g.rate.div(total)),
      amount,
      sourceType: null,
      sourceId: null,
    });
  }

  // ── الإضافي المعتمد فقط ──
  for (const o of input.overtime) {
    if (o.status !== 'APPROVED' || !inPeriod(o.workDate)) continue;
    const rate = rateOn(o.workDate);
    if (!rate) continue; // سبق التحذير NO_RATE
    let hourlyRate: Decimal | null = null;
    let exact: Decimal | null = null;
    let basis = '';
    if (o.specialHourlyRate) {
      hourlyRate = o.specialHourlyRate;
      exact = o.specialHourlyRate.times(o.minutes).div(SIXTY);
      basis = `سعر خاص ${money(o.specialHourlyRate)}`;
    } else if (rate.payType === 'HOURLY') {
      hourlyRate = rate.amount.times(o.multiplier);
      exact = rate.amount.times(o.multiplier).times(o.minutes).div(SIXTY);
      basis = `${money(rate.amount)} × ${o.multiplier.toString()}`;
    } else if (rate.payType === 'DAILY') {
      const ref = policyOn(o.workDate)?.referenceDailyHours;
      if (ref && ref.gt(0)) {
        hourlyRate = rate.amount.times(o.multiplier).div(ref);
        exact = rate.amount.times(o.multiplier).times(o.minutes).div(ref.times(SIXTY));
        basis = `(${money(rate.amount)} ÷ ${ref.toString()} ساعة) × ${o.multiplier.toString()}`;
      }
    }
    if (!exact || !hourlyRate) {
      warn(
        'OVERTIME_RATE_UNKNOWN',
        `تعذر تسعير إضافي ${o.workDate}: لا سعر ساعة يُشتق من أجر الموظف. حدّد سعرًا خاصًا للإضافي أو ارفضه`,
        true,
        o.workDate,
      );
      continue;
    }
    components.push({
      type: 'OVERTIME',
      description: `إضافي معتمد ${o.workDate}: ${formatMinutes(o.minutes)} ساعة × ${basis}`,
      workDate: o.workDate,
      quantity: round4(new Decimal(o.minutes).div(SIXTY)),
      unit: 'hour',
      rate: round4(hourlyRate),
      amount: roundMoney(exact),
      sourceType: 'overtime_entry',
      sourceId: o.id,
    });
  }

  // ── خصم الغياب غير المدفوع من الراتب الشهري ──
  const schedule = new ScheduleIndex(input.schedules, input.scheduledShiftDates);
  const absence = new Map<string, Group>();
  for (const leave of input.leaves) {
    if (!leave.affectsPay) continue;
    const from = leave.startDate > periodStart ? leave.startDate : periodStart;
    const to = leave.endDate < periodEnd ? leave.endDate : periodEnd;
    for (const date of from <= to ? eachDay(from, to) : []) {
      const rate = rateOn(date);
      if (!rate || rate.payType !== 'MONTHLY' || !employed(date)) continue;
      const policy = policyOn(date);
      const method = policy?.absenceDeductionMethod;
      if (!method) {
        warn('NO_POLICY', `لا توجد طريقة خصم غياب سارية بتاريخ ${date}`, true, date);
        continue;
      }
      // يوم راحة ضمن جدول معرَّف: لا يُخصم
      if (schedule.hasSchedule(date) && !schedule.isWorkDay(date)) continue;
      const month = monthKey(date);
      let divisor: number;
      if (method === 'ACTUAL_MONTH_DAYS') {
        divisor = daysInMonth(month);
      } else if (method === 'FIXED_DAYS') {
        divisor = policy?.fixedMonthDays ?? 0;
      } else {
        divisor = schedule.hasSchedule(date) ? schedule.workDaysInMonth(month) : 0;
      }
      if (divisor <= 0) {
        warn(
          method === 'SCHEDULED_WORK_DAYS' ? 'NO_SCHEDULE_FOR_DEDUCTION' : 'NO_POLICY',
          method === 'SCHEDULED_WORK_DAYS'
            ? `خصم الغياب بطريقة «أيام العمل المجدولة» يتطلب جدول عمل يغطي ${date}`
            : `عدد الأيام الثابت لخصم الغياب غير محدد بتاريخ ${date}`,
          true,
          date,
        );
        continue;
      }
      bump(absence, `${leave.id}|${rate.amount.toString()}|${divisor}`, { rate: rate.amount, leaveId: leave.id, divisor, firstDate: date }, 0, 1);
    }
  }
  let absenceLeft = monthlyAccrued;
  for (const g of absence.values()) {
    const divisor = g.divisor as number;
    let amount = roundMoney(g.rate.times(g.days).div(divisor));
    if (amount.gt(absenceLeft)) {
      // الخصم لا يتجاوز الراتب المستحق عن الفترة
      amount = absenceLeft;
      warn('ABSENCE_CAPPED', 'خصم الغياب حُدَّ بقيمة الراتب المستحق عن الفترة', false);
    }
    absenceLeft = absenceLeft.minus(amount);
    if (amount.isZero()) continue;
    components.push({
      type: 'ABSENCE_DEDUCTION',
      description: `خصم غياب غير مدفوع: ${g.days} يوم × (${money(g.rate)} ÷ ${divisor})`,
      workDate: g.firstDate,
      quantity: new Decimal(g.days),
      unit: 'day',
      rate: round4(g.rate.div(divisor)),
      amount: amount.negated(),
      sourceType: 'leave_record',
      sourceId: g.leaveId as string,
    });
  }

  // ── المكافآت والخصومات وفروقات الرواتب المعتمدة ──
  for (const a of input.adjustments) {
    const signed = a.type === 'DEDUCTION' ? a.amount.abs().negated() : a.type === 'BONUS' ? a.amount.abs() : a.amount;
    components.push({
      type: a.type === 'WAGE_DIFFERENCE' ? 'ADJUSTMENT' : a.type,
      description: `${a.type === 'BONUS' ? 'مكافأة' : a.type === 'DEDUCTION' ? 'خصم' : 'فرق راتب'}: ${a.reason}`,
      workDate: null,
      quantity: null,
      unit: null,
      rate: null,
      amount: roundMoney(signed),
      sourceType: 'payroll_adjustment',
      sourceId: a.id,
    });
  }

  let gross = ZERO;
  let deductions = ZERO;
  for (const c of components) {
    if (c.amount.isNegative()) deductions = deductions.minus(c.amount);
    else gross = gross.plus(c.amount);
  }
  const net = gross.minus(deductions);
  if (net.isNegative()) warn('NEGATIVE_NET', 'الخصومات تتجاوز المستحق: الصافي سالب. عدّل الخصومات أو أجّلها', true);

  return { components, gross, deductions, net, warnings, days };
}
