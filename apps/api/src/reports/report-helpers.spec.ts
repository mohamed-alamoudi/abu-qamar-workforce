import { parseDateOnly } from '../common/utils/dates';
import { visualRuns } from './export/bidi';
import { computeTimings, parseWeeklyPattern } from './lateness';
import { moneyText, sumIntColumns } from './report-context';
import { buildRange, overlapDays } from './report-range';
import { Prisma } from '@abu-qamar/database';

const day = (text: string) => parseDateOnly(text)!;
const instant = (text: string) => new Date(text);

describe('أدوات التقارير', () => {
  it('يحسب حدود اليوم المحلي ونهاية حصرية ويتعامل مع تغير التوقيت الصيفي', () => {
    const winter = buildRange(day('2026-01-15'), day('2026-01-15'), 'Asia/Gaza');
    expect(winter.startInstant.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(winter.endInstant.toISOString()).toBe('2026-01-15T22:00:00.000Z');
    const spring = buildRange(day('2026-03-29'), day('2026-03-29'), 'Europe/Berlin');
    expect(spring.endInstant.getTime() - spring.startInstant.getTime()).toBe(23 * 3_600_000);
    expect(overlapDays(day('2026-01-13'), day('2026-01-16'), winter.from, winter.to)).toBe(1);
  });

  it('يحسب التأخير لأول جزء من الوردية فقط ويستثني الموظف بلا جدول', () => {
    const workDate = day('2026-01-15');
    const sessions = [
      { id: 'first', employeeId: 'e', workDate, checkInAt: instant('2026-01-15T06:11Z'), checkOutAt: instant('2026-01-15T09:00Z') },
      { id: 'last', employeeId: 'e', workDate, checkInAt: instant('2026-01-15T10:00Z'), checkOutAt: instant('2026-01-15T13:52Z') },
      { id: 'none', employeeId: 'f', workDate, checkInAt: instant('2026-01-15T06:11Z'), checkOutAt: null },
    ];
    const pattern = parseWeeklyPattern([{ day: 4, start: '08:00', end: '16:00' }, { day: 9, start: '08:00', end: '16:00' }]);
    expect(pattern).toHaveLength(1);
    const timings = computeTimings(sessions, new Map(), new Map([
      ['e', [{ pattern, isFlexible: false, effectiveFrom: workDate, effectiveTo: null }]],
    ]), 'Asia/Gaza');
    expect(timings.get('first')).toMatchObject({ lateMinutes: 11, earlyLeaveMinutes: null });
    expect(timings.get('last')).toMatchObject({ lateMinutes: null, earlyLeaveMinutes: 8 });
    expect(timings.get('none')).toEqual({ scheduledStart: null, lateMinutes: null, earlyLeaveMinutes: null });
  });

  it('يجمع الدقائق الصحيحة ويحفظ دقة المبالغ', () => {
    expect(sumIntColumns([{ minutes: 14 }, { minutes: null }, { minutes: 16 }], ['minutes'])).toEqual({ minutes: 30 });
    expect(moneyText(new Prisma.Decimal('0.10').plus('0.20'))).toBe('0.30');
  });

  it('يحافظ على ترتيب الأرقام والحروف اللاتينية وسط العربية', () => {
    const runs = visualRuns('تقرير EMP-123 للموظف');
    expect(runs.map((run) => run.text.trim())).toEqual(['للموظف', 'EMP-123', 'تقرير']);
  });
});
