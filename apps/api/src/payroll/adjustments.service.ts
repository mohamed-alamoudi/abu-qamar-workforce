import { Injectable } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { paginate, toSkipTake } from '../common/dto/pagination.dto';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AdjustmentsQueryDto, CreateAdjustmentDto } from './dto/payroll.dto';
import { lockPayroll } from './payroll.service';

@Injectable()
export class AdjustmentsService {
  constructor(private readonly db: PrismaService, private readonly audit: AuditService) {}

  async list(query: AdjustmentsQueryDto) {
    const where = { employeeId: query.employeeId, status: query.status };
    const [items, total] = await this.db.$transaction([
      this.db.payrollAdjustment.findMany({ where, ...toSkipTake(query), include: { employee: { select: { id: true, code: true, fullName: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      this.db.payrollAdjustment.count({ where }),
    ]);
    return paginate(items, total, query);
  }

  async create(dto: CreateAdjustmentDto, actor: AuthContext, meta: RequestMeta) {
    return this.db.$transaction(async (tx) => {
      await lockPayroll(tx);
      if (!await tx.employee.findUnique({ where: { id: dto.employeeId }, select: { id: true } })) {
        throw Errors.notFound('الموظف غير موجود');
      }
      const amount = new Prisma.Decimal(dto.amount);
      if (dto.type === 'WAGE_DIFFERENCE') {
        if (!dto.targetEntryId) throw Errors.validation('اختر المستحق المغلق الذي يصححه فرق الراتب');
        const original = await tx.payrollEntry.findUnique({ where: { id: dto.targetEntryId }, include: { period: true } });
        if (!original || original.period.status !== 'CLOSED' || original.employeeId !== dto.employeeId) {
          throw Errors.validation('اختر مستحقًا مغلقًا لنفس الموظف');
        }
      } else if (dto.targetEntryId || !amount.gt(0)) {
        throw Errors.validation('أدخل مبلغًا موجبًا للمكافأة أو الخصم دون ربطه بمستحق مغلق');
      }
      const row = await tx.payrollAdjustment.create({ data: { ...dto, amount, createdById: actor.user.id } });
      await this.audit.log({ action: 'payroll.adjustment.create', actor, meta, entityType: 'payroll_adjustment',
        entityId: row.id, after: { ...row, amount: amount.toFixed(2) } }, tx);
      return row;
    });
  }

  async decide(id: string, decision: 'APPROVED' | 'CANCELLED', actor: AuthContext, meta: RequestMeta) {
    return this.db.$transaction(async (tx) => {
      await lockPayroll(tx);
      const old = await tx.payrollAdjustment.findUnique({ where: { id }, include: { appliedEntry: { include: { period: true } } } });
      if (!old) throw Errors.notFound('تعديل الراتب غير موجود');
      const appliedInOpenPeriod = old.status === 'APPLIED' && old.appliedEntry && old.appliedEntry.period.status !== 'CLOSED';
      if (old.status !== 'PENDING' && !(decision === 'CANCELLED' && (old.status === 'APPROVED' || appliedInOpenPeriod))) {
        throw Errors.conflict('حالة تعديل الراتب لا تسمح بهذا الإجراء');
      }
      if (appliedInOpenPeriod && decision === 'CANCELLED' && old.appliedEntry!.period.status === 'READY_FOR_APPROVAL') {
        await tx.payrollPeriod.update({ where: { id: old.appliedEntry!.periodId },
          data: { status: 'IN_REVIEW', approvedAt: null, approvedById: null } });
      }
      const row = await tx.payrollAdjustment.update({ where: { id }, data: {
        status: decision, ...(decision === 'APPROVED' ? { approvedById: actor.user.id, approvedAt: new Date() } : { appliedEntryId: null }),
      } });
      await this.audit.log({ action: 'payroll.adjustment.decide', actor, meta, entityType: 'payroll_adjustment',
        entityId: id, before: { status: old.status }, after: { status: row.status } }, tx);
      return row;
    });
  }
}
