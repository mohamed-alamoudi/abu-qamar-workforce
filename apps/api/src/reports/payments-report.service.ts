import { Injectable } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { formatDateOnly } from '../common/utils/dates';
import type { PaymentsReportQueryDto } from './dto/reports.dto';
import { METHOD_LABELS } from './report-columns';
import { moneyText, ReportContext, ReportContextService } from './report-context';
import type { ReportChart, ReportData, ReportRow, RowWindow } from './report-types';

type Decimal = Prisma.Decimal;
type GroupRow = { count: bigint; amount: Decimal | null } & Record<string, unknown>;

/**
 * تقرير الدفعات: كل الدفعات، أو مجمّعة حسب الموظف / الفترة / طريقة الدفع / من نفّذ.
 * المصدر financial_transactions. الافتراضي دفعات الرواتب المسجَّلة (غير المعكوسة).
 * «من نفّذ» هو من دفع (paidById)، وإن لم يُسجَّل فمن أدخل العملية (createdById).
 * وقت الدفعة يُقارن بحدود اليوم المحلي في منطقة الإعدادات.
 */
@Injectable()
export class PaymentsReportService {
  constructor(private readonly base: ReportContextService) {}

  private where(query: PaymentsReportQueryDto, ctx: ReportContext): Prisma.Sql {
    const types = query.type === 'ALL' ? ['SALARY_PAYMENT', 'ADVANCE_DISBURSEMENT'] : [query.type ?? 'SALARY_PAYMENT'];
    const parts: Prisma.Sql[] = [
      Prisma.sql`t."occurredAt" >= ${ctx.range.startInstant} AND t."occurredAt" < ${ctx.range.endInstant}`,
      Prisma.sql`t."type"::text IN (${Prisma.join(types)})`,
      this.base.employeeSql(query, [Prisma.sql`t."reference"`, Prisma.sql`t."receivedBy"`]),
    ];
    const status = query.status ?? 'POSTED';
    if (status !== 'ALL') parts.push(Prisma.sql`t."status"::text = ${status}`);
    if (query.method) parts.push(Prisma.sql`t."method"::text = ${query.method}`);
    if (query.executorId) parts.push(Prisma.sql`COALESCE(t."paidById", t."createdById") = ${query.executorId}::uuid`);
    if (query.periodId) parts.push(Prisma.sql`pe."periodId" = ${query.periodId}::uuid`);
    return Prisma.join(parts, ' AND ');
  }

  /** الجداول الموصولة المشتركة بين التفصيل والتجميع. */
  private from(): Prisma.Sql {
    return Prisma.sql`
      FROM "financial_transactions" t
      JOIN "employees" e ON e."id" = t."employeeId"
      JOIN "departments" d ON d."id" = e."departmentId"
      LEFT JOIN "payroll_entries" pe ON pe."id" = t."payrollEntryId"
      LEFT JOIN "payroll_periods" pp ON pp."id" = pe."periodId"
      LEFT JOIN "users" px ON px."id" = COALESCE(t."paidById", t."createdById")
      LEFT JOIN "users" pb ON pb."id" = t."paidById"
      JOIN "users" cb ON cb."id" = t."createdById"`;
  }

  async build(query: PaymentsReportQueryDto, ctx: ReportContext, window: RowWindow): Promise<ReportData> {
    const prisma = this.base.prisma;
    const view = query.view ?? 'payments';
    const where = this.where(query, ctx);
    const from = this.from();
    const order = query.sortDir === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;

    // الإجماليات: المسجَّلة تُجمع، والمعكوسة تُذكر منفصلة ولا تدخل المجموع
    const [overall] = await prisma.$queryRaw<{ count: bigint; postedCount: bigint; amount: Decimal | null; reversed: Decimal | null }[]>(Prisma.sql`
      SELECT COUNT(*) AS "count",
             COUNT(*) FILTER (WHERE t."status" = 'POSTED') AS "postedCount",
             SUM(t."amount") FILTER (WHERE t."status" = 'POSTED') AS "amount",
             SUM(t."amount") FILTER (WHERE t."status" = 'REVERSED') AS "reversed"
      ${from} WHERE ${where}`);
    const byMethod = await prisma.$queryRaw<{ method: string | null; amount: Decimal | null }[]>(Prisma.sql`
      SELECT t."method"::text AS "method", SUM(t."amount") AS "amount"
      ${from} WHERE ${where} AND t."status" = 'POSTED' GROUP BY t."method" ORDER BY SUM(t."amount") DESC`);

    const summary: ReportData['summary'] = [
      { key: 'paymentsCount', label: 'عدد الدفعات', type: 'int', value: Number(overall.postedCount) },
      { key: 'totalAmount', label: 'مجموع الدفعات', type: 'money', value: moneyText(overall.amount) },
    ];
    if (overall.reversed && !overall.reversed.isZero()) {
      summary.push({ key: 'reversedAmount', label: 'دفعات معكوسة (غير محسوبة)', type: 'money', value: moneyText(overall.reversed) });
    }
    const methodChart: ReportChart[] = byMethod.length
      ? [
          {
            title: 'الدفعات حسب طريقة الدفع',
            unit: 'money',
            points: byMethod.map((m) => ({
              label: m.method ? (METHOD_LABELS as Record<string, string>)[m.method] ?? m.method : 'غير محددة',
              value: moneyText(m.amount),
            })),
          },
        ]
      : [];
    const notes = [
      query.type === 'ALL'
        ? 'يشمل التقرير دفعات الرواتب وصرف السلف.'
        : query.type === 'ADVANCE_DISBURSEMENT'
          ? 'يعرض التقرير صرف السلف فقط.'
          : 'يعرض التقرير دفعات الرواتب فقط.',
      'المجموع يشمل العمليات المسجَّلة فقط؛ الدفعات المعكوسة لا تُجمع.',
    ];
    const totals: ReportRow = { amount: moneyText(overall.amount), paymentsCount: Number(overall.postedCount) };

    if (view === 'payments') {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT t."id", t."employeeId", t."occurredAt", e."code" AS "employeeCode", e."fullName" AS "employeeName", d."name" AS "department",
               t."type"::text AS "type", t."amount", t."method"::text AS "method", pb."fullName" AS "paidBy", t."receivedBy", t."reference",
               pp."label" AS "period", t."status"::text AS "status", t."note", cb."fullName" AS "createdBy"
        ${from} WHERE ${where}
        ORDER BY t."occurredAt" ${order}, t."id" ASC LIMIT ${window.take} OFFSET ${window.skip}`);
      return {
        view,
        title: 'تقرير الدفعات — كل الدفعات',
        rows: rows.map((r) => ({
          ...(r as ReportRow),
          occurredAt: (r.occurredAt as Date).toISOString(),
          amount: moneyText(r.amount as Decimal),
        })),
        total: Number(overall.count),
        totals,
        summary,
        charts: methodChart,
        notes,
      };
    }

    // التجميع يشمل المسجَّلة فقط حتى يطابق مجموع الصفوف الإجمالي
    const posted = Prisma.sql`${where} AND t."status" = 'POSTED'`;
    const page = Prisma.sql`LIMIT ${window.take} OFFSET ${window.skip}`;
    let groups: GroupRow[];
    let rows: ReportRow[];
    let title: string;
    let chart: ReportChart[] = methodChart;
    let groupKey: Prisma.Sql;
    const chartOf = (chartTitle: string, points: { label: string; value: string }[]): ReportChart[] =>
      points.length ? [{ title: chartTitle, unit: 'money', points: points.slice(0, 15) }] : [];

    if (view === 'byEmployee') {
      groupKey = Prisma.sql`e."id"`;
      groups = await prisma.$queryRaw<GroupRow[]>(Prisma.sql`
        SELECT e."id", e."code", e."fullName", d."name" AS "department", COUNT(*) AS "count", SUM(t."amount") AS "amount", COUNT(*) OVER () AS "groups"
        ${from} WHERE ${posted} GROUP BY e."id", e."code", e."fullName", d."name"
        ORDER BY e."fullName" ${order}, e."code" ASC ${page}`);
      title = 'تقرير الدفعات — حسب الموظف';
      rows = groups.map((g) => ({
        id: g.id as string,
        employeeId: g.id as string,
        employeeCode: g.code as string,
        employeeName: g.fullName as string,
        department: g.department as string,
        paymentsCount: Number(g.count),
        amount: moneyText(g.amount),
      }));
      chart = chartOf('الدفعات حسب الموظف', rows.map((r) => ({ label: r.employeeName as string, value: r.amount as string })));
    } else if (view === 'byPeriod') {
      groupKey = Prisma.sql`pp."id"`;
      groups = await prisma.$queryRaw<GroupRow[]>(Prisma.sql`
        SELECT pp."id", pp."label", pp."startDate", pp."endDate", COUNT(*) AS "count", SUM(t."amount") AS "amount", COUNT(*) OVER () AS "groups"
        ${from} WHERE ${posted} GROUP BY pp."id", pp."label", pp."startDate", pp."endDate"
        ORDER BY pp."startDate" ${order} NULLS LAST, pp."id" ASC ${page}`);
      title = 'تقرير الدفعات — حسب الفترة';
      rows = groups.map((g) => ({
        id: (g.id as string | null) ?? 'none',
        period: (g.label as string | null) ?? 'غير مرتبطة بفترة رواتب',
        periodStart: g.startDate ? formatDateOnly(g.startDate as Date) : null,
        periodEnd: g.endDate ? formatDateOnly(g.endDate as Date) : null,
        paymentsCount: Number(g.count),
        amount: moneyText(g.amount),
      }));
      chart = chartOf('الدفعات حسب الفترة', rows.map((r) => ({ label: r.period as string, value: r.amount as string })));
    } else if (view === 'byMethod') {
      groupKey = Prisma.sql`t."method"`;
      groups = await prisma.$queryRaw<GroupRow[]>(Prisma.sql`
        SELECT t."method"::text AS "method", COUNT(*) AS "count", SUM(t."amount") AS "amount", COUNT(*) OVER () AS "groups"
        ${from} WHERE ${posted} GROUP BY t."method" ORDER BY SUM(t."amount") ${order}, t."method" ASC ${page}`);
      title = 'تقرير الدفعات — حسب طريقة الدفع';
      rows = groups.map((g) => ({
        id: (g.method as string | null) ?? 'NONE',
        method: (g.method as string | null) ?? 'NONE',
        paymentsCount: Number(g.count),
        amount: moneyText(g.amount),
      }));
    } else {
      groupKey = Prisma.sql`px."id"`;
      groups = await prisma.$queryRaw<GroupRow[]>(Prisma.sql`
        SELECT px."id", px."fullName", px."username", COUNT(*) AS "count", SUM(t."amount") AS "amount", COUNT(*) OVER () AS "groups"
        ${from} WHERE ${posted} GROUP BY px."id", px."fullName", px."username"
        ORDER BY px."fullName" ${order}, px."id" ASC ${page}`);
      title = 'تقرير الدفعات — حسب من نفّذ';
      rows = groups.map((g) => ({
        id: g.id as string,
        executor: g.fullName as string,
        executorUsername: g.username as string,
        paymentsCount: Number(g.count),
        amount: moneyText(g.amount),
      }));
      chart = chartOf('الدفعات حسب من نفّذ', rows.map((r) => ({ label: r.executor as string, value: r.amount as string })));
    }

    let total = groups.length > 0 ? Number(groups[0].groups) : 0;
    // صفحة بعد آخر النتائج: نافذة فارغة لا تعني أن العدد صفر
    if (groups.length === 0 && window.skip > 0) {
      const [count] = await prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT COUNT(*) AS "total" FROM (SELECT 1 ${from} WHERE ${posted} GROUP BY ${groupKey}) AS grouped`);
      total = Number(count.total);
    }
    return { view, title, rows, total, totals, summary, charts: chart, notes };
  }
}
