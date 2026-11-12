import { calculateEntry, formatMinutes, roundMoney } from './calculator';
import { resolvePayrollPeriod } from './periods';
import { CalcInput, Decimal, OvertimeInput, PolicyInput, RateInput, ScheduleInput } from './types';

const dec = (v: number | string) => new Decimal(v);

const rate = (payType: RateInput['payType'], amount: number | string, from = '2020-01-01', to: string | null = null): RateInput => ({
  payType,
  amount: dec(amount),
  from,
  to,
});

const policy = (extra: Partial<PolicyInput> = {}): PolicyInput => ({
  dailyPayMode: null,
  referenceDailyHours: null,
  absenceDeductionMethod: null,
  fixedMonthDays: null,
  from: '2020-01-01',
  to: null,
  ...extra,
});

let seq = 0;
const session = (workDate: string, workedMinutes: number) => ({ id: `s${++seq}`, workDate, workedMinutes });
const overtime = (workDate: string, minutes: number, extra: Partial<OvertimeInput> = {}): OvertimeInput => ({
  id: `o${++seq}`,
  workDate,
  minutes,
  multiplier: dec(1.5),
  specialHourlyRate: null,
  status: 'APPROVED',
  ...extra,
});
const leave = (startDate: string, endDate: string, affectsPay = true) => ({ id: `l${++seq}`, startDate, endDate, affectsPay });

/** السبت–الخميس عمل، الجمعة راحة */
const SAT_TO_THU: ScheduleInput = { from: '2020-01-01', to: null, isFlexible: false, weekDays: [6, 0, 1, 2, 3, 4] };

const input = (extra: Partial<CalcInput>): CalcInput => ({
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  rates: [],
  policies: [],
  sessions: [],
  overtime: [],
  leaves: [],
  schedules: [],
  scheduledShiftDates: [],
  employmentEnd: null,
  adjustments: [],
  ...extra,
});

const amounts = (result: ReturnType<typeof calculateEntry>) => result.components.map((c) => `${c.type}:${c.amount.toFixed(2)}`);
const totals = (result: ReturnType<typeof calculateEntry>) => ({
  gross: result.gross.toFixed(2),
  deductions: result.deductions.toFixed(2),
  net: result.net.toFixed(2),
});

describe('التقريب', () => {
  it('نصف إلى الأعلى على خانتين، بلا أخطاء الفاصلة العائمة', () => {
    expect(roundMoney(dec('0.005')).toFixed(2)).toBe('0.01');
    expect(roundMoney(dec('1.005')).toFixed(2)).toBe('1.01'); // في JS: (1.005).toFixed(2) = "1.00"
    expect(roundMoney(dec('2.675')).toFixed(2)).toBe('2.68');
    expect(roundMoney(dec('0.0049')).toFixed(2)).toBe('0.00');
    expect(roundMoney(dec('-0.005')).toFixed(2)).toBe('-0.01');
    expect(formatMinutes(150)).toBe('2:30');
    expect(formatMinutes(5)).toBe('0:05');
  });

  it('يُقرَّب المبلغ النهائي للبند فقط وليس كل يوم على حدة', () => {
    // ثلاثة أيام × 7 دقائق × 20 ÷ 60: كل يوم = 2.3333… (لو قُرِّب كل يوم: 2.33 × 3 = 6.99)
    // المجموع الصحيح: 21 دقيقة × 20 ÷ 60 = 7.00
    const result = calculateEntry(
      input({
        rates: [rate('HOURLY', 20)],
        sessions: [session('2026-11-01', 7), session('2026-11-02', 7), session('2026-11-03', 7)],
      }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:7.00']);
  });

  it('حالة النصف تمامًا: 3 دقائق × 10.10 ÷ 60 = 0.505 → 0.51', () => {
    const result = calculateEntry(input({ rates: [rate('HOURLY', '10.10')], sessions: [session('2026-11-01', 3)] }));
    expect(result.net.toFixed(2)).toBe('0.51');
  });
});

describe('الأجر بالساعة', () => {
  it('الدقائق الفعلية × سعر الساعة دون تقريب للوقت', () => {
    // 480 + 455 = 935 دقيقة × 20 ÷ 60 = 311.6667 → 311.67
    const result = calculateEntry(
      input({ rates: [rate('HOURLY', 20)], sessions: [session('2026-11-01', 480), session('2026-11-02', 455)] }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:311.67']);
    expect(result.components[0].quantity?.toFixed(4)).toBe('15.5833');
    expect(totals(result)).toEqual({ gross: '311.67', deductions: '0.00', net: '311.67' });
  });

  it('تغير السعر أثناء الفترة: كل يوم بالسعر الساري فيه', () => {
    // 10 نوفمبر: 450 دقيقة × 20 ÷ 60 = 150.00 · 11 نوفمبر: 450 × 24 ÷ 60 = 180.00
    const result = calculateEntry(
      input({
        rates: [rate('HOURLY', 20, '2026-01-01', '2026-11-10'), rate('HOURLY', 24, '2026-11-11')],
        sessions: [session('2026-11-10', 450), session('2026-11-11', 450)],
      }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:150.00', 'REGULAR_WAGE:180.00']);
    expect(result.net.toFixed(2)).toBe('330.00');
  });

  it('عدة ورديات في اليوم تُجمع دقائقها', () => {
    // (240 + 180) × 30 ÷ 60 = 210.00
    const result = calculateEntry(
      input({ rates: [rate('HOURLY', 30)], sessions: [session('2026-11-05', 240), session('2026-11-05', 180)] }),
    );
    expect(result.net.toFixed(2)).toBe('210.00');
    expect(result.days).toEqual([expect.objectContaining({ date: '2026-11-05', workedMinutes: 420, regularMinutes: 420 })]);
  });

  it('وردية تعبر منتصف الليل تُنسب كاملة إلى يوم بدايتها (workDate)', () => {
    // وردية 30 نوفمبر 22:00 → 1 ديسمبر 06:00 (480 دقيقة) تتبع نوفمبر، وبسعر 30 نوفمبر
    const rates = [rate('HOURLY', 20, '2026-01-01', '2026-11-30'), rate('HOURLY', 50, '2026-12-01')];
    const sessions = [session('2026-11-30', 480)];
    const november = calculateEntry(input({ rates, sessions }));
    expect(november.net.toFixed(2)).toBe('160.00');
    const december = calculateEntry(input({ periodStart: '2026-12-01', periodEnd: '2026-12-31', rates, sessions }));
    expect(december.components).toEqual([]);
    expect(december.net.toFixed(2)).toBe('0.00');
  });

  it('فترة بلا دوام: لا بنود وصافي صفر', () => {
    const result = calculateEntry(input({ rates: [rate('HOURLY', 20)] }));
    expect(result.components).toEqual([]);
    expect(totals(result)).toEqual({ gross: '0.00', deductions: '0.00', net: '0.00' });
    expect(result.warnings).toEqual([]);
  });

  it('دوام في يوم بلا أجر سارٍ: تحذير مانع ولا يُحتسب', () => {
    const result = calculateEntry(input({ rates: [rate('HOURLY', 20, '2026-11-10')], sessions: [session('2026-11-05', 60)] }));
    expect(result.net.toFixed(2)).toBe('0.00');
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'NO_RATE', blocking: true, date: '2026-11-05' })]);
  });
});

describe('الأجر اليومي', () => {
  it('كامل: أجر يوم واحد لكل يوم عمل مهما تعددت الورديات', () => {
    // 3 أيام عمل (أحدها بورديتين) × 100 = 300.00
    const result = calculateEntry(
      input({
        rates: [rate('DAILY', 100)],
        policies: [policy({ dailyPayMode: 'FULL' })],
        sessions: [session('2026-11-01', 200), session('2026-11-01', 250), session('2026-11-02', 30), session('2026-11-07', 600)],
      }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:300.00']);
    expect(result.components[0].quantity?.toString()).toBe('3');
  });

  it('نسبي: الساعات ÷ الساعات المرجعية للموظف (لا تُفترض 8)', () => {
    // (360 + 500) دقيقة ÷ (8 × 60) × 100 = 179.1667 → 179.17
    const eight = calculateEntry(
      input({
        rates: [rate('DAILY', 100)],
        policies: [policy({ dailyPayMode: 'PROPORTIONAL', referenceDailyHours: dec(8) })],
        sessions: [session('2026-11-01', 360), session('2026-11-02', 500)],
      }),
    );
    expect(amounts(eight)).toEqual(['REGULAR_WAGE:179.17']);
    // الدوام نفسه بيوم مرجعي 7.5 ساعة: 860 ÷ 450 × 100 = 191.1111 → 191.11
    const sevenHalf = calculateEntry(
      input({
        rates: [rate('DAILY', 100)],
        policies: [policy({ dailyPayMode: 'PROPORTIONAL', referenceDailyHours: dec('7.5') })],
        sessions: [session('2026-11-01', 360), session('2026-11-02', 500)],
      }),
    );
    expect(amounts(sevenHalf)).toEqual(['REGULAR_WAGE:191.11']);
  });

  it('تغير السياسة من كامل إلى نسبي أثناء الفترة', () => {
    // 5 نوفمبر (كامل): 100.00 · 20 نوفمبر (نسبي 8 ساعات، 240 دقيقة): 50.00
    const result = calculateEntry(
      input({
        rates: [rate('DAILY', 100)],
        policies: [
          policy({ dailyPayMode: 'FULL', to: '2026-11-15' }),
          policy({ dailyPayMode: 'PROPORTIONAL', referenceDailyHours: dec(8), from: '2026-11-16' }),
        ],
        sessions: [session('2026-11-05', 240), session('2026-11-20', 240)],
      }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:100.00', 'REGULAR_WAGE:50.00']);
  });

  it('أجر يومي دون سياسة سارية: تحذير مانع', () => {
    const result = calculateEntry(input({ rates: [rate('DAILY', 100)], sessions: [session('2026-11-05', 240)] }));
    expect(result.net.toFixed(2)).toBe('0.00');
    expect(result.warnings[0]).toMatchObject({ code: 'NO_POLICY', blocking: true });
  });
});

describe('الراتب الشهري', () => {
  const monthlyInput = (periodStart: string, periodEnd: string, extra: Partial<CalcInput> = {}) =>
    input({
      periodStart,
      periodEnd,
      rates: [rate('MONTHLY', 3000)],
      policies: [policy({ absenceDeductionMethod: 'ACTUAL_MONTH_DAYS' })],
      ...extra,
    });

  it('الشهر الكامل = الراتب كما هو مهما كان طول الشهر (28، 29 كبيسة، 30، 31) ودون أي دوام', () => {
    for (const [start, end] of [
      ['2026-02-01', '2026-02-28'],
      ['2028-02-01', '2028-02-29'],
      ['2026-11-01', '2026-11-30'],
      ['2026-12-01', '2026-12-31'],
    ]) {
      const result = calculateEntry(monthlyInput(start, end));
      expect([start, amounts(result)]).toEqual([start, ['REGULAR_WAGE:3000.00']]);
    }
  });

  it('راتب لا يقبل القسمة يبقى كما هو للشهر الكامل', () => {
    const result = calculateEntry(monthlyInput('2026-12-01', '2026-12-31', { rates: [rate('MONTHLY', '2999.99')] }));
    expect(result.net.toFixed(2)).toBe('2999.99');
  });

  it('فترتان نصف شهريتان: بنسبة أيام التقويم', () => {
    // ديسمبر 31 يومًا، راتب 3100: 15 ÷ 31 × 3100 = 1500.00 · 16 ÷ 31 × 3100 = 1600.00
    const rates = [rate('MONTHLY', 3100)];
    expect(calculateEntry(monthlyInput('2026-12-01', '2026-12-15', { rates })).net.toFixed(2)).toBe('1500.00');
    expect(calculateEntry(monthlyInput('2026-12-16', '2026-12-31', { rates })).net.toFixed(2)).toBe('1600.00');
    // فبراير الكبيسة 2028 (29 يومًا)، راتب 3000: 15 ÷ 29 = 1551.7241 → 1551.72 · 14 ÷ 29 = 1448.2759 → 1448.28
    expect(calculateEntry(monthlyInput('2028-02-01', '2028-02-15')).net.toFixed(2)).toBe('1551.72');
    expect(calculateEntry(monthlyInput('2028-02-16', '2028-02-29')).net.toFixed(2)).toBe('1448.28');
  });

  it('أسبوع يمتد على شهرين: كل يوم بنسبة شهره', () => {
    // السبت 28 نوفمبر → الجمعة 4 ديسمبر: 3 ÷ 30 × 3000 = 300.00 · 4 ÷ 31 × 3000 = 387.0968 → 387.10
    const result = calculateEntry(monthlyInput('2026-11-28', '2026-12-04'));
    expect(amounts(result)).toEqual(['REGULAR_WAGE:300.00', 'REGULAR_WAGE:387.10']);
  });

  it('تغير الراتب أثناء الشهر (فبراير كبيسة)', () => {
    // 14 ÷ 29 × 3000 = 1448.2759 → 1448.28 · 15 ÷ 29 × 3300 = 1706.8966 → 1706.90
    const result = calculateEntry(
      monthlyInput('2028-02-01', '2028-02-29', {
        rates: [rate('MONTHLY', 3000, '2027-01-01', '2028-02-14'), rate('MONTHLY', 3300, '2028-02-15')],
      }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:1448.28', 'REGULAR_WAGE:1706.90']);
    expect(result.net.toFixed(2)).toBe('3155.18');
  });

  it('بداية الأجر أو إنهاء العمل أثناء الشهر', () => {
    // يبدأ الأجر 16 نوفمبر: 15 ÷ 30 × 3000 = 1500.00
    const started = calculateEntry(monthlyInput('2026-11-01', '2026-11-30', { rates: [rate('MONTHLY', 3000, '2026-11-16')] }));
    expect(started.net.toFixed(2)).toBe('1500.00');
    // انتهى العمل 10 ديسمبر، راتب 3100: 10 ÷ 31 × 3100 = 1000.00
    const ended = calculateEntry(
      monthlyInput('2026-12-01', '2026-12-31', { rates: [rate('MONTHLY', 3100)], employmentEnd: '2026-12-10' }),
    );
    expect(ended.net.toFixed(2)).toBe('1000.00');
  });

  describe('خصم الغياب غير المدفوع (ديسمبر 2026، راتب 3100، غياب الأحد 6 → الثلاثاء 8)', () => {
    const december = (method: PolicyInput['absenceDeductionMethod'], extra: Partial<CalcInput> = {}, fixedMonthDays: number | null = null) =>
      calculateEntry(
        input({
          periodStart: '2026-12-01',
          periodEnd: '2026-12-31',
          rates: [rate('MONTHLY', 3100)],
          policies: [policy({ absenceDeductionMethod: method, fixedMonthDays })],
          leaves: [leave('2026-12-06', '2026-12-08')],
          ...extra,
        }),
      );

    it('أيام الشهر الفعلية: 3 × 3100 ÷ 31 = 300.00', () => {
      const result = december('ACTUAL_MONTH_DAYS');
      expect(amounts(result)).toEqual(['REGULAR_WAGE:3100.00', 'ABSENCE_DEDUCTION:-300.00']);
      expect(totals(result)).toEqual({ gross: '3100.00', deductions: '300.00', net: '2800.00' });
    });

    it('عدد أيام ثابت (30): 3 × 3100 ÷ 30 = 310.00', () => {
      const result = december('FIXED_DAYS', {}, 30);
      expect(totals(result)).toEqual({ gross: '3100.00', deductions: '310.00', net: '2790.00' });
    });

    it('أيام العمل المجدولة (27 يومًا: 31 − 4 جُمَع): 3 × 3100 ÷ 27 = 344.4444 → 344.44', () => {
      const result = december('SCHEDULED_WORK_DAYS', { schedules: [SAT_TO_THU] });
      expect(totals(result)).toEqual({ gross: '3100.00', deductions: '344.44', net: '2755.56' });
    });

    it('يوم الراحة ضمن الغياب لا يُخصم (الخميس 10 → السبت 12: يومان فقط)', () => {
      // الجمعة 11 راحة: 2 × 3100 ÷ 31 = 200.00
      const result = december('ACTUAL_MONTH_DAYS', { schedules: [SAT_TO_THU], leaves: [leave('2026-12-10', '2026-12-12')] });
      expect(result.deductions.toFixed(2)).toBe('200.00');
      expect(result.components[1].quantity?.toString()).toBe('2');
    });

    it('ورديات مجدولة بتاريخ محدد (جدول متغير) تحدد أيام العمل', () => {
      // 20 وردية مجدولة في الشهر، والغياب يغطي اثنتين منها (6 و8): 2 × 3100 ÷ 20 = 310.00
      const shiftDates = Array.from({ length: 20 }, (_, i) => `2026-12-${String(i < 2 ? [6, 8][i] : i + 10).padStart(2, '0')}`);
      const result = december('SCHEDULED_WORK_DAYS', { scheduledShiftDates: shiftDates });
      expect(result.deductions.toFixed(2)).toBe('310.00');
    });

    it('«أيام العمل المجدولة» دون جدول: تحذير مانع ولا خصم', () => {
      const result = december('SCHEDULED_WORK_DAYS');
      expect(result.deductions.toFixed(2)).toBe('0.00');
      // تحذير لكل يوم غياب تعذر خصمه
      expect(result.warnings.map((w) => [w.code, w.blocking, w.date])).toEqual([
        ['NO_SCHEDULE_FOR_DEDUCTION', true, '2026-12-06'],
        ['NO_SCHEDULE_FOR_DEDUCTION', true, '2026-12-07'],
        ['NO_SCHEDULE_FOR_DEDUCTION', true, '2026-12-08'],
      ]);
      // الجدول المرن لا يُعد التزام عمل
      const flexible = december('SCHEDULED_WORK_DAYS', { schedules: [{ ...SAT_TO_THU, isFlexible: true }] });
      expect(flexible.warnings[0].code).toBe('NO_SCHEDULE_FOR_DEDUCTION');
    });

    it('الإجازة المدفوعة لا تُخصم، ولا خصم دون سجل غياب معتمد حتى لو لم يحضر', () => {
      const paid = december('ACTUAL_MONTH_DAYS', { leaves: [leave('2026-12-06', '2026-12-08', false)] });
      expect(totals(paid)).toEqual({ gross: '3100.00', deductions: '0.00', net: '3100.00' });
      const noRecords = december('ACTUAL_MONTH_DAYS', { leaves: [], schedules: [SAT_TO_THU] });
      expect(noRecords.net.toFixed(2)).toBe('3100.00');
    });

    it('غياب يمتد خارج الفترة: يُخصم ما يقع داخلها فقط', () => {
      // غياب 29 نوفمبر → 2 ديسمبر، فترة ديسمبر: يومان × 3100 ÷ 31 = 200.00
      const result = december('ACTUAL_MONTH_DAYS', { leaves: [leave('2026-11-29', '2026-12-02')] });
      expect(result.deductions.toFixed(2)).toBe('200.00');
    });

    it('الخصم لا يتجاوز الراتب المستحق (عدد ثابت 26 وغياب الشهر كله)', () => {
      // 31 × 3100 ÷ 26 = 3696.15 > 3100 → يُحد عند 3100.00
      const result = december('FIXED_DAYS', { leaves: [leave('2026-12-01', '2026-12-31')] }, 26);
      expect(totals(result)).toEqual({ gross: '3100.00', deductions: '3100.00', net: '0.00' });
      expect(result.warnings).toEqual([expect.objectContaining({ code: 'ABSENCE_CAPPED', blocking: false })]);
    });
  });

  it('الغياب لا يخصم من أجر الساعة أو اليوم (يُدفع العمل الفعلي فقط)', () => {
    const result = calculateEntry(
      input({ rates: [rate('HOURLY', 20)], sessions: [session('2026-11-02', 60)], leaves: [leave('2026-11-03', '2026-11-05')] }),
    );
    expect(totals(result)).toEqual({ gross: '20.00', deductions: '0.00', net: '20.00' });
  });
});

describe('العمل الإضافي', () => {
  const day = '2026-11-03';

  it('إضافي معتمد بالمعامل: لا تُحتسب الدقائق نفسها عاديًّا وإضافيًّا', () => {
    // 600 دقيقة منها 120 إضافي: عادي 480 × 20 ÷ 60 = 160.00 · إضافي 120 × 20 × 1.5 ÷ 60 = 60.00
    const result = calculateEntry(input({ rates: [rate('HOURLY', 20)], sessions: [session(day, 600)], overtime: [overtime(day, 120)] }));
    expect(amounts(result)).toEqual(['REGULAR_WAGE:160.00', 'OVERTIME:60.00']);
    expect(result.net.toFixed(2)).toBe('220.00');
    expect(result.days[0]).toMatchObject({ workedMinutes: 600, regularMinutes: 480, overtimeApprovedMinutes: 120, overtimeExcludedMinutes: 0 });
  });

  it('إضافي غير معتمد (مكتشف/بانتظار/مرفوض) لا يدخل الراتب لا عاديًّا ولا إضافيًّا', () => {
    for (const status of ['DETECTED', 'PENDING_APPROVAL', 'REJECTED'] as const) {
      const result = calculateEntry(
        input({ rates: [rate('HOURLY', 20)], sessions: [session(day, 600)], overtime: [overtime(day, 120, { status })] }),
      );
      expect([status, amounts(result)]).toEqual([status, ['REGULAR_WAGE:160.00']]);
      expect(result.days[0]).toMatchObject({ regularMinutes: 480, overtimeApprovedMinutes: 0, overtimeExcludedMinutes: 120 });
    }
  });

  it('معامل خاص بالموظف وسعر إضافي خاص', () => {
    // معامل 2: 90 × 20 × 2 ÷ 60 = 60.00 · سعر خاص 35: 90 × 35 ÷ 60 = 52.50 (يتجاوز المعامل)
    const withMultiplier = calculateEntry(
      input({ rates: [rate('HOURLY', 20)], sessions: [session(day, 570)], overtime: [overtime(day, 90, { multiplier: dec(2) })] }),
    );
    expect(amounts(withMultiplier)).toEqual(['REGULAR_WAGE:160.00', 'OVERTIME:60.00']);
    const special = calculateEntry(
      input({
        rates: [rate('HOURLY', 20)],
        sessions: [session(day, 570)],
        overtime: [overtime(day, 90, { specialHourlyRate: dec(35), multiplier: dec(2) })],
      }),
    );
    expect(amounts(special)).toEqual(['REGULAR_WAGE:160.00', 'OVERTIME:52.50']);
  });

  it('أجر يومي: سعر ساعة الإضافي = الأجر اليومي ÷ الساعات المرجعية', () => {
    // يوم كامل 120.00 + إضافي 60 دقيقة × (120 ÷ 8) × 1.5 ÷ 60 = 22.50
    const result = calculateEntry(
      input({
        rates: [rate('DAILY', 120)],
        policies: [policy({ dailyPayMode: 'FULL', referenceDailyHours: dec(8) })],
        sessions: [session(day, 540)],
        overtime: [overtime(day, 60)],
      }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:120.00', 'OVERTIME:22.50']);
  });

  it('راتب شهري أو يومي بلا ساعات مرجعية: الإضافي يتطلب سعرًا خاصًا وإلا تحذير مانع', () => {
    const base = { rates: [rate('MONTHLY', 3000)], policies: [policy({ absenceDeductionMethod: 'ACTUAL_MONTH_DAYS' as const })], sessions: [session(day, 600)] };
    const unknown = calculateEntry(input({ ...base, overtime: [overtime(day, 120)] }));
    expect(amounts(unknown)).toEqual(['REGULAR_WAGE:3000.00']);
    expect(unknown.warnings).toEqual([expect.objectContaining({ code: 'OVERTIME_RATE_UNKNOWN', blocking: true })]);
    // بسعر خاص 25: 120 × 25 ÷ 60 = 50.00
    const special = calculateEntry(input({ ...base, overtime: [overtime(day, 120, { specialHourlyRate: dec(25) })] }));
    expect(amounts(special)).toEqual(['REGULAR_WAGE:3000.00', 'OVERTIME:50.00']);
    expect(special.warnings).toEqual([]);
  });
});

describe('المكافآت والخصومات وفروقات الرواتب', () => {
  it('تُضاف بإشارتها الصحيحة وتُفصل في الإجمالي والخصومات', () => {
    // إجمالي: 160.00 أجر + 100.00 مكافأة = 260.00 · خصومات: 30.00 + 20.50 = 50.50 · صافي 209.50
    const result = calculateEntry(
      input({
        rates: [rate('HOURLY', 20)],
        sessions: [session('2026-11-03', 480)],
        adjustments: [
          { id: 'a1', type: 'BONUS', amount: dec(100), reason: 'مكافأة أداء' },
          { id: 'a2', type: 'DEDUCTION', amount: dec(30), reason: 'عجز صندوق' },
          { id: 'a3', type: 'WAGE_DIFFERENCE', amount: dec('-20.5'), reason: 'تصحيح أكتوبر' },
        ],
      }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:160.00', 'BONUS:100.00', 'DEDUCTION:-30.00', 'ADJUSTMENT:-20.50']);
    expect(totals(result)).toEqual({ gross: '260.00', deductions: '50.50', net: '209.50' });
  });

  it('صافٍ سالب: تحذير مانع', () => {
    const result = calculateEntry(
      input({ rates: [rate('HOURLY', 20)], adjustments: [{ id: 'a1', type: 'DEDUCTION', amount: dec(50), reason: 'خصم' }] }),
    );
    expect(result.net.toFixed(2)).toBe('-50.00');
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'NEGATIVE_NET', blocking: true })]);
  });
});

describe('تغير نوع الأجر أثناء الفترة', () => {
  it('من ساعة إلى شهري في منتصف الشهر', () => {
    // 1–15 نوفمبر بالساعة: 600 دقيقة × 20 ÷ 60 = 200.00 · 16–30 شهري 3000: 15 ÷ 30 = 1500.00
    const result = calculateEntry(
      input({
        rates: [rate('HOURLY', 20, '2026-01-01', '2026-11-15'), rate('MONTHLY', 3000, '2026-11-16')],
        policies: [policy({ to: '2026-11-15' }), policy({ absenceDeductionMethod: 'ACTUAL_MONTH_DAYS', from: '2026-11-16' })],
        sessions: [session('2026-11-10', 600), session('2026-11-20', 480)],
      }),
    );
    expect(amounts(result)).toEqual(['REGULAR_WAGE:200.00', 'REGULAR_WAGE:1500.00']);
  });
});

describe('حدود فترات الرواتب', () => {
  it('أسبوعية تبدأ السبت', () => {
    // الأربعاء 11 نوفمبر 2026 ← السبت 7 → الجمعة 13
    expect(resolvePayrollPeriod('WEEKLY', '2026-11-11', 6)).toMatchObject({ start: '2026-11-07', end: '2026-11-13' });
    expect(resolvePayrollPeriod('WEEKLY', '2026-11-07', 6)).toMatchObject({ start: '2026-11-07', end: '2026-11-13' });
    expect(resolvePayrollPeriod('WEEKLY', '2026-11-13', 6)).toMatchObject({ start: '2026-11-07', end: '2026-11-13' });
    // أسبوع يعبر نهاية السنة: الخميس 31 ديسمبر 2026 ← السبت 26 → الجمعة 1 يناير 2027
    expect(resolvePayrollPeriod('WEEKLY', '2026-12-31', 6)).toMatchObject({ start: '2026-12-26', end: '2027-01-01' });
    // بداية أسبوع مختلفة من الإعدادات (الأحد = 0)
    expect(resolvePayrollPeriod('WEEKLY', '2026-11-11', 0)).toMatchObject({ start: '2026-11-08', end: '2026-11-14' });
  });

  it('نصف شهرية: 1–15 و16–آخر الشهر (مع فبراير الكبيسة)', () => {
    expect(resolvePayrollPeriod('SEMI_MONTHLY', '2026-11-15', 6)).toEqual({ start: '2026-11-01', end: '2026-11-15', label: 'النصف الأول من نوفمبر 2026' });
    expect(resolvePayrollPeriod('SEMI_MONTHLY', '2026-11-16', 6)).toEqual({ start: '2026-11-16', end: '2026-11-30', label: 'النصف الثاني من نوفمبر 2026' });
    expect(resolvePayrollPeriod('SEMI_MONTHLY', '2028-02-20', 6)).toMatchObject({ start: '2028-02-16', end: '2028-02-29' });
    expect(resolvePayrollPeriod('SEMI_MONTHLY', '2026-02-20', 6)).toMatchObject({ start: '2026-02-16', end: '2026-02-28' });
  });

  it('شهرية: الشهر الميلادي كاملًا', () => {
    expect(resolvePayrollPeriod('MONTHLY', '2026-10-17', 6)).toEqual({ start: '2026-10-01', end: '2026-10-31', label: 'أكتوبر 2026' });
    expect(resolvePayrollPeriod('MONTHLY', '2028-02-29', 6)).toMatchObject({ start: '2028-02-01', end: '2028-02-29' });
  });
});
