import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { can, canAny, DASHBOARD_PERIODS, DashboardPeriod } from '@abu-qamar/shared';
import type { AuthContext } from '../common/auth/auth.types';
import { AnyAuthenticated, Auth } from '../common/auth/decorators';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingsModule, SettingsService } from '../settings/settings.module';
import { resolvePeriodRange } from './period';

export class DashboardQueryDto {
  @IsOptional()
  @IsIn(DASHBOARD_PERIODS as readonly string[])
  period: DashboardPeriod = 'day';
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * بطاقات لوحة التحكم الأربع. القيم محسوبة من الجداول الحقيقية دائمًا؛
   * الحقول التي لا يملك المستخدم صلاحية رؤيتها تُعاد null (ولا تُحسب أصلًا).
   */
  async summary(auth: AuthContext, period: DashboardPeriod) {
    const settings = await this.settings.getAll();
    const range = resolvePeriodRange(period, settings['general.timezone'], settings['general.weekStartsOn']);
    const canAttendance = canAny(auth.user, ['attendance.view', 'reports.attendance']);
    const canFinance = can(auth.user, 'finance.view');

    let employeesWorked: number | null = null;
    let totalWorkedMinutes: number | null = null;
    if (canAttendance) {
      const inRange = { status: { not: 'VOIDED' as const }, checkInAt: { gte: range.start, lt: range.end } };
      const [employees, minutes] = await Promise.all([
        this.prisma.workSession.findMany({ where: inRange, distinct: ['employeeId'], select: { employeeId: true } }),
        this.prisma.workSession.aggregate({ where: { ...inRange, status: 'CLOSED' }, _sum: { workedMinutes: true } }),
      ]);
      employeesWorked = employees.length;
      totalWorkedMinutes = minutes._sum.workedMinutes ?? 0;
    }

    let totalPayments: string | null = null;
    let unpaidWages: string | null = null;
    if (canFinance) {
      const [payments, unpaid] = await Promise.all([
        this.prisma.financialTransaction.aggregate({
          where: { type: 'SALARY_PAYMENT', status: 'POSTED', occurredAt: { gte: range.start, lt: range.end } },
          _sum: { amount: true },
        }),
        // المستحق غير المدفوع رصيد قائم حتى الآن (من الفترات المغلقة)، وليس مقيدًا بالفترة المختارة
        this.prisma.payrollEntry.aggregate({
          where: { period: { status: 'CLOSED' } },
          _sum: { netAmount: true, paidAmount: true },
        }),
      ]);
      totalPayments = (payments._sum.amount ?? 0).toString();
      const net = unpaid._sum.netAmount;
      const paid = unpaid._sum.paidAmount;
      unpaidWages = net ? net.minus(paid ?? 0).toFixed(2) : '0.00';
      totalPayments = Number(totalPayments).toFixed(2);
    }

    return {
      period,
      range: { start: range.start, end: range.end },
      currency: settings['general.currency'],
      timezone: settings['general.timezone'],
      employeesWorked,
      totalWorkedMinutes,
      totalPayments,
      unpaidWages,
    };
  }
}

@ApiTags('dashboard')
@ApiCookieAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'ملخص لوحة التحكم لليوم/الأسبوع/الشهر (حسب صلاحيات المستخدم)' })
  summary(@Auth() auth: AuthContext, @Query() query: DashboardQueryDto) {
    return this.dashboard.summary(auth, query.period);
  }
}

@Module({
  imports: [SettingsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
