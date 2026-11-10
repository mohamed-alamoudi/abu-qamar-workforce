import { DateTime } from 'luxon';
import type { DashboardPeriod } from '@abu-qamar/shared';

export interface PeriodRange {
  /** بداية الفترة (شاملة) بتوقيت UTC */
  start: Date;
  /** نهاية الفترة (غير شاملة) بتوقيت UTC */
  end: Date;
}

/**
 * حدود اليوم/الأسبوع/الشهر في المنطقة الزمنية المحلية، محوّلة إلى UTC.
 * الحساب عبر luxon يراعي تغيّر التوقيت الصيفي (اليوم قد يكون 23 أو 25 ساعة).
 * @param weekStartsOn ترقيم JavaScript: 0 = الأحد … 6 = السبت
 */
export function resolvePeriodRange(period: DashboardPeriod, timezone: string, weekStartsOn: number, now = new Date()): PeriodRange {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) throw new Error(`منطقة زمنية غير صالحة: ${timezone}`);
  const dayStart = local.startOf('day');

  let start: DateTime;
  let end: DateTime;
  if (period === 'day') {
    start = dayStart;
    end = dayStart.plus({ days: 1 });
  } else if (period === 'week') {
    // luxon: الاثنين = 1 … الأحد = 7 → نحوله إلى ترقيم JavaScript
    const jsWeekday = dayStart.weekday % 7;
    const daysSinceStart = (jsWeekday - weekStartsOn + 7) % 7;
    start = dayStart.minus({ days: daysSinceStart });
    end = start.plus({ days: 7 });
  } else {
    start = dayStart.startOf('month');
    end = start.plus({ months: 1 });
  }
  return { start: start.toUTC().toJSDate(), end: end.toUTC().toJSDate() };
}
