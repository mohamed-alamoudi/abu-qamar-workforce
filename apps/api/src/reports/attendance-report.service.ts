import { Injectable } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { formatDateOnly } from '../common/utils/dates';
import type { AttendanceReportQueryDto } from './dto/reports.dto';
import { computeTimings, parseWeeklyPattern, ScheduleInfo, ShiftInfo } from './lateness';
import { MAX_REPORT_SOURCE_ROWS, ReportContext, ReportContextService, sumIntColumns } from './report-context';
import { inclusiveDays, wholeMinutes } from './report-range';
import type { ReportChart, ReportData, ReportRow, RowWindow } from './report-types';

const SESSION_TOTALS = [
  'workedMinutes',
  'breakCount',
  'unpaidBreakMinutes',
  'paidBreakMinutes',
  'lateMinutes',
  'earlyLeaveMinutes',
  'overtimeApprovedMinutes',
  'overtimePendingMinutes',
];
const EMPLOYEE_TOTALS = [...SESSION_TOTALS, 'daysWorked', 'sessionsCount', 'lateCount', 'openSessions'];

const DAY_MS = 86_400_000;

/**
 * تقرير الدوام: الحضور والانصراف، ساعات العمل، الاستراحات، التأخير، العمل الإضافي.
 * يقرأ work_sessions (دون الملغاة) بتاريخ الوردية المحلي workDate.
 * كل القيم دقائق صحيحة، فتُجمع في الخادم دون أي تقريب.
 */
@Injectable()
export class AttendanceReportService {
  constructor(private readonly base: ReportContextService) {}

  async build(query: AttendanceReportQueryDto, ctx: ReportContext, window: RowWindow): Promise<ReportData> {
    const prisma = this.base.prisma;
    const { range, timezone } = ctx;
    const view = query.view ?? 'sessions';

    const departmentId = query.employeeId ? undefined : query.departmentId;
    const workDate = { gte: range.from, lte: range.to };
    // عند تصفية القسم نحسب التأخير بعد قراءة الورديات الأخرى لنفس الموظف، ثم نعرض ورديات القسم فقط.
    const where: Prisma.WorkSessionWhereInput = {
      status: { not: 'VOIDED' },
      workDate,
      employee: {
        ...this.base.employeeWhere(query, false),
        ...(departmentId ? { workSessions: { some: { departmentId, workDate, status: { not: 'VOIDED' } } } } : {}),
      },
    };

    const sessions = await prisma.workSession.findMany({
      where,
      take: MAX_REPORT_SOURCE_ROWS + 1,
      orderBy: [{ checkInAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        employeeId: true,
        departmentId: true,
        workDate: true,
        checkInAt: true,
        checkOutAt: true,
        status: true,
        approvalStatus: true,
        workedMinutes: true,
        source: true,
        employee: { select: { code: true, fullName: true, department: { select: { name: true } } } },
        department: { select: { name: true } },
        breaks: { select: { startAt: true, endAt: true, isPaid: true } },
        overtimeEntries: { select: { minutes: true, status: true } },
      },
    });
    this.base.assertSourceLimit(sessions.length);

    const employeeIds = [...new Set(sessions.map((s) => s.employeeId))];
    const [schedules, shifts] = employeeIds.length
      ? await Promise.all([
          prisma.employeeSchedule.findMany({
            where: {
              employeeId: { in: employeeIds },
              effectiveFrom: { lte: range.to },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: range.from } }],
            },
            select: { employeeId: true, isFlexible: true, weeklyPattern: true, effectiveFrom: true, effectiveTo: true },
          }),
          prisma.scheduleShift.findMany({
            where: {
              employeeId: { in: employeeIds },
              startAt: { gte: new Date(range.startInstant.getTime() - DAY_MS), lt: new Date(range.endInstant.getTime() + DAY_MS) },
            },
            select: { employeeId: true, startAt: true, endAt: true },
          }),
        ])
      : [[], []];

    const schedulesByEmployee = new Map<string, ScheduleInfo[]>();
    for (const s of schedules) {
      const list = schedulesByEmployee.get(s.employeeId) ?? [];
      list.push({ isFlexible: s.isFlexible, pattern: parseWeeklyPattern(s.weeklyPattern), effectiveFrom: s.effectiveFrom, effectiveTo: s.effectiveTo });
      schedulesByEmployee.set(s.employeeId, list);
    }
    const shiftsByEmployee = new Map<string, ShiftInfo[]>();
    for (const s of shifts) {
      const list = shiftsByEmployee.get(s.employeeId) ?? [];
      list.push({ startAt: s.startAt, endAt: s.endAt });
      shiftsByEmployee.set(s.employeeId, list);
    }
    const timings = computeTimings(sessions, shiftsByEmployee, schedulesByEmployee, timezone);

    let rows: ReportRow[] = sessions.filter((s) => !departmentId || s.departmentId === departmentId).map((s) => {
      const timing = timings.get(s.id)!;
      let unpaidBreakMinutes = 0;
      let paidBreakMinutes = 0;
      for (const b of s.breaks) {
        if (!b.endAt) continue;
        const duration = wholeMinutes(b.startAt, b.endAt);
        if (b.isPaid) paidBreakMinutes += duration;
        else unpaidBreakMinutes += duration;
      }
      let overtimeApprovedMinutes = 0;
      let overtimePendingMinutes = 0;
      for (const o of s.overtimeEntries) {
        if (o.status === 'APPROVED') overtimeApprovedMinutes += o.minutes;
        else if (o.status !== 'REJECTED') overtimePendingMinutes += o.minutes;
      }
      return {
        id: s.id,
        employeeId: s.employeeId,
        employeeCode: s.employee.code,
        employeeName: s.employee.fullName,
        department: s.department.name,
        currentDepartment: s.employee.department.name,
        workDate: formatDateOnly(s.workDate),
        checkInAt: s.checkInAt.toISOString(),
        checkOutAt: s.checkOutAt ? s.checkOutAt.toISOString() : null,
        workedMinutes: s.workedMinutes ?? 0,
        breakCount: s.breaks.length,
        unpaidBreakMinutes,
        paidBreakMinutes,
        scheduledStart: timing.scheduledStart ? timing.scheduledStart.toISOString() : null,
        lateMinutes: timing.lateMinutes,
        earlyLeaveMinutes: timing.earlyLeaveMinutes,
        overtimeApprovedMinutes,
        overtimePendingMinutes,
        status: s.status,
        approvalStatus: s.approvalStatus,
        source: s.source,
      };
    });

    if (query.status) rows = rows.filter((r) => r.status === query.status);
    if (query.approvalStatus) rows = rows.filter((r) => r.approvalStatus === query.approvalStatus);
    if (query.lateOnly) rows = rows.filter((r) => typeof r.lateMinutes === 'number' && r.lateMinutes > 0);

    // إضافي غير مرتبط بوردية محددة (مثل تجاوز الحد الأسبوعي): يُنسب للموظف لا للوردية
    const unlinked = query.status || query.approvalStatus || query.lateOnly ? [] : await prisma.overtimeEntry.findMany({
      where: {
        sessionId: null,
        status: { not: 'REJECTED' },
        workDate: { gte: range.from, lte: range.to },
        employee: this.base.employeeWhere(query),
      },
      take: MAX_REPORT_SOURCE_ROWS + 1,
      select: { employeeId: true, minutes: true, status: true, employee: { select: { code: true, fullName: true, department: { select: { name: true } } } } },
    });
    this.base.assertSourceLimit(unlinked.length);
    let unlinkedApproved = 0;
    let unlinkedPending = 0;
    for (const o of unlinked) {
      if (o.status === 'APPROVED') unlinkedApproved += o.minutes;
      else unlinkedPending += o.minutes;
    }

    const lateRows = rows.filter((r) => typeof r.lateMinutes === 'number' && r.lateMinutes > 0);
    const summary: ReportData['summary'] = [
      { key: 'sessionsCount', label: 'عدد الورديات', type: 'int', value: rows.length },
      { key: 'employeesCount', label: 'عدد الموظفين', type: 'int', value: new Set(rows.map((r) => r.employeeId)).size },
      { key: 'openSessions', label: 'ورديات دون انصراف', type: 'int', value: rows.filter((r) => r.status === 'OPEN').length },
      { key: 'lateCount', label: 'مرات التأخير', type: 'int', value: lateRows.length },
    ];
    if (unlinkedApproved + unlinkedPending > 0) {
      summary.push(
        { key: 'unlinkedOvertimeApprovedMinutes', label: 'إضافي معتمد غير مرتبط بوردية', type: 'minutes', value: unlinkedApproved },
        { key: 'unlinkedOvertimePendingMinutes', label: 'إضافي بانتظار الاعتماد غير مرتبط بوردية', type: 'minutes', value: unlinkedPending },
      );
    }

    const notes = [
      'التأخير والانصراف المبكر يُحسبان فقط حيث يوجد جدول عمل (وردية مجدولة أو نمط أسبوعي غير مرن)؛ غير ذلك يظهر «—».',
      'الورديات الملغاة مستبعدة. الوردية دون انصراف تُحسب ساعاتها صفرًا حتى تُغلق.',
    ];

    const charts = this.charts(rows, ctx);
    const dir = query.sortDir === 'desc' ? -1 : 1;

    if (view === 'employees') {
      const byEmployee = new Map<string, { row: ReportRow; days: Set<string> }>();
      const ensure = (id: string, code: string, name: string, department: string) => {
        let row = byEmployee.get(id);
        if (!row) {
          row = { row: { id, employeeId: id, employeeCode: code, employeeName: name, department }, days: new Set() };
          for (const key of EMPLOYEE_TOTALS) row.row[key] = 0;
          byEmployee.set(id, row);
        }
        return row;
      };
      const add = (row: ReportRow, key: string, value: unknown) => {
        if (typeof value === 'number') row[key] = (row[key] as number) + value;
      };
      for (const r of rows) {
        const { row, days } = ensure(r.employeeId as string, r.employeeCode as string, r.employeeName as string, r.currentDepartment as string);
        for (const key of SESSION_TOTALS) add(row, key, r[key]);
        add(row, 'sessionsCount', 1);
        if (typeof r.lateMinutes === 'number' && r.lateMinutes > 0) add(row, 'lateCount', 1);
        if (r.status === 'OPEN') add(row, 'openSessions', 1);
        days.add(r.workDate as string);
      }
      for (const o of unlinked) {
        const { row } = ensure(o.employeeId, o.employee.code, o.employee.fullName, o.employee.department.name);
        add(row, o.status === 'APPROVED' ? 'overtimeApprovedMinutes' : 'overtimePendingMinutes', o.minutes);
      }
      const employeeRows: ReportRow[] = [...byEmployee.values()]
        .map(({ days, row }): ReportRow => ({ ...row, daysWorked: days.size }))
        .sort((a, b) => dir * String(a.employeeName).localeCompare(String(b.employeeName), 'ar') || String(a.employeeCode).localeCompare(String(b.employeeCode)));
      return {
        view,
        title: 'تقرير الدوام — ملخص حسب الموظف',
        rows: employeeRows.slice(window.skip, window.skip + window.take),
        total: employeeRows.length,
        totals: sumIntColumns(employeeRows, EMPLOYEE_TOTALS),
        summary: summary.filter((s) => !s.key.startsWith('unlinked')),
        charts,
        notes: [...notes, 'الإضافي غير المرتبط بوردية محددة مضاف إلى مجموع الموظف.'],
      };
    }

    if (dir === -1) rows.reverse();
    return {
      view: 'sessions',
      title: 'تقرير الدوام — تفصيل الورديات',
      rows: rows.slice(window.skip, window.skip + window.take),
      total: rows.length,
      totals: sumIntColumns(rows, SESSION_TOTALS),
      summary,
      charts,
      notes,
    };
  }

  private charts(rows: readonly ReportRow[], ctx: ReportContext): ReportChart[] {
    if (rows.length === 0) return [];
    // حسب اليوم للفترات القصيرة، وحسب الشهر للطويلة
    const byMonth = inclusiveDays(ctx.range.from, ctx.range.to) > 62;
    const perPeriod = new Map<string, number>();
    const perDepartment = new Map<string, number>();
    for (const r of rows) {
      const day = r.workDate as string;
      const key = byMonth ? day.slice(0, 7) : day;
      perPeriod.set(key, (perPeriod.get(key) ?? 0) + (r.workedMinutes as number));
      const department = r.department as string;
      perDepartment.set(department, (perDepartment.get(department) ?? 0) + (r.workedMinutes as number));
    }
    const charts: ReportChart[] = [
      {
        title: byMonth ? 'ساعات العمل حسب الشهر' : 'ساعات العمل حسب اليوم',
        unit: 'minutes',
        points: [...perPeriod.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label, value })),
      },
    ];
    if (perDepartment.size > 1) {
      charts.push({
        title: 'ساعات العمل حسب القسم',
        unit: 'minutes',
        points: [...perDepartment.entries()].sort(([, a], [, b]) => b - a).map(([label, value]) => ({ label, value })),
      });
    }
    return charts;
  }
}
