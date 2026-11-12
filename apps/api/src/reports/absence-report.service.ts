import { Injectable } from '@nestjs/common';
import { LeaveType, Prisma } from '@abu-qamar/database';
import { formatDateOnly } from '../common/utils/dates';
import type { AbsenceReportQueryDto } from './dto/reports.dto';
import { LEAVE_TYPE_LABELS } from './report-columns';
import { MAX_REPORT_SOURCE_ROWS, ReportContext, ReportContextService, sumIntColumns } from './report-context';
import { inclusiveDays, overlapDays } from './report-range';
import type { ReportData, ReportRow, RowWindow } from './report-types';

const PAID_TYPES: LeaveType[] = ['PAID_LEAVE', 'PAID_EXCUSED_ABSENCE'];
const UNPAID_TYPES: LeaveType[] = ['UNPAID_LEAVE', 'UNPAID_ABSENCE'];
const LEAVE_TYPES: LeaveType[] = ['PAID_LEAVE', 'UNPAID_LEAVE'];

const RECORD_TOTALS = ['daysInRange', 'paidDays', 'unpaidDays'];
const EMPLOYEE_TOTALS = ['recordsCount', 'leaveDays', 'absenceDays', 'paidDays', 'unpaidDays', 'daysInRange', 'pendingDays'];

/**
 * تقرير الغياب والإجازات — مصدره leave_records فقط.
 * يوم بلا دوام ليس غيابًا: لا يُستنتج أي غياب من عدم وجود حضور.
 * الأيام أيام تقويمية ضمن تقاطع السجل مع فترة التقرير (شاملة الطرفين).
 */
@Injectable()
export class AbsenceReportService {
  constructor(private readonly base: ReportContextService) {}

  async build(query: AbsenceReportQueryDto, ctx: ReportContext, window: RowWindow): Promise<ReportData> {
    const prisma = this.base.prisma;
    const { range } = ctx;
    const view = query.view ?? 'records';

    let types: LeaveType[] | undefined = query.type ? [query.type] : undefined;
    if (query.pay) {
      const allowed = query.pay === 'paid' ? PAID_TYPES : UNPAID_TYPES;
      types = (types ?? allowed).filter((t) => allowed.includes(t));
    }
    const where: Prisma.LeaveRecordWhereInput = {
      startDate: { lte: range.to },
      endDate: { gte: range.from },
      employee: this.base.employeeWhere(query),
      ...(types ? { type: { in: types } } : {}),
      // المرفوضة والملغاة ليست غيابًا فعليًا — تظهر فقط إذا طُلبت صراحةً
      status: query.status === 'ALL' ? undefined : query.status ? query.status : { in: ['PENDING', 'APPROVED'] },
    };
    const records = await prisma.leaveRecord.findMany({
      where,
      take: MAX_REPORT_SOURCE_ROWS + 1,
      orderBy: [{ startDate: query.sortDir === 'desc' ? 'desc' : 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        employeeId: true,
        type: true,
        startDate: true,
        endDate: true,
        reason: true,
        status: true,
        affectsPay: true,
        decidedAt: true,
        employee: { select: { code: true, fullName: true, department: { select: { name: true } } } },
        recordedBy: { select: { fullName: true } },
        decidedBy: { select: { fullName: true } },
      },
    });
    this.base.assertSourceLimit(records.length);

    const rows: ReportRow[] = records.map((r) => {
      const daysInRange = overlapDays(r.startDate, r.endDate, range.from, range.to);
      const paid = PAID_TYPES.includes(r.type);
      return {
        id: r.id,
        employeeId: r.employeeId,
        employeeCode: r.employee.code,
        employeeName: r.employee.fullName,
        department: r.employee.department.name,
        type: r.type,
        startDate: formatDateOnly(r.startDate),
        endDate: formatDateOnly(r.endDate),
        daysInRange,
        paidDays: paid ? daysInRange : 0,
        unpaidDays: paid ? 0 : daysInRange,
        totalDays: inclusiveDays(r.startDate, r.endDate),
        status: r.status,
        affectsPay: r.affectsPay ? 'YES' : 'NO',
        reason: r.reason,
        recordedBy: r.recordedBy.fullName,
        decidedBy: r.decidedBy?.fullName ?? null,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      };
    });

    const byType = new Map<string, number>();
    let approvedDays = 0;
    let pendingDays = 0;
    let leaveDays = 0;
    let absenceDays = 0;
    for (const r of rows) {
      const days = r.daysInRange as number;
      byType.set(r.type as string, (byType.get(r.type as string) ?? 0) + days);
      if (r.status === 'APPROVED') approvedDays += days;
      if (r.status === 'PENDING') pendingDays += days;
      if (LEAVE_TYPES.includes(r.type as LeaveType)) leaveDays += days;
      else absenceDays += days;
    }

    const summary: ReportData['summary'] = [
      { key: 'recordsCount', label: 'عدد السجلات', type: 'int', value: rows.length },
      { key: 'employeesCount', label: 'عدد الموظفين', type: 'int', value: new Set(rows.map((r) => r.employeeId)).size },
      { key: 'leaveDays', label: 'أيام الإجازات', type: 'days', value: leaveDays },
      { key: 'absenceDays', label: 'أيام الغياب', type: 'days', value: absenceDays },
      { key: 'approvedDays', label: 'أيام معتمدة', type: 'days', value: approvedDays },
      { key: 'pendingDays', label: 'أيام بانتظار الاعتماد', type: 'days', value: pendingDays },
    ];
    const charts =
      rows.length === 0
        ? []
        : [
            {
              title: 'الأيام حسب النوع',
              unit: 'days' as const,
              points: (Object.keys(LEAVE_TYPE_LABELS) as (keyof typeof LEAVE_TYPE_LABELS)[])
                .filter((t) => byType.has(t))
                .map((t) => ({ label: LEAVE_TYPE_LABELS[t], value: byType.get(t) ?? 0 })),
            },
          ];
    const notes = [
      'المصدر سجلات الإجازات والغياب المسجَّلة فقط؛ يوم بلا دوام لا يُعدّ غيابًا تلقائيًا.',
      'الأيام أيام تقويمية ضمن فترة التقرير. المدفوع وغير المدفوع يُحددان بنوع السجل.',
      ...(query.status ? [] : ['السجلات المرفوضة والملغاة مستبعدة ما لم تُختر حالتها صراحةً.']),
    ];

    if (view === 'employees') {
      const byEmployee = new Map<string, ReportRow>();
      for (const r of rows) {
        let row = byEmployee.get(r.employeeId as string);
        if (!row) {
          row = { id: r.employeeId, employeeId: r.employeeId, employeeCode: r.employeeCode, employeeName: r.employeeName, department: r.department };
          for (const key of EMPLOYEE_TOTALS) row[key] = 0;
          byEmployee.set(r.employeeId as string, row);
        }
        const days = r.daysInRange as number;
        const add = (key: string, value: number) => (row![key] = (row![key] as number) + value);
        add('recordsCount', 1);
        add('daysInRange', days);
        add('paidDays', r.paidDays as number);
        add('unpaidDays', r.unpaidDays as number);
        add(LEAVE_TYPES.includes(r.type as LeaveType) ? 'leaveDays' : 'absenceDays', days);
        if (r.status === 'PENDING') add('pendingDays', days);
      }
      const dir = query.sortDir === 'desc' ? -1 : 1;
      const employeeRows = [...byEmployee.values()].sort(
        (a, b) => dir * String(a.employeeName).localeCompare(String(b.employeeName), 'ar') || String(a.employeeCode).localeCompare(String(b.employeeCode)),
      );
      return {
        view,
        title: 'تقرير الغياب والإجازات — ملخص حسب الموظف',
        rows: employeeRows.slice(window.skip, window.skip + window.take),
        total: employeeRows.length,
        totals: sumIntColumns(employeeRows, EMPLOYEE_TOTALS),
        summary,
        charts,
        notes,
      };
    }

    return {
      view: 'records',
      title: 'تقرير الغياب والإجازات — تفصيل السجلات',
      rows: rows.slice(window.skip, window.skip + window.take),
      total: rows.length,
      totals: sumIntColumns(rows, RECORD_TOTALS),
      summary,
      charts,
      notes,
    };
  }
}
