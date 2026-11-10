import { resolvePeriodRange } from './period';

const TZ = 'Asia/Gaza';
const SATURDAY = 6;
const iso = (r: { start: Date; end: Date }) => [r.start.toISOString(), r.end.toISOString()];
const hours = (r: { start: Date; end: Date }) => (r.end.getTime() - r.start.getTime()) / 3_600_000;

describe('حدود فترات لوحة التحكم (Asia/Gaza)', () => {
  it('اليوم: من منتصف الليل المحلي إلى منتصف الليل التالي', () => {
    // 10 نوفمبر 2026، 10:00 UTC = 12:00 في غزة (توقيت شتوي UTC+2)
    const range = resolvePeriodRange('day', TZ, SATURDAY, new Date('2026-11-10T10:00:00Z'));
    expect(iso(range)).toEqual(['2026-11-09T22:00:00.000Z', '2026-11-10T22:00:00.000Z']);
  });

  it('لحظة بعد منتصف الليل المحلي تتبع اليوم المحلي الجديد لا يوم UTC', () => {
    // 22:30 UTC يوم 10 = 00:30 يوم 11 في غزة
    const range = resolvePeriodRange('day', TZ, SATURDAY, new Date('2026-11-10T22:30:00Z'));
    expect(iso(range)).toEqual(['2026-11-10T22:00:00.000Z', '2026-11-11T22:00:00.000Z']);
  });

  it('الأسبوع يبدأ السبت', () => {
    // الثلاثاء 10 نوفمبر 2026 → الأسبوع من السبت 7 إلى السبت 14
    const tuesday = resolvePeriodRange('week', TZ, SATURDAY, new Date('2026-11-10T10:00:00Z'));
    expect(iso(tuesday)).toEqual(['2026-11-06T22:00:00.000Z', '2026-11-13T22:00:00.000Z']);
    // السبت نفسه أول أيام أسبوعه، والجمعة آخر أيام الأسبوع السابق
    const saturday = resolvePeriodRange('week', TZ, SATURDAY, new Date('2026-11-07T10:00:00Z'));
    expect(iso(saturday)).toEqual(iso(tuesday));
    const friday = resolvePeriodRange('week', TZ, SATURDAY, new Date('2026-11-06T10:00:00Z'));
    expect(friday.end.toISOString()).toBe('2026-11-06T22:00:00.000Z');
  });

  it('بداية الأسبوع قابلة للتغيير (الأحد أو الاثنين)', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    expect(resolvePeriodRange('week', TZ, 0, now).start.toISOString()).toBe('2026-11-07T22:00:00.000Z');
    expect(resolvePeriodRange('week', TZ, 1, now).start.toISOString()).toBe('2026-11-08T22:00:00.000Z');
  });

  it('الشهر: من أول يوم إلى أول يوم في الشهر التالي، بما فيه فبراير ونهاية السنة', () => {
    expect(iso(resolvePeriodRange('month', TZ, SATURDAY, new Date('2026-02-15T10:00:00Z')))).toEqual([
      '2026-01-31T22:00:00.000Z',
      '2026-02-28T22:00:00.000Z',
    ]);
    expect(iso(resolvePeriodRange('month', TZ, SATURDAY, new Date('2026-12-31T21:00:00Z')))).toEqual([
      '2026-11-30T22:00:00.000Z',
      '2026-12-31T22:00:00.000Z',
    ]);
  });

  it('يراعي التوقيت الصيفي: في منطقة فيها تغيير يكون يوم الانتقال 23 أو 25 ساعة', () => {
    // Europe/Berlin: 29 مارس 2026 يوم 23 ساعة، و25 أكتوبر 2026 يوم 25 ساعة
    expect(hours(resolvePeriodRange('day', 'Europe/Berlin', 1, new Date('2026-03-29T12:00:00Z')))).toBe(23);
    expect(hours(resolvePeriodRange('day', 'Europe/Berlin', 1, new Date('2026-10-25T12:00:00Z')))).toBe(25);
    expect(hours(resolvePeriodRange('day', 'Europe/Berlin', 1, new Date('2026-06-10T12:00:00Z')))).toBe(24);
  });

  it('الأسبوع والشهر في غزة يحافظان على حدود منتصف الليل المحلي عبر تغيّر التوقيت', () => {
    for (const day of ['2026-03-27', '2026-03-28', '2026-03-29', '2026-10-23', '2026-10-24', '2026-10-25']) {
      const range = resolvePeriodRange('day', TZ, SATURDAY, new Date(`${day}T12:00:00Z`));
      const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      // بداية اليوم المحلي دائمًا 00:00 (أو 01:00 إن قفز التوقيت عند منتصف الليل تمامًا)
      expect(['00:00', '01:00']).toContain(fmt.format(range.start));
      expect([23, 24, 25]).toContain(hours(range));
    }
  });

  it('يرفض منطقة زمنية غير صالحة', () => {
    expect(() => resolvePeriodRange('day', 'Mars/Olympus', SATURDAY)).toThrow();
  });
});
