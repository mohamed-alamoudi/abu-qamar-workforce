import { computeWorkedMinutes, localDateOf, parseInstant } from './attendance-math';
import { computeWeekOvertime } from '../overtime/overtime-math';

describe('حساب دقائق العمل', () => {
  it('يحتسب الدقائق الكاملة بعد خصم الاستراحة غير المدفوعة فقط', () => {
    const time = (value: string) => new Date('2026-03-01T' + value + 'Z');
    expect(computeWorkedMinutes(time('08:00:40'), time('09:01:00'), [
      { startAt: time('08:15:00'), endAt: time('08:15:30'), isPaid: false },
      { startAt: time('08:20:00'), endAt: time('08:30:00'), isPaid: true },
    ])).toBe(59);
  });

  it('يحسب الزمن المنقضي عند تقديم الساعة وتأخيرها', () => {
    const zone = 'America/New_York';
    expect(parseInstant('2026-03-08T02:30', zone)).toBeNull();
    expect(parseInstant('2026-11-01T01:30', zone)).toBeNull();
    expect(parseInstant('2026-11-01T01:30-04:00', zone)?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    const at = (value: string) => parseInstant(value, zone)!;
    expect(computeWorkedMinutes(at('2026-03-08T01:30'), at('2026-03-08T03:30'), [])).toBe(60);
    expect(computeWorkedMinutes(at('2026-11-01T00:30'), at('2026-11-01T02:30'), [])).toBe(180);
    expect(localDateOf(new Date('2026-01-01T22:30Z'), 'Asia/Gaza').toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('لا يحتسب الدقائق الإضافية اليومية مرة أخرى في الحد الأسبوعي', () => {
    const common = { dailyThresholdMinutes: 480, weeklyThresholdMinutes: 900 };
    const result = computeWeekOvertime([
      { ...common, date: '2026-03-01', workedMinutes: 540 },
      { ...common, date: '2026-03-02', workedMinutes: 500 },
    ]);
    expect([...result.values()]).toEqual([60, 80]);
  });
});
