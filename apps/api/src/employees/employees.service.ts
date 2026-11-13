import { Injectable } from '@nestjs/common';
import { PayType, Prisma } from '@abu-qamar/database';
import { can } from '@abu-qamar/shared';
import { AuditService } from '../audit/audit.service';
import { lockEmployee } from '../attendance/attendance-common';
import { financiallyLinkedEntry } from '../payroll/payroll-entry-state';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { paginate, toSkipTake } from '../common/dto/pagination.dto';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { addDays, formatDateOnly, todayInZone } from '../common/utils/dates';
import { SettingsService } from '../settings/settings.module';
import type {
  ChangePayRateDto,
  CreateEmployeeDto,
  DeactivateEmployeeDto,
  EmployeesQueryDto,
  PayPolicyDto,
  TransferEmployeeDto,
  UpdateEmployeeDto,
} from './dto/employees.dto';

type Tx = Prisma.TransactionClient;

/** شرط «ساري في هذا التاريخ» لأي جدول بتاريخي سريان. */
const effectiveOn = (date: Date) => ({
  effectiveFrom: { lte: date },
  OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
});

const PAY_TYPE_LABEL: Record<PayType, string> = { HOURLY: 'بالساعة', DAILY: 'باليوم', MONTHLY: 'بالشهر' };

/** البيانات المالية (الأجر وسياساته) يراها الأدمن ومن مُنح «عرض المعلومات المالية» فقط. */
export function canSeePay(auth: AuthContext): boolean {
  return can(auth.user, 'finance.view');
}

/**
 * يتحقق من اتساق سياسة الاحتساب مع نوع الأجر، ويعيد الحقول المناسبة فقط
 * (حقول الأنواع الأخرى تُهمل حتى لا تبقى إعدادات بلا معنى).
 */
export function normalizePolicy(payType: PayType, policy: PayPolicyDto | undefined) {
  const base = { payrollFrequency: policy?.payrollFrequency ?? ('MONTHLY' as const) };
  const none = { dailyPayMode: null, referenceDailyHours: null, absenceDeductionMethod: null, fixedMonthDays: null };

  if (payType === 'DAILY') {
    if (!policy?.dailyPayMode) throw Errors.validation('حدّد طريقة الأجر اليومي: كامل أو نسبي');
    if (policy.dailyPayMode === 'PROPORTIONAL' && policy.referenceDailyHours === undefined) {
      throw Errors.validation('الأجر اليومي النسبي يتطلب تحديد ساعات اليوم المرجعية');
    }
    return { ...base, ...none, dailyPayMode: policy.dailyPayMode, referenceDailyHours: policy.referenceDailyHours ?? null };
  }
  if (payType === 'MONTHLY') {
    if (!policy?.absenceDeductionMethod) throw Errors.validation('حدّد طريقة خصم الغياب للراتب الشهري');
    if (policy.absenceDeductionMethod === 'FIXED_DAYS' && policy.fixedMonthDays === undefined) {
      throw Errors.validation('طريقة «عدد أيام ثابت» تتطلب تحديد عدد الأيام');
    }
    return {
      ...base,
      ...none,
      absenceDeductionMethod: policy.absenceDeductionMethod,
      fixedMonthDays: policy.absenceDeductionMethod === 'FIXED_DAYS' ? (policy.fixedMonthDays ?? null) : null,
    };
  }
  return { ...base, ...none };
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private async today(): Promise<Date> {
    return todayInZone((await this.settings.getAll())['general.timezone']);
  }

  // ───────────────────────────── القراءة ─────────────────────────────

  async list(query: EmployeesQueryDto, auth: AuthContext) {
    const showPay = canSeePay(auth);
    if (query.payType && !showPay) throw Errors.forbidden('التصفية حسب نوع الأجر تتطلب صلاحية عرض المعلومات المالية');
    const today = await this.today();

    const where: Prisma.EmployeeWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.payType ? { payRates: { some: { ...effectiveOn(today), payType: query.payType } } } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        include: {
          department: { select: { id: true, name: true } },
          ...(showPay ? { payRates: { where: effectiveOn(today), take: 1 } } : {}),
        },
        orderBy: [{ [query.sortBy]: query.sortDir }, { id: 'asc' }],
        ...toSkipTake(query),
      }),
      this.prisma.employee.count({ where }),
    ]);
    return paginate(
      items.map((e) => this.toPublic(e, showPay)),
      total,
      query,
    );
  }

  async get(id: string, auth: AuthContext) {
    const showPay = canSeePay(auth);
    const today = await this.today();
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        department: { select: { id: true, name: true } },
        ...(showPay ? { payRates: { where: effectiveOn(today), take: 1 } } : {}),
      },
    });
    if (!employee) throw Errors.notFound('الموظف غير موجود');
    return this.toPublic(employee, showPay);
  }

  private toPublic(
    employee: Prisma.EmployeeGetPayload<{ include: { department: { select: { id: true; name: true } } } }> & {
      payRates?: { payType: PayType; amount: Prisma.Decimal; effectiveFrom: Date }[];
    },
    showPay: boolean,
  ) {
    const rate = employee.payRates?.[0];
    return {
      id: employee.id,
      code: employee.code,
      fullName: employee.fullName,
      phone: employee.phone,
      status: employee.status,
      terminationDate: employee.terminationDate ? formatDateOnly(employee.terminationDate) : null,
      department: employee.department,
      version: employee.version,
      createdAt: employee.createdAt,
      updatedAt: employee.updatedAt,
      /** false = المستخدم لا يملك صلاحية رؤية الأجر (وليس «لا يوجد أجر») */
      payVisible: showPay,
      currentPay:
        showPay && rate
          ? { payType: rate.payType, amount: rate.amount.toFixed(2), effectiveFrom: formatDateOnly(rate.effectiveFrom) }
          : null,
    };
  }

  async search(q: string, auth: AuthContext) {
    if (!can(auth.user, 'employees.view')) return { employees: [] };
    const employees = await this.prisma.employee.findMany({
      where: {
        OR: [
          { fullName: { contains: q, mode: 'insensitive' } },
          { code: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
        ],
      },
      select: { id: true, code: true, fullName: true, status: true, department: { select: { name: true } } },
      orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
      take: 8,
    });
    return { employees };
  }

  // ───────────────────────────── الإنشاء والتعديل ─────────────────────────────

  async create(dto: CreateEmployeeDto, actor: AuthContext, meta: RequestMeta) {
    const isAdmin = actor.user.role === 'ADMIN';
    if (!isAdmin && (dto.pay || dto.policy)) throw Errors.adminOnly();
    if (isAdmin && !dto.pay) throw Errors.validation('حدّد نوع الأجر وقيمته');

    const department = await this.prisma.department.findUnique({ where: { id: dto.departmentId } });
    if (!department) throw Errors.validation('القسم غير موجود');
    if (!department.isActive) throw Errors.validation('القسم معطّل ولا يمكن إسناد موظفين إليه');

    const today = await this.today();
    const policy = dto.pay ? normalizePolicy(dto.pay.payType, dto.policy) : null;
    // تاريخ القسم يبدأ من أقدم التاريخين حتى يغطي أي دوام يُسجَّل بأثر رجعي
    const historyFrom = dto.pay && dto.pay.effectiveFrom < today ? dto.pay.effectiveFrom : today;

    const id = await this.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: { fullName: dto.fullName, phone: dto.phone ?? null, departmentId: dto.departmentId, createdById: actor.user.id },
      });
      await tx.employeeDepartmentHistory.create({
        data: { employeeId: employee.id, departmentId: dto.departmentId, effectiveFrom: historyFrom, createdById: actor.user.id },
      });
      await this.audit.log(
        {
          action: 'employee.created',
          actor,
          entityType: 'employee',
          entityId: employee.id,
          after: { code: employee.code, fullName: employee.fullName, phone: employee.phone, department: department.name },
          meta,
        },
        tx,
      );
      if (dto.pay && policy) {
        const payFrom = dto.pay.effectiveFrom;
        await tx.payRate.create({
          data: { employeeId: employee.id, payType: dto.pay.payType, amount: dto.pay.amount, effectiveFrom: payFrom, createdById: actor.user.id },
        });
        await tx.employeePayPolicy.create({
          data: { employeeId: employee.id, ...policy, effectiveFrom: payFrom, createdById: actor.user.id },
        });
        await this.audit.log(
          {
            action: 'employee.pay_rate_changed',
            actor,
            entityType: 'employee',
            entityId: employee.id,
            after: { payType: dto.pay.payType, amount: dto.pay.amount.toFixed(2), effectiveFrom: formatDateOnly(payFrom), ...policy },
            meta,
          },
          tx,
        );
      }
      return employee.id;
    });
    return this.get(id, actor);
  }

  async update(id: string, dto: UpdateEmployeeDto, actor: AuthContext, meta: RequestMeta) {
    const before = await this.findOrThrow(id);
    const data: Prisma.EmployeeUpdateManyMutationInput = {
      ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
    };
    await this.prisma.$transaction(async (tx) => {
      await this.bumpVersion(tx, id, dto.version, data);
      await this.audit.log(
        {
          action: 'employee.updated',
          actor,
          entityType: 'employee',
          entityId: id,
          before: { fullName: before.fullName, phone: before.phone },
          after: { fullName: dto.fullName ?? before.fullName, phone: dto.phone === undefined ? before.phone : dto.phone },
          meta,
        },
        tx,
      );
    });
    return this.get(id, actor);
  }

  /** إيقاف الموظف دون حذف أي من سجلاته. */
  async deactivate(id: string, dto: DeactivateEmployeeDto, actor: AuthContext, meta: RequestMeta) {
    const employee = await this.findOrThrow(id);
    if (employee.status === 'INACTIVE') throw Errors.conflict('الموظف متوقف مسبقًا');
    const today = await this.today();
    const terminationDate = dto.terminationDate ?? today;
    if (terminationDate > today) throw Errors.validation('تاريخ إنهاء العمل لا يكون في المستقبل');
    await this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, id);
      if ((await tx.workSession.count({ where: { employeeId: id, status: 'OPEN' } })) > 0) {
        throw Errors.conflict('للموظف حضور دون انصراف. سجّل الانصراف أولًا');
      }
      await this.bumpVersion(tx, id, employee.version, { status: 'INACTIVE', terminationDate });
      await this.audit.log(
        {
          action: 'employee.deactivated',
          actor,
          entityType: 'employee',
          entityId: id,
          before: { status: 'ACTIVE' },
          after: { status: 'INACTIVE', terminationDate: formatDateOnly(terminationDate) },
          meta,
        },
        tx,
      );
    });
    return this.get(id, actor);
  }

  async reactivate(id: string, actor: AuthContext, meta: RequestMeta) {
    const employee = await this.findOrThrow(id);
    if (employee.status === 'ACTIVE') throw Errors.conflict('الموظف نشط مسبقًا');
    const department = await this.prisma.department.findUniqueOrThrow({ where: { id: employee.departmentId } });
    if (!department.isActive) throw Errors.conflict('قسم الموظف معطّل. فعّل القسم أو انقل الموظف بعد التفعيل إلى قسم نشط');
    await this.prisma.$transaction(async (tx) => {
      await this.bumpVersion(tx, id, employee.version, { status: 'ACTIVE', terminationDate: null });
      await this.audit.log(
        {
          action: 'employee.reactivated',
          actor,
          entityType: 'employee',
          entityId: id,
          before: { status: 'INACTIVE', terminationDate: employee.terminationDate ? formatDateOnly(employee.terminationDate) : null },
          after: { status: 'ACTIVE' },
          meta,
        },
        tx,
      );
    });
    return this.get(id, actor);
  }

  // ───────────────────────────── الأقسام ─────────────────────────────

  async transfer(id: string, dto: TransferEmployeeDto, actor: AuthContext, meta: RequestMeta) {
    const employee = await this.findOrThrow(id);
    if (dto.departmentId === employee.departmentId) throw Errors.conflict('الموظف في هذا القسم حاليًا');
    const [from, to] = await Promise.all([
      this.prisma.department.findUniqueOrThrow({ where: { id: employee.departmentId } }),
      this.prisma.department.findUnique({ where: { id: dto.departmentId } }),
    ]);
    if (!to) throw Errors.validation('القسم غير موجود');
    if (!to.isActive) throw Errors.validation('القسم معطّل ولا يمكن النقل إليه');

    const today = await this.today();
    const effectiveFrom = dto.effectiveFrom ?? today;
    if (effectiveFrom > today) throw Errors.validation('تاريخ النقل لا يكون في المستقبل');

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.employeeDepartmentHistory.findFirst({
        where: { employeeId: id, effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (current && effectiveFrom < current.effectiveFrom) {
        throw Errors.conflict(`تاريخ النقل يجب ألا يسبق بداية القسم الحالي (${formatDateOnly(current.effectiveFrom)})`);
      }
      if (current && effectiveFrom.getTime() === current.effectiveFrom.getTime()) {
        // تصحيح لقيد اليوم نفسه بدل إنشاء فترة طولها صفر
        await tx.employeeDepartmentHistory.update({ where: { id: current.id }, data: { departmentId: dto.departmentId } });
      } else {
        if (current) {
          await tx.employeeDepartmentHistory.update({ where: { id: current.id }, data: { effectiveTo: addDays(effectiveFrom, -1) } });
        }
        await tx.employeeDepartmentHistory.create({
          data: { employeeId: id, departmentId: dto.departmentId, effectiveFrom, createdById: actor.user.id },
        });
      }
      await this.bumpVersion(tx, id, employee.version, { departmentId: dto.departmentId });
      await this.audit.log(
        {
          action: 'employee.transferred',
          actor,
          entityType: 'employee',
          entityId: id,
          before: { department: from.name },
          after: { department: to.name, effectiveFrom: formatDateOnly(effectiveFrom) },
          meta,
        },
        tx,
      );
    });
    return this.get(id, actor);
  }

  async departmentHistory(id: string) {
    await this.findOrThrow(id);
    const rows = await this.prisma.employeeDepartmentHistory.findMany({
      where: { employeeId: id },
      orderBy: { effectiveFrom: 'desc' },
      include: { department: { select: { id: true, name: true } }, createdBy: { select: { username: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      department: r.department,
      effectiveFrom: formatDateOnly(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? formatDateOnly(r.effectiveTo) : null,
      createdBy: r.createdBy.username,
      createdAt: r.createdAt,
    }));
  }

  // ───────────────────────────── الأجور وسياساتها (للأدمن) ─────────────────────────────

  async payHistory(id: string) {
    await this.findOrThrow(id);
    const [rates, policies] = await Promise.all([
      this.prisma.payRate.findMany({
        where: { employeeId: id },
        orderBy: { effectiveFrom: 'desc' },
        include: { createdBy: { select: { username: true } } },
      }),
      this.prisma.employeePayPolicy.findMany({
        where: { employeeId: id },
        orderBy: { effectiveFrom: 'desc' },
        include: { createdBy: { select: { username: true } } },
      }),
    ]);
    return {
      rates: rates.map((r) => ({
        id: r.id,
        payType: r.payType,
        amount: r.amount.toFixed(2),
        effectiveFrom: formatDateOnly(r.effectiveFrom),
        effectiveTo: r.effectiveTo ? formatDateOnly(r.effectiveTo) : null,
        createdBy: r.createdBy.username,
        createdAt: r.createdAt,
      })),
      policies: policies.map((p) => ({
        id: p.id,
        payrollFrequency: p.payrollFrequency,
        dailyPayMode: p.dailyPayMode,
        referenceDailyHours: p.referenceDailyHours ? Number(p.referenceDailyHours) : null,
        absenceDeductionMethod: p.absenceDeductionMethod,
        fixedMonthDays: p.fixedMonthDays,
        effectiveFrom: formatDateOnly(p.effectiveFrom),
        effectiveTo: p.effectiveTo ? formatDateOnly(p.effectiveTo) : null,
        createdBy: p.createdBy.username,
        createdAt: p.createdAt,
      })),
    };
  }

  /**
   * تغيير الأجر بتاريخ سريان: تُغلق الفترة المفتوحة في اليوم السابق وتبدأ فترة جديدة.
   * لا يُسمح بتاريخ يمس فترة رواتب مغلقة، فالحسابات التاريخية المغلقة لا تتغير.
   */
  async changePayRate(id: string, dto: ChangePayRateDto, actor: AuthContext, meta: RequestMeta) {
    const employee = await this.findOrThrow(id);
    const effectiveFrom = dto.effectiveFrom;
    await this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, id);
      if (dto.refreshUnpaidPeriods) await this.flagUnpaidPayrollForRefresh(tx, id, effectiveFrom, actor, meta);
      else await this.assertNotInClosedPayroll(id, effectiveFrom, tx);
      const latest = await tx.payRate.findFirst({ where: { employeeId: id }, orderBy: { effectiveFrom: 'desc' } });
      const typeChanged = !latest || latest.payType !== dto.payType;
      // تغيّر نوع الأجر يستلزم سياسة احتساب مناسبة للنوع الجديد في التاريخ نفسه
      const policy = typeChanged || dto.policy ? normalizePolicy(dto.payType, dto.policy) : null;

      await this.writeEffectiveRow(tx.payRate, id, effectiveFrom, latest, {
        payType: dto.payType,
        amount: dto.amount,
        createdById: actor.user.id,
      });
      if (policy) {
        const latestPolicy = await tx.employeePayPolicy.findFirst({ where: { employeeId: id }, orderBy: { effectiveFrom: 'desc' } });
        await this.writeEffectiveRow(tx.employeePayPolicy, id, effectiveFrom, latestPolicy, { ...policy, createdById: actor.user.id });
      }
      await this.bumpVersion(tx, id, employee.version, {});
      await this.audit.log(
        {
          action: 'employee.pay_rate_changed',
          actor,
          entityType: 'employee',
          entityId: id,
          before: latest
            ? { payType: latest.payType, amount: latest.amount.toFixed(2), effectiveFrom: formatDateOnly(latest.effectiveFrom) }
            : null,
          after: { payType: dto.payType, amount: dto.amount.toFixed(2), effectiveFrom: formatDateOnly(effectiveFrom), ...(policy ?? {}) },
          meta,
        },
        tx,
      );
    });
    return this.payHistory(id);
  }

  async changePayPolicy(id: string, dto: PayPolicyDto, actor: AuthContext, meta: RequestMeta) {
    const employee = await this.findOrThrow(id);
    const effectiveFrom = dto.effectiveFrom ?? (await this.today());
    await this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, id);
      await this.assertNotInClosedPayroll(id, effectiveFrom, tx);
      const rate = await tx.payRate.findFirst({ where: { employeeId: id, ...effectiveOn(effectiveFrom) } });
      if (!rate) throw Errors.conflict('لا يوجد أجر سارٍ في هذا التاريخ. حدّد الأجر أولًا');
      const policy = normalizePolicy(rate.payType, dto);
      const latest = await tx.employeePayPolicy.findFirst({ where: { employeeId: id }, orderBy: { effectiveFrom: 'desc' } });
      await this.writeEffectiveRow(tx.employeePayPolicy, id, effectiveFrom, latest, { ...policy, createdById: actor.user.id });
      await this.bumpVersion(tx, id, employee.version, {});
      await this.audit.log(
        {
          action: 'employee.pay_policy_changed',
          actor,
          entityType: 'employee',
          entityId: id,
          before: latest
            ? {
                payrollFrequency: latest.payrollFrequency,
                dailyPayMode: latest.dailyPayMode,
                referenceDailyHours: latest.referenceDailyHours ? Number(latest.referenceDailyHours) : null,
                absenceDeductionMethod: latest.absenceDeductionMethod,
                fixedMonthDays: latest.fixedMonthDays,
              }
            : null,
          after: { ...policy, effectiveFrom: formatDateOnly(effectiveFrom), payType: PAY_TYPE_LABEL[rate.payType] },
          meta,
        },
        tx,
      );
    });
    return this.payHistory(id);
  }

  /**
   * يكتب صفًّا جديدًا في جدول بتاريخي سريان دون تداخل:
   *  - تاريخ أقدم من آخر صف: مرفوض (التاريخ السابق لا يُعاد كتابته).
   *  - التاريخ نفسه: تصحيح للصف في مكانه (والقيمة القديمة محفوظة في سجل التدقيق).
   *  - تاريخ أحدث: إغلاق الصف المفتوح في اليوم السابق ثم إنشاء صف جديد.
   * قيد EXCLUDE في قاعدة البيانات يبقى الضمانة الأخيرة ضد أي تداخل.
   */
  private async writeEffectiveRow(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delegate: { update: (args: any) => Promise<unknown>; create: (args: any) => Promise<unknown> },
    employeeId: string,
    effectiveFrom: Date,
    latest: { id: string; effectiveFrom: Date; effectiveTo: Date | null } | null,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (latest && effectiveFrom < latest.effectiveFrom) {
      throw Errors.conflict(`تاريخ السريان يجب ألا يسبق آخر تغيير مسجّل (${formatDateOnly(latest.effectiveFrom)})`);
    }
    if (latest && effectiveFrom.getTime() === latest.effectiveFrom.getTime()) {
      await delegate.update({ where: { id: latest.id }, data: { ...data, effectiveTo: null } });
      return;
    }
    if (latest && (latest.effectiveTo === null || latest.effectiveTo >= effectiveFrom)) {
      await delegate.update({ where: { id: latest.id }, data: { effectiveTo: addDays(effectiveFrom, -1) } });
    }
    await delegate.create({ data: { ...data, employeeId, effectiveFrom } });
  }

  private async flagUnpaidPayrollForRefresh(tx: Prisma.TransactionClient, employeeId: string, effectiveFrom: Date,
    actor: AuthContext, meta: RequestMeta) {
    await tx.$queryRaw`SELECT e.id FROM payroll_entries e JOIN payroll_periods p ON p.id = e."periodId" WHERE e."employeeId" = ${employeeId}::uuid AND e."periodEnd" >= ${formatDateOnly(effectiveFrom)}::date AND p.status = 'CLOSED' ORDER BY e.id FOR UPDATE OF e`;
    const where = { employeeId, periodEnd: { gte: effectiveFrom }, period: { status: 'CLOSED' as const } };
    const linked = await tx.payrollEntry.findFirst({ where: { ...where, ...financiallyLinkedEntry } });
    if (linked) throw Errors.conflict('تاريخ السريان يمس مستحقًا مرتبطًا بدفعة أو تسوية أو فرق راتب. عالج الفرق في فترة مفتوحة');
    const affected = await tx.payrollEntry.findMany({ where, select: { id: true, snapshot: true, periodId: true } });
    for (const entry of affected) {
      const snapshot = entry.snapshot && typeof entry.snapshot === 'object' && !Array.isArray(entry.snapshot) ? entry.snapshot : {};
      await tx.$queryRaw`SELECT set_config('aq.flag_payroll_entry', ${entry.id}, true)`;
      await tx.payrollEntry.update({ where: { id: entry.id }, data: { snapshot: { ...snapshot, needsRefresh: true } } });
      await this.audit.log({ action: 'payroll.entry.refresh_required', actor, meta, entityType: 'payroll_entry',
        entityId: entry.id, metadata: { periodId: entry.periodId, employeeId } }, tx);
    }
  }

  private async assertNotInClosedPayroll(employeeId: string, effectiveFrom: Date, tx: Prisma.TransactionClient): Promise<void> {
    const closed = await tx.payrollEntry.findFirst({
      where: { employeeId, periodEnd: { gte: effectiveFrom }, period: { status: 'CLOSED' } },
      orderBy: { periodEnd: 'desc' },
      select: { periodEnd: true },
    });
    if (closed) {
      throw Errors.conflict(
        `تاريخ السريان يقع ضمن فترة رواتب مغلقة (حتى ${formatDateOnly(closed.periodEnd)}). اختر تاريخًا بعدها وعالج الفرق بتسوية`,
      );
    }
  }

  // ───────────────────────────── سجل التغييرات ─────────────────────────────

  async changeHistory(id: string, auth: AuthContext) {
    await this.findOrThrow(id);
    const logs = await this.prisma.auditLog.findMany({
      where: {
        entityType: 'employee',
        entityId: id,
        // تغييرات الأجر لا تظهر لمن لا يملك صلاحية عرض المعلومات المالية
        ...(canSeePay(auth) ? {} : { NOT: { action: { startsWith: 'employee.pay_' } } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: { id: true, action: true, actorUsername: true, before: true, after: true, createdAt: true },
    });
    return logs;
  }

  // ───────────────────────────── أدوات ─────────────────────────────

  private async findOrThrow(id: string) {
    const employee = await this.prisma.employee.findUnique({ where: { id } });
    if (!employee) throw Errors.notFound('الموظف غير موجود');
    return employee;
  }

  /** تحديث مشروط برقم الإصدار: إن عدّل السجلَّ جهازٌ آخر في الأثناء يُرفض التعديل بدل الكتابة فوقه. */
  private async bumpVersion(tx: Tx, id: string, version: number, data: Prisma.EmployeeUncheckedUpdateManyInput): Promise<void> {
    const result = await tx.employee.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
    if (result.count !== 1) throw Errors.conflict('عُدّل هذا السجل من مستخدم أو جهاز آخر. حدّث الصفحة ثم أعد المحاولة');
  }
}
