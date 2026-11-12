import { Injectable } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { todayInZone } from '../common/utils/dates';
import { SettingsService } from '../settings/settings.module';
import type { ReportQueryDto } from './dto/reports.dto';
import { buildRange, ReportRange, startOfLocalMonth } from './report-range';
import type { ReportRow } from './report-types';

export interface ReportContext {
  range: ReportRange;
  timezone: string;
  currency: string;
  organizationName: string;
}

/** الحد الأقصى لعدد السجلات التي يعالجها تقرير واحد في الذاكرة (تقرير الدوام يحسب التأخير في الخادم). */
export const MAX_REPORT_SOURCE_ROWS = 50_000;

export const ZERO = new Prisma.Decimal(0);

/** مبلغ Decimal → نص بخانتين عشريتين (التمثيل الوحيد للمبالغ في مخرجات التقارير). */
export function moneyText(value: Prisma.Decimal | null | undefined): string {
  return (value ?? ZERO).toFixed(2);
}

export function sumIntColumns(rows: readonly ReportRow[], keys: readonly string[]): ReportRow {
  const totals: ReportRow = {};
  for (const key of keys) totals[key] = 0;
  for (const row of rows) {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === 'number') totals[key] = (totals[key] as number) + value;
    }
  }
  return totals;
}

@Injectable()
export class ReportContextService {
  constructor(
    readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** يحدد الفترة (الافتراضي: من أول الشهر المحلي الحالي إلى اليوم) والمنطقة الزمنية والعملة. */
  async resolve(query: ReportQueryDto): Promise<ReportContext> {
    const settings = await this.settings.getAll();
    const timezone = settings['general.timezone'];
    const today = todayInZone(timezone);
    const to = query.to ?? today;
    const from = query.from ?? (query.to ? startOfLocalMonth(query.to) : startOfLocalMonth(today));
    if (from > to) throw Errors.validation('تاريخ البداية يجب ألا يكون بعد تاريخ النهاية');
    return {
      range: buildRange(from, to, timezone),
      timezone,
      currency: settings['general.currency'],
      organizationName: settings['general.organizationName'],
    };
  }

  /**
   * شرط النطاق على جدول الموظفين: موظف واحد، أو قسم (القسم الحالي للموظف)، أو الجميع — مع البحث.
   * `byDepartment=false` يترك تصفية القسم للمستدعي (تقرير الدوام يصفّي بقسم الوردية نفسها).
   */
  employeeWhere(query: Pick<ReportQueryDto, 'employeeId' | 'departmentId' | 'search'>, byDepartment = true): Prisma.EmployeeWhereInput {
    const where: Prisma.EmployeeWhereInput = {};
    if (query.employeeId) where.id = query.employeeId;
    else if (byDepartment && query.departmentId) where.departmentId = query.departmentId;
    if (query.search) {
      const literal = query.search.replace(/[\\%_]/g, (char) => `\\${char}`);
      where.OR = [
        { fullName: { contains: literal, mode: 'insensitive' } },
        { code: { contains: literal, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  /** الشرط نفسه كـ SQL على جدول الموظفين بالاسم المستعار e. */
  employeeSql(query: ReportQueryDto, extraSearch: Prisma.Sql[] = []): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (query.employeeId) parts.push(Prisma.sql`e."id" = ${query.employeeId}::uuid`);
    else if (query.departmentId) parts.push(Prisma.sql`e."departmentId" = ${query.departmentId}::uuid`);
    if (query.search) {
      const like = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const options = [Prisma.sql`e."fullName" ILIKE ${like}`, Prisma.sql`e."code" ILIKE ${like}`, ...extraSearch.map((s) => Prisma.sql`${s} ILIKE ${like}`)];
      parts.push(Prisma.sql`(${Prisma.join(options, ' OR ')})`);
    }
    return Prisma.join(parts, ' AND ');
  }

  assertSourceLimit(count: number): void {
    if (count > MAX_REPORT_SOURCE_ROWS) {
      throw Errors.validation(
        `عدد السجلات أكبر من الحد الذي يعالجه التقرير (${MAX_REPORT_SOURCE_ROWS}). ضيّق الفترة أو اختر موظفًا أو قسمًا.`,
      );
    }
  }
}
