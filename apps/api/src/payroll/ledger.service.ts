import { Injectable } from '@nestjs/common';
import { FinancialTransaction, Prisma } from '@abu-qamar/database';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { paginate, toSkipTake } from '../common/dto/pagination.dto';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AdvanceDto, DebtDto, LedgerQueryDto, PaymentDetailsDto, PaymentDto, ReversalDto, SettlementDto } from './dto/ledger.dto';
import { needsPayrollRefresh } from './payroll-entry-state';

type Tx = Prisma.TransactionClient;
type Actor = { actor: AuthContext; meta: RequestMeta };
type Obligation = 'ADVANCE' | 'DEBT';
const money = (amount: string) => new Prisma.Decimal(amount);
const when = (value?: string) => value ? new Date(value) : new Date();
const employeeSelect = { id: true, code: true, fullName: true } as const;

@Injectable()
export class LedgerService {
  constructor(private readonly db: PrismaService, private readonly audit: AuditService) {}

  private async employee(tx: Tx, id: string) {
    const row = await tx.employee.findUnique({ where: { id }, select: employeeSelect });
    if (!row) throw Errors.notFound('الموظف غير موجود');
    return row;
  }

  private async paymentDetails(tx: Tx, dto: PaymentDetailsDto, actorId: string) {
    if (dto.paidById && !await tx.user.findUnique({ where: { id: dto.paidById }, select: { id: true } })) {
      throw Errors.notFound('المستخدم الدافع غير موجود');
    }
    return {
      amount: money(dto.amount), occurredAt: when(dto.occurredAt), method: dto.method,
      paidById: dto.paidById ?? actorId, receivedBy: dto.receivedBy, reference: dto.reference, note: dto.note,
    };
  }

  private async entry(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM payroll_entries WHERE id = ${id}::uuid FOR UPDATE`;
    const entry = await tx.payrollEntry.findUnique({ where: { id }, include: { period: true } });
    if (!entry) throw Errors.notFound('مستحق الراتب غير موجود');
    if (entry.period.status !== 'CLOSED') throw Errors.conflict('تُصرف المستحقات بعد إغلاق فترة الرواتب');
    if (needsPayrollRefresh(entry.snapshot)) throw Errors.conflict('تغير الأجر. حدّث المستحقات غير المصروفة في الفترة قبل تسجيل دفعة أو تسوية');
    return entry;
  }

  private async account(tx: Tx, type: Obligation, id: string) {
    if (type === 'ADVANCE') {
      await tx.$queryRaw`SELECT id FROM advance_accounts WHERE id = ${id}::uuid FOR UPDATE`;
      const account = await tx.advanceAccount.findUnique({ where: { id } });
      if (!account) throw Errors.notFound('السلفة غير موجودة');
      return account;
    }
    await tx.$queryRaw`SELECT id FROM debt_accounts WHERE id = ${id}::uuid FOR UPDATE`;
    const account = await tx.debtAccount.findUnique({ where: { id } });
    if (!account) throw Errors.notFound('الدين غير موجود');
    return account;
  }

  private async changeAccount(tx: Tx, type: Obligation, id: string, remainingBalance: Prisma.Decimal,
    transaction: FinancialTransaction, movement: 'REPAYMENT' | 'SETTLEMENT' | 'REVERSAL', cancelled = false) {
    const status = cancelled ? 'CANCELLED' : remainingBalance.isZero() ? 'SETTLED' : 'OPEN';
    const data = { status, remainingBalance } as const;
    if (type === 'ADVANCE') {
      await tx.advanceAccount.update({ where: { id }, data });
      return;
    }
    await tx.debtAccount.update({ where: { id }, data });
    await tx.debtMovement.create({ data: {
      debtAccountId: id, type: movement, amount: transaction.amount, balanceAfter: remainingBalance,
      transactionId: transaction.id, createdById: transaction.createdById,
    } });
  }

  private checkBalance(amount: Prisma.Decimal, balance: Prisma.Decimal) {
    if (amount.gt(balance)) throw Errors.conflict('المبلغ يتجاوز الرصيد المتبقي');
  }

  private async post(
    key: string | undefined, type: FinancialTransaction['type'], context: Actor,
    perform: (tx: Tx, idempotencyKey: string, actorId: string) => Promise<FinancialTransaction>,
  ) {
    if (!key || !/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) throw Errors.validation('يلزم مفتاح منع التكرار صالح في ترويسة Idempotency-Key');
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(406202, hashtext(${key}))::text AS locked`;
      const existing = await tx.financialTransaction.findUnique({ where: { idempotencyKey: key } });
      if (existing) {
        if (existing.type !== type) throw Errors.conflict('مفتاح منع التكرار مستخدم لعملية مالية من نوع آخر');
        return { ...existing, status: 'POSTED' as const };
      }
      const transaction = await perform(tx, key, context.actor.user.id);
      await this.audit.log({ ...context, action: `finance.${type.toLowerCase()}`, entityType: 'financial_transaction',
        entityId: transaction.id, after: JSON.parse(JSON.stringify(transaction)) }, tx);
      return transaction;
    });
  }

  payment(dto: PaymentDto, key: string | undefined, context: Actor) {
    return this.post(key, 'SALARY_PAYMENT', context, async (tx, idempotencyKey, createdById) => {
      const entry = await this.entry(tx, dto.payrollEntryId);
      const details = await this.paymentDetails(tx, dto, createdById);
      this.checkBalance(details.amount, entry.netAmount.minus(entry.paidAmount));
      const transaction = await tx.financialTransaction.create({ data: {
        ...details, type: 'SALARY_PAYMENT', employeeId: entry.employeeId, payrollEntryId: entry.id, idempotencyKey, createdById,
      } });
      await tx.payrollEntry.update({ where: { id: entry.id }, data: { paidAmount: { increment: details.amount } } });
      return transaction;
    });
  }

  advance(dto: AdvanceDto, key: string | undefined, context: Actor) {
    return this.post(key, 'ADVANCE_DISBURSEMENT', context, async (tx, idempotencyKey, createdById) => {
      await this.employee(tx, dto.employeeId);
      const details = await this.paymentDetails(tx, dto, createdById);
      const account = await tx.advanceAccount.create({ data: {
        employeeId: dto.employeeId, principalAmount: details.amount, remainingBalance: details.amount,
        disbursedAt: details.occurredAt, note: dto.note, createdById,
      } });
      return tx.financialTransaction.create({ data: {
        ...details, type: 'ADVANCE_DISBURSEMENT', employeeId: dto.employeeId, advanceAccountId: account.id, idempotencyKey, createdById,
      } });
    });
  }

  debt(dto: DebtDto, context: Actor) {
    return this.db.$transaction(async (tx) => {
      await this.employee(tx, dto.employeeId);
      const amount = money(dto.amount);
      const createdById = context.actor.user.id;
      const account = await tx.debtAccount.create({ data: {
        employeeId: dto.employeeId, principalAmount: amount, remainingBalance: amount, reason: dto.reason,
        incurredAt: when(dto.occurredAt), createdById,
      } });
      await tx.debtMovement.create({ data: { debtAccountId: account.id, type: 'INITIAL', amount, balanceAfter: amount, createdById } });
      await this.audit.log({ ...context, action: 'finance.debt.create', entityType: 'debt_account', entityId: account.id,
        after: JSON.parse(JSON.stringify(account)) }, tx);
      return account;
    });
  }

  repay(type: Obligation, id: string, dto: PaymentDetailsDto, key: string | undefined, context: Actor) {
    const transactionType = type === 'ADVANCE' ? 'ADVANCE_REPAYMENT' : 'DEBT_REPAYMENT';
    return this.post(key, transactionType, context, async (tx, idempotencyKey, createdById) => {
      const account = await this.account(tx, type, id);
      const details = await this.paymentDetails(tx, dto, createdById);
      if (account.status !== 'OPEN') throw Errors.conflict('الالتزام غير مفتوح للسداد');
      this.checkBalance(details.amount, account.remainingBalance);
      const transaction = await tx.financialTransaction.create({ data: {
        ...details, type: transactionType, employeeId: account.employeeId, idempotencyKey, createdById,
        ...(type === 'ADVANCE' ? { advanceAccountId: id } : { debtAccountId: id }),
      } });
      await this.changeAccount(tx, type, id, account.remainingBalance.minus(details.amount), transaction, 'REPAYMENT');
      return transaction;
    });
  }

  settle(dto: SettlementDto, key: string | undefined, context: Actor) {
    return this.post(key, 'SETTLEMENT', context, async (tx, idempotencyKey, createdById) => {
      const entry = await this.entry(tx, dto.payrollEntryId);
      const account = await this.account(tx, dto.targetType, dto.targetId);
      if (entry.employeeId !== account.employeeId || account.status !== 'OPEN') {
        throw Errors.conflict('اختر التزامًا مفتوحًا لنفس الموظف');
      }
      const amount = money(dto.amount);
      this.checkBalance(amount, entry.netAmount.minus(entry.paidAmount));
      this.checkBalance(amount, account.remainingBalance);
      const accountLink = dto.targetType === 'ADVANCE' ? { advanceAccountId: account.id } : { debtAccountId: account.id };
      const transaction = await tx.financialTransaction.create({ data: {
        employeeId: entry.employeeId, type: 'SETTLEMENT', amount, occurredAt: when(dto.occurredAt),
        note: dto.reason, payrollEntryId: entry.id, ...accountLink, idempotencyKey, createdById,
        allocations: { create: [
          { targetType: 'PAYROLL_ENTRY', payrollEntryId: entry.id, amount },
          { targetType: dto.targetType, ...accountLink, amount },
        ] },
      } });
      await tx.payrollEntry.update({ where: { id: entry.id }, data: { paidAmount: { increment: amount } } });
      await this.changeAccount(tx, dto.targetType, account.id, account.remainingBalance.minus(amount), transaction, 'SETTLEMENT');
      return transaction;
    });
  }

  reverse(id: string, { reason, recoverableAmount }: ReversalDto, key: string | undefined, context: Actor) {
    return this.post(key, 'REVERSAL', context, async (tx, idempotencyKey, createdById) => {
      await tx.$queryRaw`SELECT id FROM financial_transactions WHERE id = ${id}::uuid FOR UPDATE`;
      const original = await tx.financialTransaction.findUnique({ where: { id } });
      if (!original) throw Errors.notFound('العملية الأصلية غير موجودة');
      if (original.status !== 'POSTED' || original.type === 'REVERSAL' || original.type === 'REFUND') {
        throw Errors.conflict('لا يمكن عكس هذه العملية');
      }
      const { employeeId, amount, payrollEntryId, advanceAccountId, debtAccountId } = original;
      const recoverable = recoverableAmount ? money(recoverableAmount) : null;
      if (recoverable && !['SALARY_PAYMENT', 'ADVANCE_DISBURSEMENT'].includes(original.type)) {
        throw Errors.validation('مبلغ الاسترداد متاح عند عكس دفعة راتب أو صرف سلفة');
      }
      if (recoverable) this.checkBalance(recoverable, amount);
      const entry = payrollEntryId && await this.entry(tx, payrollEntryId);
      const type = advanceAccountId ? 'ADVANCE' : 'DEBT';
      const accountId = advanceAccountId ?? debtAccountId;
      const account = accountId && await this.account(tx, type, accountId);
      const isDisbursement = original.type === 'ADVANCE_DISBURSEMENT';
      if (isDisbursement && (!account || !account.remainingBalance.eq(account.principalAmount))) {
        throw Errors.conflict('اعكس عمليات سداد السلفة وتسوياتها قبل عكس صرفها');
      }
      if (entry && entry.paidAmount.lt(amount)) throw Errors.conflict('الرصيد المسدد لا يسمح بعكس هذه العملية');
      const reversal = await tx.financialTransaction.create({ data: {
        type: 'REVERSAL', employeeId, amount, occurredAt: new Date(), reversesId: id, correctionReason: reason,
        payrollEntryId, advanceAccountId, debtAccountId, idempotencyKey, createdById,
      } });
      await tx.financialTransaction.update({ where: { id }, data: { status: 'REVERSED' } });
      if (entry) await tx.payrollEntry.update({ where: { id: entry.id }, data: { paidAmount: { decrement: amount } } });
      if (account) {
        const balance = isDisbursement ? money('0') : account.remainingBalance.plus(amount);
        await this.changeAccount(tx, type, account.id, balance, reversal, 'REVERSAL', isDisbursement);
      }
      if (recoverable) {
        const debt = await tx.debtAccount.create({ data: {
          employeeId, principalAmount: recoverable, remainingBalance: recoverable,
          reason: 'مبلغ مستلم يُسترد بعد عكس العملية المالية', incurredAt: reversal.occurredAt, createdById,
          movements: { create: {
            type: 'INITIAL', amount: recoverable, balanceAfter: recoverable, transactionId: reversal.id, createdById,
          } },
        } });
        await this.audit.log({ ...context, action: 'finance.reversal.recovery', entityType: 'debt_account',
          entityId: debt.id, after: { originalId: id, reversalId: reversal.id, amount: recoverable.toFixed(2) } }, tx);
      }
      return reversal;
    });
  }

  async balances(employeeId: string) {
    return this.db.$transaction(async (tx) => {
      await this.employee(tx, employeeId);
      const entries = await tx.payrollEntry.findMany({ where: { employeeId, period: { status: 'CLOSED' } },
        include: { period: { select: { label: true, frequency: true } } }, orderBy: { periodStart: 'desc' } });
      const advances = await tx.advanceAccount.aggregate({ where: { employeeId, status: 'OPEN' }, _sum: { remainingBalance: true } });
      const debts = await tx.debtAccount.aggregate({ where: { employeeId, status: 'OPEN' }, _sum: { remainingBalance: true } });
      const totals = await tx.financialTransaction.groupBy({ by: ['type'], where: {
        employeeId, status: 'POSTED', type: { in: ['SALARY_PAYMENT', 'SETTLEMENT'] },
      }, _sum: { amount: true } });
      const total = (type: 'SALARY_PAYMENT' | 'SETTLEMENT') => totals.find((row) => row.type === type)?._sum.amount ?? money('0');
      return {
        gross: entries.reduce((sum, entry) => sum.plus(entry.grossAmount), money('0')),
        net: entries.reduce((sum, entry) => sum.plus(entry.netAmount), money('0')),
        paid: total('SALARY_PAYMENT'), settled: total('SETTLEMENT'),
        outstanding: entries.reduce((sum, entry) => sum.plus(entry.netAmount.minus(entry.paidAmount)), money('0')),
        advances: advances._sum.remainingBalance ?? money('0'), debts: debts._sum.remainingBalance ?? money('0'),
        entries: entries.map(({ snapshot: _snapshot, ...entry }) => ({ ...entry, outstanding: entry.netAmount.minus(entry.paidAmount) })),
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async list(kind: 'transactions' | 'settlements' | 'payments' | 'advances' | 'debts', query: LedgerQueryDto) {
    const base = { employeeId: query.employeeId };
    const options = { ...toSkipTake(query), include: { employee: { select: employeeSelect } } };
    if (kind === 'advances') {
      const [items, total] = await this.db.$transaction([
        this.db.advanceAccount.findMany({ ...options, where: base, orderBy: [{ disbursedAt: 'desc' }, { id: 'asc' }] }),
        this.db.advanceAccount.count({ where: base }),
      ]);
      return paginate(items, total, query);
    }
    if (kind === 'debts') {
      const [items, total] = await this.db.$transaction([
        this.db.debtAccount.findMany({ ...options, where: base, orderBy: [{ incurredAt: 'desc' }, { id: 'asc' }] }),
        this.db.debtAccount.count({ where: base }),
      ]);
      return paginate(items, total, query);
    }
    const where: Prisma.FinancialTransactionWhereInput = {
      ...base, type: kind === 'payments' ? 'SALARY_PAYMENT' : kind === 'settlements' ? 'SETTLEMENT' : undefined,
    };
    const [items, total] = await this.db.$transaction([
      this.db.financialTransaction.findMany({ ...options, where, orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        include: { ...options.include, allocations: true } }),
      this.db.financialTransaction.count({ where }),
    ]);
    return paginate(items, total, query);
  }
}
