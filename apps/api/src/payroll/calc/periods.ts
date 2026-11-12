import { addIsoDays, dayOfWeek, monthEnd, monthKey, monthLabel } from './iso-dates';
import type { IsoDate, PayrollFrequency } from './types';

export interface PeriodBounds {
  start: IsoDate;
  end: IsoDate;
  label: string;
}

/**
 * حدود فترة الرواتب التي يقع فيها التاريخ:
 *  - أسبوعية: سبعة أيام تبدأ بيوم بداية الأسبوع من الإعدادات (افتراضيًا السبت = 6).
 *  - نصف شهرية: 1–15 و16–آخر الشهر.
 *  - شهرية: الشهر الميلادي كاملًا.
 * الحدود مشتقة من التاريخ دائمًا، فلا تتداخل فترتان من التكرار نفسه.
 */
export function resolvePayrollPeriod(frequency: PayrollFrequency, date: IsoDate, weekStartsOn: number): PeriodBounds {
  const month = monthKey(date);
  if (frequency === 'WEEKLY') {
    const start = addIsoDays(date, -((dayOfWeek(date) - weekStartsOn + 7) % 7));
    const end = addIsoDays(start, 6);
    return { start, end, label: `أسبوع ${start} – ${end}` };
  }
  if (frequency === 'SEMI_MONTHLY') {
    const firstHalf = Number(date.slice(8, 10)) <= 15;
    return firstHalf
      ? { start: `${month}-01`, end: `${month}-15`, label: `النصف الأول من ${monthLabel(month)}` }
      : { start: `${month}-16`, end: monthEnd(month), label: `النصف الثاني من ${monthLabel(month)}` };
  }
  return { start: `${month}-01`, end: monthEnd(month), label: monthLabel(month) };
}
