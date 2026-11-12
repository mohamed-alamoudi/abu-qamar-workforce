import { DateTime } from 'luxon';

/**
 * حسابات الدوام البحتة (بلا قاعدة بيانات) — كلها بالدقيقة الصحيحة دون تقريب.
 *
 * تُحسب المدة من اللحظات الفعلية في UTC، وتُسقط الثواني المتبقية من المدة الصافية.
 */

export const MINUTE_MS = 60_000;
/** أقصى مدة لوردية واحدة — حاجز ضد أخطاء إدخال التاريخ (يوم بدل يوم آخر). */
export const MAX_SESSION_MINUTES = 24 * 60;

export interface Interval {
  startAt: Date;
  endAt: Date;
}

export interface BreakInterval {
  startAt: Date;
  /** null = استراحة ما زالت مفتوحة */
  endAt: Date | null;
  isPaid: boolean;
}

/** يحذف الثواني وأجزاءها: 08:00:59.999 → 08:00:00.000 */
export function truncateToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** الدقائق الكاملة بين لحظتين (0 إن كانت النهاية قبل البداية). */
export function minutesBetween(startAt: Date, endAt: Date): number {
  return Math.max(0, Math.floor((endAt.getTime() - startAt.getTime()) / MINUTE_MS));
}

/** التاريخ المحلي (في المنطقة الزمنية للنظام) للحظة معيّنة، ممثَّلًا كـ Date عند منتصف الليل UTC. */
export function localDateOf(instant: Date, timezone: string): Date {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  if (!local.isValid) throw new Error(`منطقة زمنية غير صالحة: ${timezone}`);
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * يحوّل وقتًا مُدخلًا إلى لحظة:
 *  - نص بإزاحة صريحة (`...Z` أو `+02:00`) يُؤخذ كما هو.
 *  - نص محلي بلا إزاحة (`2026-11-11T08:00`) يُفسَّر في المنطقة الزمنية للنظام.
 * يعيد null إن كان النص غير صالح (تاريخ مستحيل أو صيغة أخرى).
 */
export function parseInstant(value: string, timezone: string): Date | null {
  const text = value.trim();
  if (WITH_OFFSET.test(text)) {
    const parsed = DateTime.fromISO(text, { setZone: true });
    return parsed.isValid ? parsed.toJSDate() : null;
  }
  if (LOCAL_DATE_TIME.test(text)) {
    const parsed = DateTime.fromISO(text, { zone: timezone });
    // Luxon قد يقدّم ساعة غير موجودة أو يختار إحدى إزاحتي ساعة مكررة.
    if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== text.slice(0, 16)) return null;
    return parsed.getPossibleOffsets().length === 1 ? parsed.toJSDate() : null;
  }
  return null;
}

/** يدمج الفترات المتداخلة أو المتلاصقة حتى لا تُحسب الدقيقة نفسها مرتين. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.endAt.getTime() > i.startAt.getTime())
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.startAt.getTime() <= last.endAt.getTime()) {
      if (current.endAt.getTime() > last.endAt.getTime()) last.endAt = current.endAt;
    } else {
      merged.push({ startAt: current.startAt, endAt: current.endAt });
    }
  }
  return merged;
}

/** دقائق الاستراحات من نوع معيّن داخل حدود الوردية (ما يقع خارجها يُقصّ). */
function breakMilliseconds(checkInAt: Date, checkOutAt: Date, breaks: BreakInterval[], paid: boolean): number {
  const clipped = breaks
    .filter((b) => b.isPaid === paid)
    .map((b) => ({
      startAt: new Date(Math.max(b.startAt.getTime(), checkInAt.getTime())),
      endAt: new Date(Math.min((b.endAt ?? checkOutAt).getTime(), checkOutAt.getTime())),
    }));
  return mergeIntervals(clipped).reduce((sum, i) => sum + (i.endAt.getTime() - i.startAt.getTime()), 0);
}

/**
 * الدقائق المستحقة = الدقائق الفعلية بين الحضور والانصراف − الاستراحات غير المدفوعة.
 * الاستراحة المدفوعة لا تُخصم.
 */
export function computeWorkedMinutes(checkInAt: Date, checkOutAt: Date, breaks: BreakInterval[]): number {
  const gross = checkOutAt.getTime() - checkInAt.getTime();
  const net = gross - breakMilliseconds(checkInAt, checkOutAt, breaks, false);
  return Math.max(0, Math.floor(net / MINUTE_MS));
}

/** هل تتداخل فترتان نصف مفتوحتين [بداية، نهاية)؟ النهاية null تعني «ما زالت مفتوحة». */
export function intervalsOverlap(aStart: Date, aEnd: Date | null, bStart: Date, bEnd: Date | null): boolean {
  const aEndMs = aEnd ? aEnd.getTime() : Number.POSITIVE_INFINITY;
  const bEndMs = bEnd ? bEnd.getTime() : Number.POSITIVE_INFINITY;
  return aStart.getTime() < bEndMs && bStart.getTime() < aEndMs;
}
