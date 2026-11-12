import { DateTime } from 'luxon';
import { addDays } from '../common/utils/dates';

/**
 * أدوات الفترة الزمنية للتقارير.
 *
 * التواريخ المحلية (workDate، بداية ونهاية الإجازة، فترات الرواتب) أعمدة `date` تُقارن مباشرة.
 * الأوقات (`timestamptz` مثل وقت الدفعة) تُقارن بحدود اليوم المحلي في منطقة الإعدادات:
 * من منتصف ليل يوم البداية (شامل) إلى منتصف ليل اليوم التالي ليوم النهاية (غير شامل)،
 * مع مراعاة التوقيت الصيفي (اليوم قد يكون 23 أو 25 ساعة).
 */

export interface ReportRange {
  /** أول يوم (Date عند منتصف الليل UTC — تمثيل التاريخ المحلي) */
  from: Date;
  /** آخر يوم (شامل) */
  to: Date;
  /** بداية أول يوم محليًا، محوّلة إلى لحظة UTC (شاملة) */
  startInstant: Date;
  /** بداية اليوم التالي لآخر يوم محليًا، محوّلة إلى لحظة UTC (غير شاملة) */
  endInstant: Date;
  timezone: string;
}

/** منتصف الليل المحلي لتاريخ معيّن → لحظة UTC. */
export function localMidnight(date: Date, timezone: string): Date {
  const local = DateTime.fromObject(
    { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    { zone: timezone },
  );
  if (!local.isValid) throw new Error(`منطقة زمنية غير صالحة: ${timezone}`);
  return local.toUTC().toJSDate();
}

export function buildRange(from: Date, to: Date, timezone: string): ReportRange {
  return {
    from,
    to,
    startInstant: localMidnight(from, timezone),
    endInstant: localMidnight(addDays(to, 1), timezone),
    timezone,
  };
}

/** أول يوم في الشهر المحلي الحالي. */
export function startOfLocalMonth(today: Date): Date {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
}

/** عدد الأيام بين تاريخين شاملًا الطرفين (0 إن كانت النهاية قبل البداية). */
export function inclusiveDays(from: Date, to: Date): number {
  const diff = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return diff > 0 ? diff : 0;
}

/** عدد أيام تقاطع فترتين من التواريخ (شاملتين). */
export function overlapDays(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): number {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  return inclusiveDays(from, to);
}

/** التاريخ المحلي ('YYYY-MM-DD') للحظة معيّنة. */
export function localDateOf(instant: Date, timezone: string): string {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  return local.toFormat('yyyy-MM-dd');
}

/** الدقائق الكاملة بين لحظتين دون تقريب للأعلى (لا سالب). */
export function wholeMinutes(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return ms > 0 ? Math.floor(ms / 60_000) : 0;
}
