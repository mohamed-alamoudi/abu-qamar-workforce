import { Controller, Get, Header, Injectable, Module, Query, StreamableFile } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { PassThrough } from 'node:stream';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { Auth, Meta, RequireAnyPermission, RequirePermissions } from '../common/auth/decorators';
import { Errors } from '../common/errors/app-exception';
import { formatDateOnly } from '../common/utils/dates';
import { SettingsModule } from '../settings/settings.module';
import { AbsenceReportService } from './absence-report.service';
import { AttendanceReportService } from './attendance-report.service';
import { AbsenceReportQueryDto, AttendanceReportQueryDto, FinancialReportQueryDto, PaymentsReportQueryDto, ReportQueryDto } from './dto/reports.dto';
import { exportFileName } from './export/format';
import { assertPdfFonts, writePdf } from './export/pdf';
import { writeXlsx } from './export/xlsx';
import { FinancialReportService } from './financial-report.service';
import { PaymentsReportService } from './payments-report.service';
import { DEFAULT_VIEWS, projectRow, projectTotals, selectColumns, toPublicColumn, viewColumns } from './report-columns';
import { ReportContext, ReportContextService } from './report-context';
import { REPORT_PERMISSIONS, ReportData, ReportKey, ReportResult, RowWindow } from './report-types';

const EXPORT_LIMIT = 5_000;
const PRIVATE_CACHE = 'private, no-store';

@Injectable()
class ReportsService {
  constructor(private readonly context: ReportContextService, private readonly audit: AuditService) {}

  async options(search?: string, selectedId?: string) {
    const term = typeof search === 'string' ? search.trim().slice(0, 100) : '';
    const prisma = this.context.prisma;
    const employeeFields = { id: true, code: true, fullName: true } as const;
    const [employees, departments, selected] = await Promise.all([
      prisma.employee.findMany({
        where: this.context.employeeWhere({ search: term }),
        select: employeeFields,
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        take: 50,
      }),
      prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      typeof selectedId === 'string' && isUUID(selectedId)
        ? prisma.employee.findUnique({ where: { id: selectedId }, select: employeeFields })
        : null,
    ]);
    if (selected && !employees.some((employee) => employee.id === selected.id)) employees.unshift(selected);
    return { employees, departments };
  }

  async run(
    report: ReportKey,
    query: ReportQueryDto,
    build: (ctx: ReportContext, window: RowWindow) => Promise<ReportData>,
    actor: AuthContext,
    meta: RequestMeta,
  ): Promise<ReportResult | StreamableFile> {
    const view = query.view ?? DEFAULT_VIEWS[report];
    const selected = selectColumns(report, view, query.columns);
    const context = await this.context.resolve(query);
    const format = query.format;
    const exporting = format !== 'json';
    const window = exporting ? { skip: 0, take: EXPORT_LIMIT + 1 } :
      { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
    const data = await build(context, window);
    if (exporting && data.total > EXPORT_LIMIT) {
      throw Errors.validation(`حد التصدير ${EXPORT_LIMIT} صف. ضيّق الفترة أو اختر نطاقًا أصغر.`);
    }
    const result: ReportResult = {
      report, view, title: data.title,
      range: { from: formatDateOnly(context.range.from), to: formatDateOnly(context.range.to) },
      timezone: context.timezone, currency: context.currency,
      columns: selected.map(toPublicColumn),
      availableColumns: viewColumns(report, view).map(toPublicColumn),
      items: data.rows.map((row) => projectRow(row, selected)),
      total: data.total, page: query.page, pageSize: query.pageSize,
      totalPages: Math.ceil(data.total / query.pageSize),
      totals: projectTotals(data.totals, selected),
      summary: data.summary, charts: data.charts, notes: data.notes,
    };
    if (format === 'json') return result;
    if (format === 'pdf') assertPdfFonts();
    await this.audit.log({
      action: 'report.exported', actor, meta, entityType: 'report',
      metadata: {
        report, view, format, range: result.range, employeeId: query.employeeId,
        departmentId: query.departmentId, columns: selected.map((column) => column.key), rowCount: result.total,
      },
    });
    const filters = [
      query.employeeId ? 'النطاق: موظف واحد' : query.departmentId ? 'النطاق: قسم واحد' : 'النطاق: الجميع',
      ...(query.search ? [`البحث: ${query.search}`] : []),
    ];
    const stream = new PassThrough();
    const file = new StreamableFile(stream, {
      type: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${exportFileName(report, view, result.range.from, result.range.to, format)}"`,
    });
    const input = { result, organizationName: context.organizationName, filters, generatedBy: actor.user.fullName, generatedAt: new Date() };
    void Promise.resolve().then(async () => {
      await (format === 'pdf' ? writePdf(input, stream) : writeXlsx(input, stream));
      if (!stream.writableEnded) stream.end();
    }).catch((error: Error) => stream.destroy(error));
    return file;
  }
}

@ApiTags('reports')
@ApiCookieAuth()
@Controller('reports')
class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly attendance: AttendanceReportService,
    private readonly absence: AbsenceReportService,
    private readonly financial: FinancialReportService,
    private readonly payments: PaymentsReportService,
  ) {}

  @Get('options')
  @Header('Cache-Control', PRIVATE_CACHE)
  @RequireAnyPermission(...Object.values(REPORT_PERMISSIONS))
  options(@Query('search') search?: string, @Query('selectedId') selectedId?: string) {
    return this.reports.options(search, selectedId);
  }

  @Get('attendance')
  @Header('Cache-Control', PRIVATE_CACHE)
  @RequirePermissions('reports.attendance')
  @ApiOperation({ summary: 'عرض وتصدير تقرير الدوام' })
  attendanceReport(@Query() query: AttendanceReportQueryDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.reports.run('attendance', query, (ctx, window) => this.attendance.build(query, ctx, window), actor, meta);
  }

  @Get('absence')
  @Header('Cache-Control', PRIVATE_CACHE)
  @RequirePermissions('reports.absence')
  @ApiOperation({ summary: 'عرض وتصدير تقرير الغياب والإجازات' })
  absenceReport(@Query() query: AbsenceReportQueryDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.reports.run('absence', query, (ctx, window) => this.absence.build(query, ctx, window), actor, meta);
  }

  @Get('financial')
  @Header('Cache-Control', PRIVATE_CACHE)
  @RequirePermissions('reports.financial')
  @ApiOperation({ summary: 'عرض وتصدير التقرير المالي' })
  financialReport(@Query() query: FinancialReportQueryDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.reports.run('financial', query, (ctx, window) => this.financial.build(query, ctx, window), actor, meta);
  }

  @Get('payments')
  @Header('Cache-Control', PRIVATE_CACHE)
  @RequirePermissions('reports.payments')
  @ApiOperation({ summary: 'عرض وتصدير تقرير الدفعات' })
  paymentsReport(@Query() query: PaymentsReportQueryDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.reports.run('payments', query, (ctx, window) => this.payments.build(query, ctx, window), actor, meta);
  }
}

@Module({
  imports: [SettingsModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportContextService, AttendanceReportService, AbsenceReportService, FinancialReportService, PaymentsReportService],
})
export class ReportsModule {}
