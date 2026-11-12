import type { PermissionKey } from '@abu-qamar/shared';

/**
 * تعريفات عامة مشتركة بين التقارير الأربعة.
 * كل تقرير يُعاد بالشكل نفسه (أعمدة + صفوف + إجماليات + رسم)، فيعمل العرض والتصدير عليه دون معرفة نوعه.
 */

export type ReportKey = 'attendance' | 'financial' | 'absence' | 'payments';

export const REPORT_PERMISSIONS: Record<ReportKey, PermissionKey> = {
  attendance: 'reports.attendance',
  financial: 'reports.financial',
  absence: 'reports.absence',
  payments: 'reports.payments',
};

/**
 * نوع القيمة في العمود — يحدد طريقة العرض في الواجهة ونوع الخلية في Excel.
 * money: نص عشري بخانتين ('1250.50') محسوب بـ Decimal/SQL، لا يمر بأرقام عائمة.
 * minutes / int / days: أعداد صحيحة.
 * date: 'YYYY-MM-DD' (تاريخ محلي). datetime: ISO بتوقيت UTC يُعرض بمنطقة الإعدادات.
 */
export type ColumnType = 'text' | 'enum' | 'date' | 'datetime' | 'minutes' | 'money' | 'int' | 'days';

export interface ColumnDef {
  key: string;
  label: string;
  type: ColumnType;
  /** يظهر ضمن الأعمدة الافتراضية إن لم يحدد المستخدم أعمدة */
  default?: boolean;
  /** له إجمالي في صف الإجماليات */
  total?: boolean;
  /** تسميات عربية لقيم enum */
  labels?: Record<string, string>;
  /** وزن عرض العمود في PDF (الافتراضي حسب النوع) */
  weight?: number;
}

export type CellValue = string | number | null;
export type ReportRow = Record<string, CellValue>;

export interface ChartPoint {
  label: string;
  /** minutes/days/int: رقم صحيح. money: نص عشري */
  value: number | string;
}

export interface ReportChart {
  title: string;
  unit: 'minutes' | 'money' | 'days' | 'int';
  points: ChartPoint[];
}

export interface PublicColumn {
  key: string;
  label: string;
  type: ColumnType;
  total: boolean;
  default: boolean;
  labels?: Record<string, string>;
  weight?: number;
}

export interface ReportResult {
  report: ReportKey;
  view: string;
  title: string;
  range: { from: string; to: string };
  timezone: string;
  currency: string;
  /** الأعمدة المختارة بالترتيب */
  columns: PublicColumn[];
  /** كل الأعمدة المسموحة لهذا العرض (لمنتقي الأعمدة) */
  availableColumns: PublicColumn[];
  items: ReportRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** إجماليات كل النتائج المطابقة (وليس الصفحة الحالية فقط)، للأعمدة المختارة التي لها إجمالي */
  totals: ReportRow;
  /** أرقام إضافية خارج الأعمدة (مثل عدد الورديات المفتوحة) */
  summary: { key: string; label: string; type: ColumnType; value: CellValue }[];
  charts: ReportChart[];
  /** ملاحظات توضيحية تظهر تحت التقرير وفي التصدير */
  notes: string[];
}

/** ما تنتجه خدمة كل تقرير قبل اختيار الأعمدة والترقيم. */
export interface ReportData {
  view: string;
  title: string;
  /** صفوف الصفحة المطلوبة (أو كل الصفوف عند التصدير) بكل الأعمدة */
  rows: ReportRow[];
  total: number;
  totals: ReportRow;
  summary: ReportResult['summary'];
  charts: ReportChart[];
  notes: string[];
}

/** نافذة الصفوف المطلوبة من الخدمة. */
export interface RowWindow {
  skip: number;
  take: number;
}
