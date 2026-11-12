import { Errors } from '../common/errors/app-exception';
import type { ColumnDef, PublicColumn, ReportKey, ReportRow } from './report-types';

/**
 * القائمة البيضاء لأعمدة كل تقرير وكل عرض (view).
 * أي عمود يطلبه العميل خارجها يُرفض بخطأ تحقق — لا يصل إلى الاستعلام أبدًا.
 */

export const SESSION_STATUS_LABELS = { OPEN: 'مفتوحة (دون انصراف)', CLOSED: 'مغلقة' };
export const APPROVAL_LABELS = { DRAFT: 'مسودة', IN_REVIEW: 'قيد المراجعة', APPROVED: 'معتمدة' };
export const SOURCE_LABELS = { QUICK: 'حضور سريع', MANUAL: 'تسجيل يدوي', OFFLINE_SYNC: 'مزامنة دون إنترنت' };
export const LEAVE_TYPE_LABELS = {
  PAID_LEAVE: 'إجازة مدفوعة',
  UNPAID_LEAVE: 'إجازة غير مدفوعة',
  PAID_EXCUSED_ABSENCE: 'غياب مدفوع ومبرر',
  UNPAID_ABSENCE: 'غياب غير مدفوع',
};
export const LEAVE_STATUS_LABELS = { PENDING: 'بانتظار الاعتماد', APPROVED: 'معتمدة', REJECTED: 'مرفوضة', CANCELLED: 'ملغاة' };
export const YES_NO_LABELS = { YES: 'نعم', NO: 'لا' };
export const PERIOD_STATUS_LABELS = {
  DRAFT: 'مسودة',
  IN_REVIEW: 'قيد المراجعة',
  READY_FOR_APPROVAL: 'جاهزة للاعتماد',
  CLOSED: 'مغلقة ومعتمدة',
};
export const FREQUENCY_LABELS = { WEEKLY: 'أسبوعية', SEMI_MONTHLY: 'نصف شهرية', MONTHLY: 'شهرية' };
export const ACCOUNT_STATUS_LABELS = { OPEN: 'قائمة', SETTLED: 'مسدَّدة', CANCELLED: 'ملغاة' };
export const TARGET_TYPE_LABELS = { PAYROLL_ENTRY: 'مستحق راتب', ADVANCE: 'سلفة', DEBT: 'دين', ADJUSTMENT: 'فرق راتب' };
export const TX_STATUS_LABELS = { POSTED: 'مسجَّلة', REVERSED: 'معكوسة' };
export const TX_TYPE_LABELS = {
  SALARY_PAYMENT: 'دفعة راتب',
  ADVANCE_DISBURSEMENT: 'صرف سلفة',
  ADVANCE_REPAYMENT: 'سداد سلفة',
  DEBT_REPAYMENT: 'سداد دين',
  SETTLEMENT: 'تسوية',
  REFUND: 'استرداد',
  REVERSAL: 'عكس عملية',
};
export const METHOD_LABELS = { CASH: 'نقدي', BANK_TRANSFER: 'تحويل بنكي', E_WALLET: 'محفظة إلكترونية' };

const EMPLOYEE_COLUMNS: ColumnDef[] = [
  { key: 'employeeCode', label: 'كود الموظف', type: 'text', default: true, weight: 1.1 },
  { key: 'employeeName', label: 'الموظف', type: 'text', default: true, weight: 2.2 },
  { key: 'department', label: 'القسم', type: 'text', default: true, weight: 1.4 },
];

const money = (key: string, label: string, isDefault = true): ColumnDef => ({ key, label, type: 'money', default: isDefault, total: true });
const minutes = (key: string, label: string, isDefault = true): ColumnDef => ({ key, label, type: 'minutes', default: isDefault, total: true });
const count = (key: string, label: string, isDefault = true): ColumnDef => ({ key, label, type: 'int', default: isDefault, total: true });
const days = (key: string, label: string, isDefault = true): ColumnDef => ({ key, label, type: 'days', default: isDefault, total: true });

export const REPORT_VIEWS = {
  attendance: {
    sessions: [
      ...EMPLOYEE_COLUMNS,
      { key: 'workDate', label: 'التاريخ', type: 'date', default: true },
      { key: 'checkInAt', label: 'الحضور', type: 'datetime', default: true },
      { key: 'checkOutAt', label: 'الانصراف', type: 'datetime', default: true },
      minutes('workedMinutes', 'ساعات العمل'),
      count('breakCount', 'عدد الاستراحات', false),
      minutes('unpaidBreakMinutes', 'استراحات غير مدفوعة'),
      minutes('paidBreakMinutes', 'استراحات مدفوعة', false),
      { key: 'scheduledStart', label: 'بداية الجدول', type: 'datetime' },
      minutes('lateMinutes', 'التأخير'),
      minutes('earlyLeaveMinutes', 'انصراف مبكر', false),
      minutes('overtimeApprovedMinutes', 'إضافي معتمد'),
      minutes('overtimePendingMinutes', 'إضافي بانتظار الاعتماد', false),
      { key: 'status', label: 'حالة الوردية', type: 'enum', labels: SESSION_STATUS_LABELS, default: true, weight: 1.5 },
      { key: 'approvalStatus', label: 'الاعتماد', type: 'enum', labels: APPROVAL_LABELS, default: true },
      { key: 'source', label: 'طريقة التسجيل', type: 'enum', labels: SOURCE_LABELS },
    ],
    employees: [
      ...EMPLOYEE_COLUMNS,
      count('daysWorked', 'أيام العمل'),
      count('sessionsCount', 'عدد الورديات'),
      minutes('workedMinutes', 'ساعات العمل'),
      count('breakCount', 'عدد الاستراحات', false),
      minutes('unpaidBreakMinutes', 'استراحات غير مدفوعة'),
      minutes('paidBreakMinutes', 'استراحات مدفوعة', false),
      count('lateCount', 'مرات التأخير'),
      minutes('lateMinutes', 'مجموع التأخير'),
      minutes('earlyLeaveMinutes', 'انصراف مبكر', false),
      minutes('overtimeApprovedMinutes', 'إضافي معتمد'),
      minutes('overtimePendingMinutes', 'إضافي بانتظار الاعتماد', false),
      count('openSessions', 'ورديات دون انصراف'),
    ],
  },
  absence: {
    records: [
      ...EMPLOYEE_COLUMNS,
      { key: 'type', label: 'النوع', type: 'enum', labels: LEAVE_TYPE_LABELS, default: true, weight: 1.6 },
      { key: 'startDate', label: 'من', type: 'date', default: true },
      { key: 'endDate', label: 'إلى', type: 'date', default: true },
      days('daysInRange', 'الأيام ضمن الفترة'),
      days('paidDays', 'أيام مدفوعة'),
      days('unpaidDays', 'أيام غير مدفوعة'),
      { key: 'totalDays', label: 'مدة السجل كاملة', type: 'days' },
      { key: 'status', label: 'الحالة', type: 'enum', labels: LEAVE_STATUS_LABELS, default: true, weight: 1.3 },
      { key: 'affectsPay', label: 'تؤثر على الأجر', type: 'enum', labels: YES_NO_LABELS },
      { key: 'reason', label: 'السبب', type: 'text', weight: 2 },
      { key: 'recordedBy', label: 'سجّلها', type: 'text' },
      { key: 'decidedBy', label: 'قرّر فيها', type: 'text' },
      { key: 'decidedAt', label: 'وقت القرار', type: 'datetime' },
    ],
    employees: [
      ...EMPLOYEE_COLUMNS,
      count('recordsCount', 'عدد السجلات'),
      days('leaveDays', 'أيام الإجازات'),
      days('absenceDays', 'أيام الغياب'),
      days('paidDays', 'أيام مدفوعة'),
      days('unpaidDays', 'أيام غير مدفوعة'),
      days('daysInRange', 'مجموع الأيام'),
      days('pendingDays', 'أيام بانتظار الاعتماد', false),
    ],
  },
  financial: {
    employees: [
      ...EMPLOYEE_COLUMNS,
      money('grossAmount', 'إجمالي الأجر المكتسب'),
      money('deductionsAmount', 'الخصومات', false),
      money('netAmount', 'صافي المستحق'),
      money('paidAmount', 'المدفوع'),
      money('unpaidAmount', 'غير المدفوع'),
      money('advancesDisbursed', 'سلف صُرفت في الفترة', false),
      money('advancesOutstanding', 'السلف القائمة'),
      money('debtsIncurred', 'ديون نشأت في الفترة', false),
      money('debtsOutstanding', 'الديون القائمة'),
      money('settlementsAmount', 'التسويات'),
    ],
    entries: [
      ...EMPLOYEE_COLUMNS,
      { key: 'periodLabel', label: 'فترة الرواتب', type: 'text', default: true, weight: 1.8 },
      { key: 'periodStart', label: 'بداية الفترة', type: 'date' },
      { key: 'periodEnd', label: 'نهاية الفترة', type: 'date' },
      { key: 'frequency', label: 'نوع الفترة', type: 'enum', labels: FREQUENCY_LABELS },
      { key: 'periodStatus', label: 'حالة الفترة', type: 'enum', labels: PERIOD_STATUS_LABELS, default: true, weight: 1.4 },
      money('regularWage', 'الأجر الأساسي', false),
      money('overtimeWage', 'أجر الإضافي', false),
      money('bonuses', 'المكافآت', false),
      money('otherDeductions', 'خصومات', false),
      money('absenceDeductions', 'خصم الغياب', false),
      money('adjustments', 'فروقات وتسويات', false),
      money('grossAmount', 'إجمالي الأجر المكتسب'),
      money('deductionsAmount', 'الخصومات'),
      money('netAmount', 'صافي المستحق'),
      money('paidAmount', 'المدفوع'),
      money('unpaidAmount', 'غير المدفوع'),
    ],
    advances: [
      ...EMPLOYEE_COLUMNS,
      { key: 'disbursedAt', label: 'تاريخ الصرف', type: 'datetime', default: true },
      money('principalAmount', 'مبلغ السلفة'),
      money('repaidAmount', 'المسدَّد'),
      money('remainingBalance', 'الرصيد المتبقي'),
      { key: 'status', label: 'الحالة', type: 'enum', labels: ACCOUNT_STATUS_LABELS, default: true },
      { key: 'note', label: 'ملاحظة', type: 'text', weight: 2 },
      { key: 'createdBy', label: 'أنشأها', type: 'text' },
    ],
    debts: [
      ...EMPLOYEE_COLUMNS,
      { key: 'incurredAt', label: 'تاريخ الدين', type: 'datetime', default: true },
      money('principalAmount', 'مبلغ الدين'),
      money('repaidAmount', 'المسدَّد'),
      money('remainingBalance', 'الرصيد المتبقي'),
      { key: 'status', label: 'الحالة', type: 'enum', labels: ACCOUNT_STATUS_LABELS, default: true },
      { key: 'reason', label: 'السبب', type: 'text', default: true, weight: 2 },
      { key: 'createdBy', label: 'أنشأه', type: 'text' },
    ],
    settlements: [
      ...EMPLOYEE_COLUMNS,
      { key: 'occurredAt', label: 'التاريخ والوقت', type: 'datetime', default: true },
      { key: 'targetType', label: 'الالتزام المسوّى', type: 'enum', labels: TARGET_TYPE_LABELS, default: true, weight: 1.4 },
      { key: 'target', label: 'تفاصيل الالتزام', type: 'text', default: true, weight: 2.2 },
      money('amount', 'مبلغ التسوية'),
      { key: 'status', label: 'حالة العملية', type: 'enum', labels: TX_STATUS_LABELS, default: true },
      { key: 'reference', label: 'المرجع', type: 'text' },
      { key: 'note', label: 'ملاحظة', type: 'text', weight: 2 },
      { key: 'createdBy', label: 'نفّذها', type: 'text' },
    ],
  },
  payments: {
    payments: [
      { key: 'occurredAt', label: 'التاريخ والوقت', type: 'datetime', default: true },
      ...EMPLOYEE_COLUMNS,
      { key: 'type', label: 'نوع الدفعة', type: 'enum', labels: TX_TYPE_LABELS, weight: 1.3 },
      money('amount', 'المبلغ'),
      { key: 'method', label: 'طريقة الدفع', type: 'enum', labels: METHOD_LABELS, default: true, weight: 1.3 },
      { key: 'paidBy', label: 'من دفع', type: 'text', default: true, weight: 1.4 },
      { key: 'receivedBy', label: 'من استلم', type: 'text', weight: 1.4 },
      { key: 'reference', label: 'المرجع / الإيصال', type: 'text', default: true },
      { key: 'period', label: 'المستحق الذي تغطيه', type: 'text', default: true, weight: 1.8 },
      { key: 'status', label: 'الحالة', type: 'enum', labels: TX_STATUS_LABELS, default: true },
      { key: 'note', label: 'ملاحظة', type: 'text', weight: 2 },
      { key: 'createdBy', label: 'سجّلها', type: 'text' },
    ],
    byEmployee: [...EMPLOYEE_COLUMNS, count('paymentsCount', 'عدد الدفعات'), money('amount', 'مجموع الدفعات')],
    byPeriod: [
      { key: 'period', label: 'فترة الرواتب', type: 'text', default: true, weight: 2.2 },
      { key: 'periodStart', label: 'بداية الفترة', type: 'date', default: true },
      { key: 'periodEnd', label: 'نهاية الفترة', type: 'date', default: true },
      count('paymentsCount', 'عدد الدفعات'),
      money('amount', 'مجموع الدفعات'),
    ],
    byMethod: [
      { key: 'method', label: 'طريقة الدفع', type: 'enum', labels: { ...METHOD_LABELS, NONE: 'غير محددة' }, default: true, weight: 2 },
      count('paymentsCount', 'عدد الدفعات'),
      money('amount', 'مجموع الدفعات'),
    ],
    byExecutor: [
      { key: 'executor', label: 'من نفّذ', type: 'text', default: true, weight: 2.2 },
      { key: 'executorUsername', label: 'اسم المستخدم', type: 'text', default: true },
      count('paymentsCount', 'عدد الدفعات'),
      money('amount', 'مجموع الدفعات'),
    ],
  },
} as const satisfies Record<ReportKey, Record<string, readonly ColumnDef[]>>;

export const DEFAULT_VIEWS: Record<ReportKey, string> = {
  attendance: 'sessions',
  absence: 'records',
  financial: 'employees',
  payments: 'payments',
};

export function viewColumns(report: ReportKey, view: string): readonly ColumnDef[] {
  const views = REPORT_VIEWS[report] as Record<string, readonly ColumnDef[]>;
  const columns = Object.hasOwn(views, view) ? views[view] : undefined;
  if (!columns) {
    throw Errors.validation(`طريقة العرض غير معروفة لهذا التقرير. القيم المسموحة: ${Object.keys(views).join('، ')}`);
  }
  return columns;
}

export function toPublicColumn(column: ColumnDef): PublicColumn {
  return {
    key: column.key,
    label: column.label,
    type: column.type,
    total: column.total === true,
    default: column.default === true,
    ...(column.labels ? { labels: column.labels } : {}),
    ...(column.weight === undefined ? {} : { weight: column.weight }),
  };
}

/**
 * يتحقق من الأعمدة المطلوبة مقابل القائمة البيضاء ويعيدها بالترتيب المعرّف.
 * `requested` نص مفصول بفواصل (أو undefined للأعمدة الافتراضية).
 */
export function selectColumns(report: ReportKey, view: string, requested: string | undefined): ColumnDef[] {
  const available = viewColumns(report, view);
  if (requested === undefined || requested.trim() === '') return available.filter((c) => c.default);

  const keys = [...new Set(requested.split(',').map((k) => k.trim()).filter(Boolean))];
  const allowed = new Set(available.map((c) => c.key));
  const unknown = keys.filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw Errors.validation(`أعمدة غير مسموحة في هذا التقرير: ${unknown.join('، ')}`, { unknownColumns: unknown });
  }
  if (keys.length === 0) throw Errors.validation('اختر عمودًا واحدًا على الأقل');
  const wanted = new Set(keys);
  return available.filter((c) => wanted.has(c.key));
}

/** يُبقي في الصف الأعمدة المختارة فقط (مع المعرّفات اللازمة للربط في الواجهة). */
export function projectRow(row: ReportRow, columns: readonly ColumnDef[], keep: readonly string[] = ['id', 'employeeId']): ReportRow {
  const out: ReportRow = {};
  for (const key of keep) if (row[key] !== undefined) out[key] = row[key];
  for (const column of columns) out[column.key] = row[column.key] ?? null;
  return out;
}

export function projectTotals(totals: ReportRow, columns: readonly ColumnDef[]): ReportRow {
  const out: ReportRow = {};
  for (const column of columns) if (column.total && totals[column.key] !== undefined) out[column.key] = totals[column.key];
  return out;
}
