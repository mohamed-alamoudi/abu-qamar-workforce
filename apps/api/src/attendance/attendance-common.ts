import { DateTime } from 'luxon';
import { Prisma } from '@abu-qamar/database';
import { Errors } from '../common/errors/app-exception';
import { formatDateOnly } from '../common/utils/dates';
import { parseInstant } from './attendance-math';

/** عميل قاعدة البيانات: المعاملة الجارية أو العميل العام. */
export type Db = Prisma.TransactionClient;

/** وقت مُدخل: لحظة جاهزة، أو نص ISO بإزاحة، أو نص محلي بلا إزاحة يُفسَّر بمنطقة النظام. */
export type TimeInput = Date | string;

export function resolveInstant(value: TimeInput, timezone: string, label: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw Errors.validation(`${label} غير صالح`);
    return value;
  }
  const parsed = parseInstant(value, timezone);
  if (!parsed) throw Errors.validation(`${label} غير صالح أو ملتبس. استخدم وقتًا محليًا صالحًا أو حدّد إزاحة التوقيت`);
  return parsed;
}

/** عرض لحظة بالتوقيت المحلي في رسائل الأخطاء والإشعارات. */
export function formatLocal(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat('yyyy-MM-dd HH:mm');
}

/**
 * قفل استشاري على مستوى الموظف حتى نهاية المعاملة: كل كتابات دوام الموظف الواحد تتسلسل،
 * فلا يمر طلبان متزامنان من فحص التداخل معًا. (قيد EXCLUDE يبقى الضمانة الأخيرة.)
 */
export async function lockEmployee(tx: Db, employeeId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}, 0))::text AS locked`;
}

/** نهاية أحدث فترة رواتب مغلقة تتقاطع مع المدى [from, to] للموظف، أو null. */
export async function closedPayrollEnd(db: Db, employeeId: string, from: Date, to: Date = from): Promise<Date | null> {
  const closed = await db.payrollEntry.findFirst({
    where: { employeeId, periodStart: { lte: to }, periodEnd: { gte: from }, period: { status: 'CLOSED' } },
    orderBy: { periodEnd: 'desc' },
    select: { periodEnd: true },
  });
  return closed?.periodEnd ?? null;
}

/**
 * يرفض أي تغيير يمس مستحقات فترة رواتب مغلقة (نفس فحص assertNotInClosedPayroll في الموظفين):
 * الحسابات المغلقة لا تتغير، والفروقات تُعالج بتسوية في فترة مفتوحة.
 */
export async function assertOpenPayroll(db: Db, employeeId: string, from: Date, to: Date = from): Promise<void> {
  const end = await closedPayrollEnd(db, employeeId, from, to);
  if (end) {
    throw Errors.conflict(
      `هذا التاريخ يقع ضمن فترة رواتب مغلقة (حتى ${formatDateOnly(end)}). لا يمكن تغيير دوامها مباشرة؛ عالج الفرق بتسوية في فترة مفتوحة`,
    );
  }
}

/** شرط «ساري في هذا التاريخ» لأي جدول بتاريخي سريان. */
export const effectiveOn = (date: Date) => ({
  effectiveFrom: { lte: date },
  OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
});
