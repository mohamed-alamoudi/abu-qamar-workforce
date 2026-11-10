import { addDays, formatDateOnly, parseDateOnly, todayInZone } from './dates';

describe('التواريخ المحلية', () => {
  it('parseDateOnly يقبل الصيغة الصحيحة فقط ويرفض التواريخ المستحيلة', () => {
    expect(parseDateOnly('2026-03-01')?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(parseDateOnly('2028-02-29')).not.toBeNull();
    for (const bad of ['2026-02-30', '2026-13-01', '2026-3-1', '01/03/2026', '', '2026-03-01T10:00:00Z']) {
      expect(parseDateOnly(bad)).toBeNull();
    }
  });

  it('todayInZone يعيد تاريخ اليوم المحلي لا تاريخ UTC', () => {
    // 22:30 UTC يوم 10 = 00:30 يوم 11 في غزة
    expect(formatDateOnly(todayInZone('Asia/Gaza', new Date('2026-11-10T22:30:00Z')))).toBe('2026-11-11');
    expect(formatDateOnly(todayInZone('Asia/Gaza', new Date('2026-11-10T21:30:00Z')))).toBe('2026-11-10');
    expect(formatDateOnly(todayInZone('America/New_York', new Date('2026-11-10T02:00:00Z')))).toBe('2026-11-09');
    expect(() => todayInZone('Mars/Olympus')).toThrow();
  });

  it('addDays يعبر حدود الشهر والسنة', () => {
    expect(formatDateOnly(addDays(parseDateOnly('2026-03-01')!, -1))).toBe('2026-02-28');
    expect(formatDateOnly(addDays(parseDateOnly('2026-12-31')!, 1))).toBe('2027-01-01');
  });
});
