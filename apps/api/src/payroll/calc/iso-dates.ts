import type { IsoDate } from './types';

/** أدوات تواريخ محلية بلا وقت ('YYYY-MM-DD'). الحساب عبر UTC فلا يتأثر بمنطقة الخادم ولا بالتوقيت الصيفي. */

const DAY_MS = 86_400_000;

export function isoToUtc(date: IsoDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function utcToIso(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addIsoDays(date: IsoDate, days: number): IsoDate {
  return utcToIso(new Date(isoToUtc(date).getTime() + days * DAY_MS));
}

/** 0 = الأحد … 6 = السبت */
export function dayOfWeek(date: IsoDate): number {
  return isoToUtc(date).getUTCDay();
}

/** 'YYYY-MM' */
export function monthKey(date: IsoDate): string {
  return date.slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthStart(month: string): IsoDate {
  return `${month}-01`;
}

export function monthEnd(month: string): IsoDate {
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
}

/** كل الأيام من البداية إلى النهاية (شاملتين). */
export function eachDay(start: IsoDate, end: IsoDate): IsoDate[] {
  const days: IsoDate[] = [];
  for (let d = start; d <= end; d = addIsoDays(d, 1)) days.push(d);
  return days;
}

export function inRange(date: IsoDate, from: IsoDate, to: IsoDate | null): boolean {
  return date >= from && (to === null || date <= to);
}

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

/** 'YYYY-MM' → «نوفمبر 2026» */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS_AR[m - 1]} ${y}`;
}
