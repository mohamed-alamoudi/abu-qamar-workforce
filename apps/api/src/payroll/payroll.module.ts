import { Body, Controller, Delete, Get, Headers, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { Auth, Meta, RequirePermissions, RequireReauth } from '../common/auth/decorators';
import { SettingsModule } from '../settings/settings.module';
import { AdjustmentsService } from './adjustments.service';
import { AdvanceDto, DebtDto, LedgerQueryDto, PaymentDetailsDto, PaymentDto, ReversalDto, SettlementDto } from './dto/ledger.dto';
import { AdjustmentsQueryDto, CreateAdjustmentDto, CreatePeriodDto, PeriodsQueryDto, ReopenPeriodDto } from './dto/payroll.dto';
import { LedgerService } from './ledger.service';
import { PayrollService } from './payroll.service';

const FinanceRead = () => RequirePermissions('finance.view');
const IdempotencyHeader = () => ApiHeader({ name: 'Idempotency-Key', required: true });

@ApiTags('الرواتب')
@ApiCookieAuth()
@Controller('payroll')
class PayrollController {
  constructor(private readonly periods: PayrollService, private readonly adjustments: AdjustmentsService) {}

  @Get('periods')
  @FinanceRead()
  list(@Query() query: PeriodsQueryDto) {
    return this.periods.list(query);
  }

  @Get('periods/:id')
  @FinanceRead()
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.periods.get(id);
  }

  @Get('periods/:id/checklist')
  @FinanceRead()
  checklist(@Param('id', ParseUUIDPipe) id: string) {
    return this.periods.checklist(id);
  }

  @Post('periods')
  create(@Body() dto: CreatePeriodDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.create(dto, actor, meta);
  }

  @Post('periods/prepare-current')
  prepareCurrent(@Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.prepareCurrent(actor, meta);
  }

  @Post('periods/:id/reopen')
  @RequireReauth()
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReopenPeriodDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.reopen(id, dto.reason, actor, meta);
  }

  @Delete('periods/:id')
  @RequireReauth()
  remove(@Param('id', ParseUUIDPipe) id: string, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.remove(id, actor, meta);
  }

  @Post('periods/:id/refresh-unpaid')
  @RequireReauth()
  refreshClosed(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReopenPeriodDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.refreshClosed(id, dto.reason, actor, meta);
  }

  @Post('periods/:id/calculate')
  calculate(@Param('id', ParseUUIDPipe) id: string, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.run(id, 'calculate', actor, meta);
  }

  @Post('periods/:id/review')
  review(@Param('id', ParseUUIDPipe) id: string, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.run(id, 'review', actor, meta);
  }

  @Post('periods/:id/approve')
  @RequireReauth()
  approve(@Param('id', ParseUUIDPipe) id: string, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.run(id, 'approve', actor, meta);
  }

  @Post('periods/:id/close')
  @RequireReauth()
  close(@Param('id', ParseUUIDPipe) id: string, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.periods.run(id, 'close', actor, meta);
  }

  @Get('adjustments')
  @FinanceRead()
  listAdjustments(@Query() query: AdjustmentsQueryDto) {
    return this.adjustments.list(query);
  }

  @Post('adjustments')
  createAdjustment(@Body() dto: CreateAdjustmentDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.adjustments.create(dto, actor, meta);
  }

  @Post('adjustments/:id/approve')
  @RequireReauth()
  approveAdjustment(@Param('id', ParseUUIDPipe) id: string, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.adjustments.decide(id, 'APPROVED', actor, meta);
  }

  @Post('adjustments/:id/cancel')
  cancelAdjustment(@Param('id', ParseUUIDPipe) id: string, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.adjustments.decide(id, 'CANCELLED', actor, meta);
  }
}

@ApiTags('المالية')
@ApiCookieAuth()
@Controller()
class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('employees/:id/financial-balances')
  @FinanceRead()
  balances(@Param('id', ParseUUIDPipe) id: string) {
    return this.ledger.balances(id);
  }

  @Get('payments')
  @FinanceRead()
  payments(@Query() query: LedgerQueryDto) {
    return this.ledger.list('payments', query);
  }

  @Get('advances')
  @FinanceRead()
  advances(@Query() query: LedgerQueryDto) {
    return this.ledger.list('advances', query);
  }

  @Get('debts')
  @FinanceRead()
  debts(@Query() query: LedgerQueryDto) {
    return this.ledger.list('debts', query);
  }

  @Get('settlements')
  @FinanceRead()
  settlements(@Query() query: LedgerQueryDto) {
    return this.ledger.list('settlements', query);
  }

  @Get('financial-transactions')
  @FinanceRead()
  transactions(@Query() query: LedgerQueryDto) {
    return this.ledger.list('transactions', query);
  }

  @Post('payments')
  @RequireReauth()
  @IdempotencyHeader()
  payment(@Body() dto: PaymentDto, @Headers('idempotency-key') key: string | undefined, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.ledger.payment(dto, key, { actor, meta });
  }

  @Post('advances')
  @RequireReauth()
  @IdempotencyHeader()
  advance(@Body() dto: AdvanceDto, @Headers('idempotency-key') key: string | undefined, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.ledger.advance(dto, key, { actor, meta });
  }

  @Post('settlements')
  @RequireReauth()
  @IdempotencyHeader()
  settle(@Body() dto: SettlementDto, @Headers('idempotency-key') key: string | undefined, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.ledger.settle(dto, key, { actor, meta });
  }

  @Post('debts')
  debt(@Body() dto: DebtDto, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.ledger.debt(dto, { actor, meta });
  }

  @Post('advances/:id/repay')
  @RequireReauth()
  @IdempotencyHeader()
  repayAdvance(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDetailsDto, @Headers('idempotency-key') key: string | undefined, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.ledger.repay('ADVANCE', id, dto, key, { actor, meta });
  }

  @Post('debts/:id/repay')
  @RequireReauth()
  @IdempotencyHeader()
  repayDebt(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDetailsDto, @Headers('idempotency-key') key: string | undefined, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.ledger.repay('DEBT', id, dto, key, { actor, meta });
  }

  @Post('financial-transactions/:id/reverse')
  @RequireReauth()
  @IdempotencyHeader()
  reverse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReversalDto, @Headers('idempotency-key') key: string | undefined, @Auth() actor: AuthContext, @Meta() meta: RequestMeta) {
    return this.ledger.reverse(id, dto, key, { actor, meta });
  }
}

@Module({
  imports: [SettingsModule],
  controllers: [PayrollController, LedgerController],
  providers: [PayrollService, LedgerService, AdjustmentsService],
  exports: [PayrollService],
})
export class PayrollModule {}
