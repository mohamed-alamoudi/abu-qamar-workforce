import { DateTime } from 'luxon';
import { intervalsOverlap, minutesBetween } from '../attendance/attendance-math';
import { addDays, formatDateOnly } from '../common/utils/dates';

/**
 * حسابات الجداول البحتة: توسيع النمط الأسبوعي إلى ورديات بتواريخ فعلية،
 * ومقارنة الدوام الفعلي بالمجدول (التأخير والانصراف المبكر).
 */

/** وردية في النمط الأسبوعي. day بترقيم JavaScript: 0 = الأحد … 6 = السبت. الأوقات محلية «HH:mm». */
export interface WeeklyPatternEntry {
  day: number;
  start: string;
  end: string;
}

export interface PlannedShift {
  /** التاريخ المحلي لبداية الوردية (منتصف الليل UTC) */
  date: Date;
  startAt: Date;
  endAt: Date;
  departmentId: string | null;
  /** DATED = وردية بتاريخ محدد، WEEKLY = من النمط الأسبوعي الثابت */
  origin: 'DATED' | 'WEEKLY';
  /** معرف الوردية المؤرخة إن وُجد */
  id: string | null;
}

export interface ScheduleLike {
  isFlexible: boolean;
  weeklyPattern: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface DatedShiftLike {
  id: string;
  startAt: Date;
  endAt: Date;
  departmentId: string | null;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** يقرأ النمط المخزَّن (JSON) بأمان؛ أي عنصر غير صالح يُهمل. */
export function readWeeklyPattern(value: unknown): WeeklyPatternEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is WeeklyPatternEntry =>
      typeof e === 'object' &&
      e !== null &&
      Number.isInteger((e as WeeklyPatternEntry).day) &&
      (e as WeeklyPatternEntry).day >= 0 &&
      (e as WeeklyPatternEntry).day <= 6 &&
      typeof (e as WeeklyPatternEntry).start === 'string' &&
      typeof (e as WeeklyPatternEntry).end === 'string' &&
      TIME.test((e as WeeklyPatternEntry).start) &&
      TIME.test((e as WeeklyPatternEntry).end),
  );
}

/**
 * يتحقق من النمط الأسبوعي ويعيد رسالة الخطأ أو null.
 * النهاية الأصغر من أو المساوية للبداية تعني وردية تمتد إلى اليوم التالي.
 */
export function validateWeeklyPattern(pattern: WeeklyPatternEntry[]): string | null {
  if (pattern.length === 0) return 'الجدول الثابت يتطلب وردية واحدة على الأقل';
  const WEEK = 7 * 24 * 60;
  const ranges: [number, number][] = [];
  for (const entry of pattern) {
    if (!Number.isInteger(entry.day) || entry.day < 0 || entry.day > 6) return 'يوم الأسبوع غير صالح';
    if (!TIME.test(entry.start) || !TIME.test(entry.end)) return 'وقت الوردية يجب أن يكون بصيغة HH:mm';
    const start = entry.day * 24 * 60 + toMinutes(entry.start);
    let end = entry.day * 24 * 60 + toMinutes(entry.end);
    if (end <= start) end += 24 * 60;
    ranges.push([start, end]);
  }
  // فحص التداخل على أسبوع دائري (وردية السبت الليلية قد تمتد إلى الأحد)
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      for (const shift of [-WEEK, 0, WEEK]) {
        const [aStart, aEnd] = ranges[i]!;
        const [bStart, bEnd] = [ranges[j]![0] + shift, ranges[j]![1] + shift];
        if (aStart < bEnd && bStart < aEnd) return 'ورديات الجدول الأسبوعي متداخلة';
      }
    }
  }
  return null;
}

/** يوسّع النمط الأسبوعي إلى ورديات فعلية بين تاريخين محليين (شاملين)، مع مراعاة التوقيت الصيفي. */
export function expandWeeklyPattern(pattern: WeeklyPatternEntry[], from: Date, to: Date, timezone: string): PlannedShift[] {
  const shifts: PlannedShift[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const jsWeekday = date.getUTCDay();
    for (const entry of pattern) {
      if (entry.day !== jsWeekday) continue;
      const at = (time: string) =>
        DateTime.fromObject(
          { year, month, day, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) },
          { zone: timezone },
        );
      const start = at(entry.start);
      let end = at(entry.end);
      if (end <= start) end = end.plus({ days: 1 });
      shifts.push({ date, startAt: start.toJSDate(), endAt: end.toJSDate(), departmentId: null, origin: 'WEEKLY', id: null });
    }
  }
  return shifts.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/**
 * الورديات الملزِمة للموظف بين تاريخين:
 *  - يوم فيه ورديات مؤرخة ← هي الالتزام (حتى للموظف المرن: التزام عمل محدد صراحةً).
 *  - وإلا جدول ثابت سارٍ في ذلك اليوم ← ورديات نمطه الأسبوعي.
 *  - وإلا (مرن، أو بلا جدول) ← لا التزام: لا تأخير ولا غياب يُستنتج.
 */
export function resolvePlannedShifts(
  schedules: ScheduleLike[],
  datedShifts: DatedShiftLike[],
  from: Date,
  to: Date,
  timezone: string,
): PlannedShift[] {
  const localDate = (instant: Date) => {
    const local = DateTime.fromJSDate(instant, { zone: timezone });
    return new Date(Date.UTC(local.year, local.month - 1, local.day));
  };
  const dated: PlannedShift[] = datedShifts
    .map((s) => ({ date: localDate(s.startAt), startAt: s.startAt, endAt: s.endAt, departmentId: s.departmentId, origin: 'DATED' as const, id: s.id }))
    .filter((s) => s.date >= from && s.date <= to);
  const datedDays = new Set(dated.map((s) => formatDateOnly(s.date)));

  const weekly: PlannedShift[] = [];
  for (const schedule of schedules) {
    if (schedule.isFlexible) continue;
    const pattern = readWeeklyPattern(schedule.weeklyPattern);
    if (pattern.length === 0) continue;
    const start = schedule.effectiveFrom > from ? schedule.effectiveFrom : from;
    const end = schedule.effectiveTo && schedule.effectiveTo < to ? schedule.effectiveTo : to;
    if (start > end) continue;
    weekly.push(...expandWeeklyPattern(pattern, start, end, timezone).filter((s) => !datedDays.has(formatDateOnly(s.date))));
  }
  return [...dated, ...weekly].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

export interface SessionLike {
  id: string;
  checkInAt: Date;
  checkOutAt: Date | null;
}

export interface Deviation {
  /** دقائق التأخير عن بداية الوردية المجدولة */
  lateMinutes: number;
  /** دقائق الانصراف المبكر قبل نهاية الوردية المجدولة (null إن لم يُسجَّل الانصراف بعد) */
  earlyLeaveMinutes: number | null;
  plannedStartAt: Date;
  plannedEndAt: Date;
}

/**
 * يقارن الدوام الفعلي بالمجدول. الوردية الفعلية تُنسب إلى الوردية المجدولة التي تتقاطع معها أكثر.
 * إن غطّت عدة ورديات فعلية وردية مجدولة واحدة (خرج وعاد) فالتأخير يُحسب على الأولى
 * والانصراف المبكر على الأخيرة فقط. الوردية التي لا تتقاطع مع أي التزام لا تظهر في النتيجة.
 */
export function computeDeviations(planned: PlannedShift[], sessions: SessionLike[]): Map<string, Deviation> {
  const matches = new Map<PlannedShift, SessionLike[]>();
  for (const session of sessions) {
    let best: PlannedShift | null = null;
    let bestOverlap = 0;
    for (const shift of planned) {
      if (!intervalsOverlap(session.checkInAt, session.checkOutAt, shift.startAt, shift.endAt)) continue;
      const start = Math.max(session.checkInAt.getTime(), shift.startAt.getTime());
      const end = Math.min(session.checkOutAt ? session.checkOutAt.getTime() : shift.endAt.getTime(), shift.endAt.getTime());
      const overlap = end - start;
      if (best === null || overlap > bestOverlap) {
        best = shift;
        bestOverlap = overlap;
      }
    }
    if (best) matches.set(best, [...(matches.get(best) ?? []), session]);
  }

  const result = new Map<string, Deviation>();
  for (const [shift, matched] of matches) {
    matched.sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());
    const first = matched[0]!;
    const last = matched[matched.length - 1]!;
    for (const session of matched) {
      result.set(session.id, {
        lateMinutes: session === first ? minutesBetween(shift.startAt, session.checkInAt) : 0,
        earlyLeaveMinutes:
          session === last ? (session.checkOutAt ? minutesBetween(session.checkOutAt, shift.endAt) : null) : 0,
        plannedStartAt: shift.startAt,
        plannedEndAt: shift.endAt,
      });
    }
  }
  return result;
}
