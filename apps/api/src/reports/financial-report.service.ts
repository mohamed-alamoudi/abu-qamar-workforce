import { Injectable } from '@nestjs/common';
import { PayrollComponentType, Prisma } from '@abu-qamar/database';
import { formatDateOnly } from '../common/utils/dates';
import type { FinancialReportQueryDto } from './dto/reports.dto';
import { TARGET_TYPE_LABELS } from './report-columns';
import { moneyText, ReportContext, ReportContextService, ZERO } from './report-context';
import { localDateOf } from './report-range';
import type { ReportChart, ReportData, ReportRow, RowWindow } from './report-types';

type Decimal = Prisma.Decimal;

const COMPONENT_COLUMNS: Record<PayrollComponentType, string> = {
  REGULAR_WAGE: 'regularWage',
  OVERTIME: 'overtimeWage',
  BONUS: 'bonuses',
  DEDUCTION: 'otherDeductions',
  ABSENCE_DEDUCTION: 'absenceDeductions',
  ADJUSTMENT: 'adjustments',
};

const EMPLOYEE_MONEY = [
  'grossAmount',
  'deductionsAmount',
  'netAmount',
  'paidAmount',
  'unpaidAmount',
  'advancesDisbursed',
  'advancesOutstanding',
  'debtsIncurred',
  'debtsOutstanding',
  'settlementsAmount',
] as const;

type EmployeeSqlRow = { id: string; code: string; fullName: string; department: string } & Record<(typeof EMPLOYEE_MONEY)[number], Decimal>;

const moneyChart = (title: string, points: [string, Decimal | null | undefined][]): ReportChart[] =>
  points.some(([, v]) => v && !v.isZero()) ? [{ title, unit: 'money', points: points.map(([label, v]) => ({ label, value: moneyText(v) })) }] : [];

/**
 * التقرير المالي: الأجور المستحقة والمدفوعة والأرصدة، السلف والديون، التسويات.
 * كل المبالغ تُجمع في PostgreSQL (numeric) أو بـ Decimal — لا تمر بأرقام عائمة — وتخرج نصوصًا بخانتين.
 *
 * قواعد الإسناد إلى الفترة:
 *  • مستحق الراتب يتبع الفترة التي ينتهي فيها (payroll_entries.periodEnd ضمن فترة التقرير).
 *  • السلفة بتاريخ صرفها، والدين بتاريخ نشوئه، والتسوية بوقت تنفيذها — بحدود اليوم المحلي.
 *  • «القائم» من السلف والديون رصيد حالي (حتى الآن) وليس مقيدًا بفترة التقرير.
 */
@Injectable()
export class FinancialReportService {
  constructor(private readonly base: ReportContextService) {}

  build(query: FinancialReportQueryDto, ctx: ReportContext, window: RowWindow): Promise<ReportData> {
    switch (query.view ?? 'employees') {
      case 'entries':
        return this.entries(query, ctx, window);
      case 'advances':
        return this.accounts('advances', query, ctx, window);
      case 'debts':
        return this.accounts('debts', query, ctx, window);
      case 'settlements':
        return this.settlements(query, ctx, window);
      default:
        return this.employees(query, ctx, window);
    }
  }

  private periodStatusNote(query: FinancialReportQueryDto): string {
    return query.periodStatus === 'ALL'
      ? 'تشمل المستحقات فترات الرواتب بكل حالاتها، ومنها المسودات غير النهائية.'
      : query.periodStatus && query.periodStatus !== 'CLOSED'
        ? 'المستحقات المعروضة من فترات غير مغلقة، فهي غير نهائية.'
        : 'المستحقات من فترات الرواتب المغلقة والمعتمدة فقط.';
  }

  // ───────────────────────── ملخص حسب الموظف ─────────────────────────

  private async employees(query: FinancialReportQueryDto, ctx: ReportContext, window: RowWindow): Promise<ReportData> {
    const { range } = ctx;
    const status = query.periodStatus ?? 'CLOSED';
    const periodCondition = status === 'ALL' ? Prisma.sql`TRUE` : Prisma.sql`pp."status"::text = ${status}`;
    const outstanding = query.outstandingOnly
      ? Prisma.sql`("unpaidAmount" > 0 OR "advancesOutstanding" > 0 OR "debtsOutstanding" > 0)`
      : Prisma.sql`TRUE`;

    const cte = Prisma.sql`
      WITH emp AS (
        SELECT e."id", e."code", e."fullName", d."name" AS "department"
        FROM "employees" e JOIN "departments" d ON d."id" = e."departmentId"
        WHERE ${this.base.employeeSql(query)}
      ),
      pay AS (
        SELECT pe."employeeId",
               SUM(pe."grossAmount") AS gross, SUM(pe."deductionsAmount") AS ded,
               SUM(pe."netAmount") AS net, SUM(pe."paidAmount") AS paid
        FROM "payroll_entries" pe JOIN "payroll_periods" pp ON pp."id" = pe."periodId"
        WHERE pe."periodEnd" >= ${range.from}::date AND pe."periodEnd" <= ${range.to}::date AND ${periodCondition}
        GROUP BY pe."employeeId"
      ),
      adv AS (
        SELECT "employeeId",
               SUM("principalAmount") FILTER (WHERE "disbursedAt" >= ${range.startInstant} AND "disbursedAt" < ${range.endInstant}) AS disbursed,
               SUM("remainingBalance") FILTER (WHERE "status" = 'OPEN') AS outstanding
        FROM "advance_accounts" WHERE "status" <> 'CANCELLED' GROUP BY "employeeId"
      ),
      debt AS (
        SELECT "employeeId",
               SUM("principalAmount") FILTER (WHERE "incurredAt" >= ${range.startInstant} AND "incurredAt" < ${range.endInstant}) AS incurred,
               SUM("remainingBalance") FILTER (WHERE "status" = 'OPEN') AS outstanding
        FROM "debt_accounts" WHERE "status" <> 'CANCELLED' GROUP BY "employeeId"
      ),
      setl AS (
        SELECT "employeeId", SUM("amount") AS amount
        FROM "financial_transactions"
        WHERE "type" = 'SETTLEMENT' AND "status" = 'POSTED'
          AND "occurredAt" >= ${range.startInstant} AND "occurredAt" < ${range.endInstant}
        GROUP BY "employeeId"
      ),
      base AS (
        SELECT emp.*,
               COALESCE(pay.gross, 0) AS "grossAmount", COALESCE(pay.ded, 0) AS "deductionsAmount",
               COALESCE(pay.net, 0) AS "netAmount", COALESCE(pay.paid, 0) AS "paidAmount",
               COALESCE(pay.net, 0) - COALESCE(pay.paid, 0) AS "unpaidAmount",
               COALESCE(adv.disbursed, 0) AS "advancesDisbursed", COALESCE(adv.outstanding, 0) AS "advancesOutstanding",
               COALESCE(debt.incurred, 0) AS "debtsIncurred", COALESCE(debt.outstanding, 0) AS "debtsOutstanding",
               COALESCE(setl.amount, 0) AS "settlementsAmount"
        FROM emp
        LEFT JOIN pay ON pay."employeeId" = emp."id"
        LEFT JOIN adv ON adv."employeeId" = emp."id"
        LEFT JOIN debt ON debt."employeeId" = emp."id"
        LEFT JOIN setl ON setl."employeeId" = emp."id"
        WHERE pay."employeeId" IS NOT NULL OR COALESCE(adv.disbursed, 0) > 0 OR COALESCE(adv.outstanding, 0) > 0
           OR COALESCE(debt.incurred, 0) > 0 OR COALESCE(debt.outstanding, 0) > 0 OR setl."employeeId" IS NOT NULL
      )`;

    const order = query.sortDir === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const prisma = this.base.prisma;
    const [rows, totalsRows] = await Promise.all([
      prisma.$queryRaw<EmployeeSqlRow[]>(
        Prisma.sql`${cte} SELECT * FROM base WHERE ${outstanding} ORDER BY "fullName" ${order}, "code" ASC LIMIT ${window.take} OFFSET ${window.skip}`,
      ),
      prisma.$queryRaw<({ count: bigint } & Record<(typeof EMPLOYEE_MONEY)[number], Decimal | null>)[]>(
        Prisma.sql`${cte} SELECT COUNT(*) AS "count", ${Prisma.join(
          EMPLOYEE_MONEY.map((key) => Prisma.sql`SUM(${Prisma.raw(`"${key}"`)}) AS ${Prisma.raw(`"${key}"`)}`),
          ', ',
        )} FROM base WHERE ${outstanding}`,
      ),
    ]);
    const totalsRow = totalsRows[0];
    const totals: ReportRow = {};
    for (const key of EMPLOYEE_MONEY) totals[key] = moneyText(totalsRow[key]);

    return {
      view: 'employees',
      title: 'التقرير المالي — ملخص حسب الموظف',
      rows: rows.map((r) => {
        const row: ReportRow = { id: r.id, employeeId: r.id, employeeCode: r.code, employeeName: r.fullName, department: r.department };
        for (const key of EMPLOYEE_MONEY) row[key] = moneyText(r[key]);
        return row;
      }),
      total: Number(totalsRow.count),
      totals,
      summary: [{ key: 'employeesCount', label: 'عدد الموظفين', type: 'int', value: Number(totalsRow.count) }],
      charts: moneyChart('الملخص المالي', [
        ['صافي المستحق', totalsRow.netAmount],
        ['المدفوع', totalsRow.paidAmount],
        ['غير المدفوع', totalsRow.unpaidAmount],
        ['السلف القائمة', totalsRow.advancesOutstanding],
        ['الديون القائمة', totalsRow.debtsOutstanding],
      ]),
      notes: [
        this.periodStatusNote(query),
        'المستحق يُنسب إلى الفترة التي ينتهي فيها. «المدفوع» يشمل دفعات تلك المستحقات والتسويات السارية عليها.',
        'السلف والديون القائمة أرصدة حالية غير مقيدة بفترة التقرير، ولا تُدمج في الراتب.',
      ],
    };
  }

  // ───────────────────────── مستحقات الفترات ─────────────────────────

  private async entries(query: FinancialReportQueryDto, ctx: ReportContext, window: RowWindow): Promise<ReportData> {
    const prisma = this.base.prisma;
    const { range } = ctx;
    const status = query.periodStatus ?? 'CLOSED';
    const where: Prisma.PayrollEntryWhereInput = {
      periodEnd: { gte: range.from, lte: range.to },
      employee: this.base.employeeWhere(query),
      ...(status === 'ALL' ? {} : { period: { status } }),
      ...(query.outstandingOnly ? { paidAmount: { lt: prisma.payrollEntry.fields.netAmount } } : {}),
    };
    const dir = query.sortDir === 'desc' ? 'desc' : 'asc';

    const [entries, aggregate, componentTotals] = await Promise.all([
      prisma.payrollEntry.findMany({
        where,
        orderBy: [{ periodStart: dir }, { employee: { fullName: 'asc' } }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          employeeId: true,
          periodStart: true,
          periodEnd: true,
          grossAmount: true,
          deductionsAmount: true,
          netAmount: true,
          paidAmount: true,
          employee: { select: { code: true, fullName: true, department: { select: { name: true } } } },
          period: { select: { label: true, status: true, frequency: true } },
        },
      }),
      prisma.payrollEntry.aggregate({
        where,
        _count: { _all: true },
        _sum: { grossAmount: true, deductionsAmount: true, netAmount: true, paidAmount: true },
      }),
      prisma.payrollEntryComponent.groupBy({ by: ['type'], where: { entry: where }, _sum: { amount: true } }),
    ]);

    const components = entries.length
      ? await prisma.payrollEntryComponent.groupBy({
          by: ['entryId', 'type'],
          where: { entryId: { in: entries.map((e) => e.id) } },
          _sum: { amount: true },
        })
      : [];
    const componentsByEntry = new Map<string, Partial<Record<string, Decimal>>>();
    for (const c of components) {
      const map = componentsByEntry.get(c.entryId) ?? {};
      map[COMPONENT_COLUMNS[c.type]] = c._sum.amount ?? ZERO;
      componentsByEntry.set(c.entryId, map);
    }

    const sum = aggregate._sum;
    const totals: ReportRow = {
      grossAmount: moneyText(sum.grossAmount),
      deductionsAmount: moneyText(sum.deductionsAmount),
      netAmount: moneyText(sum.netAmount),
      paidAmount: moneyText(sum.paidAmount),
      unpaidAmount: moneyText((sum.netAmount ?? ZERO).minus(sum.paidAmount ?? ZERO)),
    };
    for (const column of Object.values(COMPONENT_COLUMNS)) totals[column] = moneyText(ZERO);
    for (const c of componentTotals) totals[COMPONENT_COLUMNS[c.type]] = moneyText(c._sum.amount);

    return {
      view: 'entries',
      title: 'التقرير المالي — مستحقات الفترات',
      rows: entries.map((e) => {
        const parts = componentsByEntry.get(e.id) ?? {};
        const row: ReportRow = {
          id: e.id,
          employeeId: e.employeeId,
          employeeCode: e.employee.code,
          employeeName: e.employee.fullName,
          department: e.employee.department.name,
          periodLabel: e.period.label,
          periodStart: formatDateOnly(e.periodStart),
          periodEnd: formatDateOnly(e.periodEnd),
          frequency: e.period.frequency,
          periodStatus: e.period.status,
          grossAmount: moneyText(e.grossAmount),
          deductionsAmount: moneyText(e.deductionsAmount),
          netAmount: moneyText(e.netAmount),
          paidAmount: moneyText(e.paidAmount),
          unpaidAmount: moneyText(e.netAmount.minus(e.paidAmount)),
        };
        for (const column of Object.values(COMPONENT_COLUMNS)) row[column] = moneyText(parts[column]);
        return row;
      }),
      total: aggregate._count._all,
      totals,
      summary: [{ key: 'entriesCount', label: 'عدد المستحقات', type: 'int', value: aggregate._count._all }],
      charts: moneyChart('المستحقات', [
        ['إجمالي الأجر المكتسب', sum.grossAmount],
        ['صافي المستحق', sum.netAmount],
        ['المدفوع', sum.paidAmount],
        ['غير المدفوع', (sum.netAmount ?? ZERO).minus(sum.paidAmount ?? ZERO)],
      ]),
      notes: [this.periodStatusNote(query), 'غير المدفوع يبقى مرتبطًا بفترته الأصلية ولا يُحتسب أجرًا جديدًا في فترة لاحقة.'],
    };
  }

  // ───────────────────────── السلف والديون ─────────────────────────

  private async accounts(kind: 'advances' | 'debts', query: FinancialReportQueryDto, ctx: ReportContext, window: RowWindow): Promise<ReportData> {
    const prisma = this.base.prisma;
    const { range } = ctx;
    const dir = query.sortDir === 'desc' ? 'desc' : 'asc';
    const inRange = { gte: range.startInstant, lt: range.endInstant };
    const common = {
      employee: this.base.employeeWhere(query),
      // الملغاة لا تدخل الإجماليات ما لم تُطلب صراحةً
      status: query.accountStatus ?? { not: 'CANCELLED' as const },
      ...(query.outstandingOnly ? { remainingBalance: { gt: 0 } } : {}),
    };
    const employee = { select: { code: true, fullName: true, department: { select: { name: true } } } };
    const createdBy = { select: { fullName: true } };

    let rows: ReportRow[];
    let count: number;
    let principal: Decimal | null;
    let remaining: Decimal | null;

    if (kind === 'advances') {
      const where: Prisma.AdvanceAccountWhereInput = { ...common, disbursedAt: inRange };
      const [items, aggregate] = await Promise.all([
        prisma.advanceAccount.findMany({ where, orderBy: [{ disbursedAt: dir }, { id: 'asc' }], skip: window.skip, take: window.take, include: { employee, createdBy } }),
        prisma.advanceAccount.aggregate({ where, _count: { _all: true }, _sum: { principalAmount: true, remainingBalance: true } }),
      ]);
      rows = items.map((a) => ({
        id: a.id,
        employeeId: a.employeeId,
        employeeCode: a.employee.code,
        employeeName: a.employee.fullName,
        department: a.employee.department.name,
        disbursedAt: a.disbursedAt.toISOString(),
        principalAmount: moneyText(a.principalAmount),
        repaidAmount: moneyText(a.principalAmount.minus(a.remainingBalance)),
        remainingBalance: moneyText(a.remainingBalance),
        status: a.status,
        note: a.note,
        createdBy: a.createdBy.fullName,
      }));
      count = aggregate._count._all;
      principal = aggregate._sum.principalAmount;
      remaining = aggregate._sum.remainingBalance;
    } else {
      const where: Prisma.DebtAccountWhereInput = { ...common, incurredAt: inRange };
      const [items, aggregate] = await Promise.all([
        prisma.debtAccount.findMany({ where, orderBy: [{ incurredAt: dir }, { id: 'asc' }], skip: window.skip, take: window.take, include: { employee, createdBy } }),
        prisma.debtAccount.aggregate({ where, _count: { _all: true }, _sum: { principalAmount: true, remainingBalance: true } }),
      ]);
      rows = items.map((d) => ({
        id: d.id,
        employeeId: d.employeeId,
        employeeCode: d.employee.code,
        employeeName: d.employee.fullName,
        department: d.employee.department.name,
        incurredAt: d.incurredAt.toISOString(),
        principalAmount: moneyText(d.principalAmount),
        repaidAmount: moneyText(d.principalAmount.minus(d.remainingBalance)),
        remainingBalance: moneyText(d.remainingBalance),
        status: d.status,
        reason: d.reason,
        createdBy: d.createdBy.fullName,
      }));
      count = aggregate._count._all;
      principal = aggregate._sum.principalAmount;
      remaining = aggregate._sum.remainingBalance;
    }

    const repaid = (principal ?? ZERO).minus(remaining ?? ZERO);
    const noun = kind === 'advances' ? 'السلف' : 'الديون';
    return {
      view: kind,
      title: `التقرير المالي — ${noun}`,
      rows,
      total: count,
      totals: { principalAmount: moneyText(principal), repaidAmount: moneyText(repaid), remainingBalance: moneyText(remaining) },
      summary: [{ key: 'accountsCount', label: `عدد ${noun}`, type: 'int', value: count }],
      charts: moneyChart(noun, [
        ['الأصل', principal],
        ['المسدَّد', repaid],
        ['المتبقي', remaining],
      ]),
      notes: [
        kind === 'advances' ? 'السلف المعروضة هي التي صُرفت ضمن فترة التقرير.' : 'الديون المعروضة هي التي نشأت ضمن فترة التقرير.',
        'الرصيد المتبقي هو الرصيد الحالي. الملغاة مستبعدة ما لم تُختر حالتها صراحةً.',
      ],
    };
  }

  // ───────────────────────── التسويات ─────────────────────────

  private async settlements(query: FinancialReportQueryDto, ctx: ReportContext, window: RowWindow): Promise<ReportData> {
    const prisma = this.base.prisma;
    const { range, timezone } = ctx;
    const transaction: Prisma.FinancialTransactionWhereInput = {
      type: 'SETTLEMENT',
      occurredAt: { gte: range.startInstant, lt: range.endInstant },
      employee: this.base.employeeWhere(query),
    };
    const where: Prisma.SettlementAllocationWhereInput = { transaction, ...(query.targetType ? { targetType: query.targetType } : {}) };
    const posted: Prisma.SettlementAllocationWhereInput = { ...where, transaction: { ...transaction, status: 'POSTED' } };
    const dir = query.sortDir === 'desc' ? 'desc' : 'asc';

    const [items, count, postedSum, byTarget] = await Promise.all([
      prisma.settlementAllocation.findMany({
        where,
        orderBy: [{ transaction: { occurredAt: dir } }, { id: 'asc' }],
        skip: window.skip,
        take: window.take,
        select: {
          id: true,
          targetType: true,
          amount: true,
          transaction: {
            select: {
              employeeId: true,
              occurredAt: true,
              status: true,
              reference: true,
              note: true,
              employee: { select: { code: true, fullName: true, department: { select: { name: true } } } },
              createdBy: { select: { fullName: true } },
            },
          },
          payrollEntry: { select: { period: { select: { label: true } } } },
          advanceAccount: { select: { disbursedAt: true, principalAmount: true } },
          debtAccount: { select: { incurredAt: true, principalAmount: true, reason: true } },
          adjustment: { select: { reason: true } },
        },
      }),
      prisma.settlementAllocation.count({ where }),
      prisma.settlementAllocation.aggregate({ where: posted, _sum: { amount: true } }),
      prisma.settlementAllocation.groupBy({ by: ['targetType'], where: posted, _sum: { amount: true } }),
    ]);

    const describe = (a: (typeof items)[number]): string | null => {
      if (a.payrollEntry) return `مستحق فترة: ${a.payrollEntry.period.label}`;
      if (a.advanceAccount) return `سلفة ${moneyText(a.advanceAccount.principalAmount)} بتاريخ ${localDateOf(a.advanceAccount.disbursedAt, timezone)}`;
      if (a.debtAccount) {
        const reason = a.debtAccount.reason ? ` — ${a.debtAccount.reason}` : '';
        return `دين ${moneyText(a.debtAccount.principalAmount)} بتاريخ ${localDateOf(a.debtAccount.incurredAt, timezone)}${reason}`;
      }
      if (a.adjustment) return `فرق راتب: ${a.adjustment.reason}`;
      return null;
    };

    return {
      view: 'settlements',
      title: 'التقرير المالي — التسويات',
      rows: items.map((a) => ({
        id: a.id,
        employeeId: a.transaction.employeeId,
        employeeCode: a.transaction.employee.code,
        employeeName: a.transaction.employee.fullName,
        department: a.transaction.employee.department.name,
        occurredAt: a.transaction.occurredAt.toISOString(),
        targetType: a.targetType,
        target: describe(a),
        amount: moneyText(a.amount),
        status: a.transaction.status,
        reference: a.transaction.reference,
        note: a.transaction.note,
        createdBy: a.transaction.createdBy.fullName,
      })),
      total: count,
      totals: { amount: moneyText(postedSum._sum.amount) },
      summary: [{ key: 'settlementsCount', label: 'عدد بنود التسوية', type: 'int', value: count }],
      charts:
        byTarget.length > 0
          ? [
              {
                title: 'التسويات حسب نوع الالتزام',
                unit: 'money',
                points: byTarget.map((t) => ({ label: TARGET_TYPE_LABELS[t.targetType], value: moneyText(t._sum.amount) })),
              },
            ]
          : [],
      notes: ['كل بند تسوية مرتبط بالالتزام الأصلي. الإجمالي يشمل العمليات المسجَّلة فقط؛ المعكوسة تظهر في القائمة دون أن تُجمع.'],
    };
  }
}
