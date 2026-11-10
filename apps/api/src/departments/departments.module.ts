import { Body, Controller, Delete, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { AdminOnly, AnyAuthenticated, Auth, Meta } from '../common/auth/decorators';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);

export class CreateDepartmentDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;
}

export class UpdateDepartmentDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  /** تعطيل القسم يمنع إسناد موظفين جدد إليه دون المساس بسجلاته */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const [departments, counts] = await Promise.all([
      this.prisma.department.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
      this.prisma.employee.groupBy({ by: ['departmentId'], where: { status: 'ACTIVE' }, _count: { _all: true } }),
    ]);
    const byId = new Map(counts.map((c) => [c.departmentId, c._count._all]));
    return departments.map((d) => ({ ...d, activeEmployees: byId.get(d.id) ?? 0 }));
  }

  async create(dto: CreateDepartmentDto, actor: AuthContext, meta: RequestMeta) {
    await this.assertNameFree(dto.name);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.department.create({ data: { name: dto.name } });
      await this.audit.log(
        { action: 'department.created', actor, entityType: 'department', entityId: created.id, after: { name: created.name }, meta },
        tx,
      );
      return created;
    });
  }

  async update(id: string, dto: UpdateDepartmentDto, actor: AuthContext, meta: RequestMeta) {
    const before = await this.prisma.department.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('القسم غير موجود');
    if (dto.name !== undefined && dto.name !== before.name) await this.assertNameFree(dto.name, id);
    if (dto.isActive === false && before.isActive) {
      const active = await this.prisma.employee.count({ where: { departmentId: id, status: 'ACTIVE' } });
      if (active > 0) throw Errors.conflict(`لا يمكن تعطيل قسم فيه ${active} موظف نشط. انقلهم إلى قسم آخر أولًا`);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.department.update({ where: { id }, data: { name: dto.name, isActive: dto.isActive } });
      await this.audit.log(
        {
          action: 'department.updated',
          actor,
          entityType: 'department',
          entityId: id,
          before: { name: before.name, isActive: before.isActive },
          after: { name: updated.name, isActive: updated.isActive },
          meta,
        },
        tx,
      );
      return updated;
    });
  }

  /** الحذف مسموح فقط لقسم لم يرتبط بأي سجل قط؛ غير ذلك يُعطَّل. */
  async remove(id: string, actor: AuthContext, meta: RequestMeta) {
    const department = await this.prisma.department.findUnique({ where: { id } });
    if (!department) throw Errors.notFound('القسم غير موجود');
    const [employees, history, sessions, shifts] = await Promise.all([
      this.prisma.employee.count({ where: { departmentId: id } }),
      this.prisma.employeeDepartmentHistory.count({ where: { departmentId: id } }),
      this.prisma.workSession.count({ where: { departmentId: id } }),
      this.prisma.scheduleShift.count({ where: { departmentId: id } }),
    ]);
    if (employees + history + sessions + shifts > 0) {
      throw Errors.conflict('القسم مرتبط بسجلات ولا يمكن حذفه. عطّله بدل ذلك');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.department.delete({ where: { id } });
      await this.audit.log(
        { action: 'department.deleted', actor, entityType: 'department', entityId: id, before: { name: department.name }, meta },
        tx,
      );
    });
    return { ok: true };
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const existing = await this.prisma.department.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (existing) throw Errors.conflict('يوجد قسم بهذا الاسم');
  }
}

@ApiTags('departments')
@ApiCookieAuth()
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'قائمة الأقسام مع عدد الموظفين النشطين' })
  list() {
    return this.departments.list();
  }

  @Post()
  @AdminOnly()
  @ApiOperation({ summary: 'إضافة قسم' })
  create(@Body() dto: CreateDepartmentDto, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.departments.create(dto, auth, meta);
  }

  @Patch(':id')
  @AdminOnly()
  @ApiOperation({ summary: 'تعديل اسم قسم أو تعطيله/تفعيله' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
    @Auth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ) {
    return this.departments.update(id, dto, auth, meta);
  }

  @Delete(':id')
  @AdminOnly()
  @ApiOperation({ summary: 'حذف قسم غير مرتبط بأي سجل (غير ذلك يُعطَّل)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.departments.remove(id, auth, meta);
  }
}

@Module({
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
})
export class DepartmentsModule {}
