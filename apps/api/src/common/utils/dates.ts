import { Transform } from 'class-transformer';
import { DateTime } from 'luxon';

/**
 * التواريخ المحلية (بلا وقت) تُخزَّن في أعمدة `date` وتُمثَّل في الكود كـ Date عند منتصف الليل UTC.
 * هذه الدوال هي الطريق الوحيد للتحويل حتى لا يتسرب فرق المنطقة الزمنية إلى التواريخ.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' → Date (منتصف الليل UTC)، أو null إن كان النص غير صالح (مثل 2026-02-30). */
export function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** تاريخ اليوم في المنطقة الزمنية المحلية (وليس تاريخ UTC). */
export function todayInZone(timezone: string, now = new Date()): Date {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) throw new Error(`منطقة زمنية غير صالحة: ${timezone}`);
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** class-transformer: يحوّل 'YYYY-MM-DD' إلى Date؛ القيمة غير الصالحة تبقى كما هي ليرفضها @IsDate. */
export const ToDateOnly = () =>
  Transform(({ value }) => (typeof value === 'string' ? (parseDateOnly(value.trim()) ?? value) : value));
