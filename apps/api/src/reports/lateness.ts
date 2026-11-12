import { DateTime } from 'luxon';
import { formatDateOnly } from '../common/utils/dates';
import { localDateOf, wholeMinutes } from './report-range';

/**
 * حساب التأخير والانصراف المبكر — دوال صرفة بلا قاعدة بيانات.
 *
 * القاعدة (المتطلبات §7): التأخير والانصراف المبكر يُحسبان فقط عند وجود جدول:
 *   1) وردية مجدولة بتاريخ محدد (schedule_shifts) في اليوم المحلي نفسه — لها الأولوية؛
 *   2) وإلا نمط أسبوعي ثابت في جدول غير مرن (employee_schedules.weeklyPattern) ساري في ذلك التاريخ.
 * الموظف المرن أو من لا جدول له: لا تأخير (القيمة null وليست صفرًا).
 * عند عدة ورديات فعلية لوردية مجدولة واحدة: التأخير للأولى فقط، والانصراف المبكر للأخيرة فقط.
 */

export interface PatternDay {
  /** ترقيم JavaScript: 0 = الأحد … 6 = السبت */
  day: number;
  /** 'HH:mm' بالتوقيت المحلي */
  start: string;
  end: string;
}

export interface ScheduleInfo {
  isFlexible: boolean;
  pattern: PatternDay[];
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface ShiftInfo {
  startAt: Date;
  endAt: Date;
}

export interface ExpectedShift {
  start: Date;
  end: Date;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** يقرأ weeklyPattern من JSON بتسامح: أي عنصر غير صالح يُهمل. */
export function parseWeeklyPattern(json: unknown): PatternDay[] {
  if (!Array.isArray(json)) return [];
  const out: PatternDay[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const { day, start, end } = item as Record<string, unknown>;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) continue;
    if (typeof start !== 'string' || typeof end !== 'string' || !TIME.test(start) || !TIME.test(end)) continue;
    out.push({ day, start, end });
  }
  return out;
}

function atLocalTime(workDate: Date, time: string, timezone: string, plusDays = 0): Date {
  const [hour, minute] = time.split(':').map(Number);
  return DateTime.fromObject(
    { year: workDate.getUTCFullYear(), month: workDate.getUTCMonth() + 1, day: workDate.getUTCDate(), hour, minute },
    { zone: timezone },
  )
    .plus({ days: plusDays })
    .toUTC()
    .toJSDate();
}

function nearest(candidates: ExpectedShift[], checkInAt: Date): ExpectedShift | null {
  let best: ExpectedShift | null = null;
  for (const candidate of candidates) {
    if (!best || Math.abs(candidate.start.getTime() - checkInAt.getTime()) < Math.abs(best.start.getTime() - checkInAt.getTime())) {
      best = candidate;
    }
  }
  return best;
}

/**
 * الوردية المتوقعة لوردية فعلية.
 * @param workDate التاريخ المحلي للوردية (Date عند منتصف الليل UTC)
 * @param shifts كل الورديات المجدولة للموظف (تُفلتر هنا باليوم المحلي)
 * @param schedules جداول الموظف (يُختار الساري في workDate)
 */
export function expectedShiftFor(
  workDate: Date,
  checkInAt: Date,
  shifts: readonly ShiftInfo[],
  schedules: readonly ScheduleInfo[],
  timezone: string,
): ExpectedShift | null {
  const day = formatDateOnly(workDate);
  const dated = shifts.filter((s) => localDateOf(s.startAt, timezone) === day).map((s) => ({ start: s.startAt, end: s.endAt }));
  if (dated.length > 0) return nearest(dated, checkInAt);

  const schedule = schedules.find((s) => s.effectiveFrom <= workDate && (s.effectiveTo === null || s.effectiveTo >= workDate));
  if (!schedule || schedule.isFlexible) return null;

  const weekday = workDate.getUTCDay();
  const fromPattern = schedule.pattern
    .filter((p) => p.day === weekday)
    .map((p) => ({
      start: atLocalTime(workDate, p.start, timezone),
      // نهاية قبل البداية أو مساوية لها = وردية تمتد بعد منتصف الليل
      end: atLocalTime(workDate, p.end, timezone, p.end <= p.start ? 1 : 0),
    }));
  return nearest(fromPattern, checkInAt);
}

export interface SessionTiming {
  id: string;
  employeeId: string;
  workDate: Date;
  checkInAt: Date;
  checkOutAt: Date | null;
}

export interface TimingResult {
  scheduledStart: Date | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
}

/**
 * يحسب التأخير والانصراف المبكر لمجموعة ورديات (لأي عدد من الموظفين).
 * يجب أن تتضمن المجموعة كل ورديات الموظف غير الملغاة في الفترة حتى تُعرف «الأولى» و«الأخيرة» بدقة.
 */
export function computeTimings(
  sessions: readonly SessionTiming[],
  shiftsByEmployee: ReadonlyMap<string, readonly ShiftInfo[]>,
  schedulesByEmployee: ReadonlyMap<string, readonly ScheduleInfo[]>,
  timezone: string,
): Map<string, TimingResult> {
  const results = new Map<string, TimingResult>();
  const groups = new Map<string, { expected: ExpectedShift; members: SessionTiming[] }>();

  for (const session of sessions) {
    const expected = expectedShiftFor(
      session.workDate,
      session.checkInAt,
      shiftsByEmployee.get(session.employeeId) ?? [],
      schedulesByEmployee.get(session.employeeId) ?? [],
      timezone,
    );
    if (!expected) {
      results.set(session.id, { scheduledStart: null, lateMinutes: null, earlyLeaveMinutes: null });
      continue;
    }
    results.set(session.id, { scheduledStart: expected.start, lateMinutes: null, earlyLeaveMinutes: null });
    const key = `${session.employeeId}|${expected.start.toISOString()}`;
    const group = groups.get(key);
    if (group) group.members.push(session);
    else groups.set(key, { expected, members: [session] });
  }

  for (const { expected, members } of groups.values()) {
    members.sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());
    const first = members[0];
    const last = members[members.length - 1];
    results.get(first.id)!.lateMinutes = wholeMinutes(expected.start, first.checkInAt);
    // الانصراف المبكر يُعرف فقط إذا أُغلقت كل ورديات المجموعة
    if (members.every((m) => m.checkOutAt !== null)) {
      results.get(last.id)!.earlyLeaveMinutes = wholeMinutes(last.checkOutAt as Date, expected.end);
    }
  }
  return results;
}
