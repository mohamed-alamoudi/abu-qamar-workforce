import { DateTime } from 'luxon';
import type { CellValue, PublicColumn, ReportResult } from '../report-types';

/** ما يحتاجه مولّدا Excel و PDF: نتيجة التقرير بكل صفوفها + بيانات الترويسة. */
export interface ExportInput {
  result: ReportResult;
  organizationName: string;
  /** وصف الفلاتر المطبَّقة (سطر لكل فلتر) */
  filters: string[];
  generatedBy: string;
  generatedAt: Date;
}

/** الدقائق → 'س:دد' (مثل 7:05) دون تقريب. */
export function formatMinutes(value: number): string {
  const minutes = Math.max(0, Math.trunc(value));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** مبلغ نصي '1234567.50' → '1,234,567.50' بمعالجة نصية (دون المرور برقم عائم). */
export function formatMoneyText(value: string): string {
  const negative = value.startsWith('-');
  const [whole, fraction = '00'] = (negative ? value.slice(1) : value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

export function formatLocalDateTime(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toFormat('yyyy-MM-dd HH:mm');
}

/** قيمة خلية → نص للعرض في PDF. */
export function displayValue(value: CellValue | undefined, column: PublicColumn, timezone: string): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (column.type) {
    case 'minutes':
      return formatMinutes(Number(value));
    case 'money':
      return formatMoneyText(String(value));
    case 'datetime':
      return formatLocalDateTime(String(value), timezone);
    case 'enum':
      return column.labels?.[String(value)] ?? String(value);
    default:
      return String(value);
  }
}

/** اسم ملف آمن (ASCII فقط) لترويسة Content-Disposition. */
export function exportFileName(report: string, view: string, from: string, to: string, extension: 'xlsx' | 'pdf'): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9-]/g, '');
  return `${safe(report)}-${safe(view)}_${safe(from)}_${safe(to)}.${extension}`;
}
