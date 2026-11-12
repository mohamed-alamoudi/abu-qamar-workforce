/**
 * اكتشاف العمل الإضافي (بالدقائق فقط — المال يُحسب في المحرك المالي).
 *
 * لكل يوم عمل حدّان اختياريان:
 *  - حد يومي: ما زاد عنه من دقائق اليوم المستحقة إضافي.
 *  - حد أسبوعي: ما زاد عنه من مجموع الدقائق «العادية» المتراكمة في الأسبوع إضافي.
 * الدقيقة الواحدة لا تُعدّ مرتين: ما احتُسب إضافيًا يوميًا لا يدخل في المجموع الأسبوعي.
 */

export interface OvertimeDayInput {
  /** التاريخ المحلي YYYY-MM-DD */
  date: string;
  /** مجموع الدقائق المستحقة لورديات اليوم المغلقة */
  workedMinutes: number;
  dailyThresholdMinutes: number | null;
  weeklyThresholdMinutes: number | null;
}

/** أيام أسبوع واحد مرتبة تصاعديًا → دقائق الإضافي لكل يوم (الأيام بلا إضافي لا تظهر). */
export function computeWeekOvertime(days: OvertimeDayInput[]): Map<string, number> {
  const result = new Map<string, number>();
  let regularSoFar = 0;
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const worked = Math.max(0, Math.trunc(day.workedMinutes));
    const dailyOvertime = day.dailyThresholdMinutes === null ? 0 : Math.max(0, worked - day.dailyThresholdMinutes);
    const regular = worked - dailyOvertime;
    const weeklyOvertime =
      day.weeklyThresholdMinutes === null ? 0 : Math.min(regular, Math.max(0, regularSoFar + regular - day.weeklyThresholdMinutes));
    regularSoFar += regular - weeklyOvertime;
    const total = dailyOvertime + weeklyOvertime;
    if (total > 0) result.set(day.date, total);
  }
  return result;
}

/** بداية الأسبوع الذي يقع فيه التاريخ. weekStartsOn بترقيم JavaScript (6 = السبت). */
export function weekStartOf(date: Date, weekStartsOn: number): Date {
  const daysSinceStart = (date.getUTCDay() - weekStartsOn + 7) % 7;
  return new Date(date.getTime() - daysSinceStart * 86_400_000);
}
