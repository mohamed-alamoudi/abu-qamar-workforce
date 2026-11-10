import { Injectable } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { paginate, toSkipTake } from '../common/dto/pagination.dto';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateUserDto, ResetPasswordDto, SetPermissionsDto, UpdateUserDto, UsersQueryDto } from './dto/users.dto';

const userInclude = { permissions: { include: { permission: { select: { key: true } } } } } satisfies Prisma.UserInclude;
type UserWithPermissions = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/** الشكل العام للمستخدم — لا يتضمن أبدًا بصمة كلمة المرور أو أسرار المصادقة الثنائية. */
function toPublic(user: UserWithPermissions) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
    disabledAt: user.disabledAt,
    totpEnabled: user.totpEnabledAt !== null,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    permissions: user.role === 'ADMIN' ? [] : user.permissions.map((p) => p.permission.key).sort(),
  };
}

/**
 * إدارة حسابات المراقبين (للأدمن فقط).
 * حساب الأدمن الرئيسي وحيد: لا يُنشأ من هنا، ولا يُعطَّل، ولا تُعدَّل صلاحياته.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async list(query: UsersQueryDto) {
    const where: Prisma.UserWhereInput = {
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { username: { contains: query.search.toLowerCase() } },
              { fullName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        ...toSkipTake(query),
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(items.map(toPublic), total, query);
  }

  async get(id: string) {
    return toPublic(await this.findOrThrow(id));
  }

  async create(dto: CreateUserDto, actor: AuthContext, meta: RequestMeta) {
    if (await this.prisma.user.findUnique({ where: { username: dto.username }, select: { id: true } })) {
      throw Errors.conflict('اسم المستخدم مستخدم مسبقًا');
    }
    const passwordHash = await this.passwords.hash(dto.password);
    const permissionIds = await this.resolvePermissionIds(dto.permissions ?? []);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username: dto.username,
          fullName: dto.fullName,
          passwordHash,
          role: 'SUPERVISOR',
          createdById: actor.user.id,
          permissions: { create: permissionIds.map((permissionId) => ({ permissionId, grantedById: actor.user.id })) },
        },
        include: userInclude,
      });
      await this.audit.log(
        { action: 'user.created', actor, entityType: 'user', entityId: created.id, after: toPublic(created), meta },
        tx,
      );
      return created;
    });
    return toPublic(user);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthContext, meta: RequestMeta) {
    const before = await this.findOrThrow(id);
    if (dto.isActive !== undefined && before.role === 'ADMIN') {
      throw Errors.forbidden('لا يمكن تعطيل حساب الأدمن الرئيسي');
    }
    const statusChanged = dto.isActive !== undefined && dto.isActive !== before.isActive;

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
          ...(statusChanged ? { isActive: dto.isActive, disabledAt: dto.isActive ? null : new Date() } : {}),
        },
        include: userInclude,
      });
      // تعطيل الحساب يلغي جلساته ضمن المعاملة نفسها
      if (statusChanged && !dto.isActive) {
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'ACCOUNT_DISABLED' },
        });
      }
      await this.audit.log(
        {
          action: statusChanged ? (dto.isActive ? 'user.enabled' : 'user.disabled') : 'user.updated',
          actor,
          entityType: 'user',
          entityId: id,
          before: { fullName: before.fullName, isActive: before.isActive },
          after: { fullName: updated.fullName, isActive: updated.isActive },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toPublic(after);
  }

  async setPermissions(id: string, dto: SetPermissionsDto, actor: AuthContext, meta: RequestMeta) {
    const before = await this.findOrThrow(id);
    if (before.role !== 'SUPERVISOR') {
      throw Errors.forbidden('صلاحيات الأدمن الرئيسي كاملة ولا تُعدَّل');
    }
    const permissionIds = await this.resolvePermissionIds(dto.permissions);

    const after = await this.prisma.$transaction(async (tx) => {
      await tx.userPermission.deleteMany({ where: { userId: id } });
      await tx.userPermission.createMany({
        data: permissionIds.map((permissionId) => ({ userId: id, permissionId, grantedById: actor.user.id })),
      });
      const updated = await tx.user.findUniqueOrThrow({ where: { id }, include: userInclude });
      await this.audit.log(
        {
          action: 'user.permissions_changed',
          actor,
          entityType: 'user',
          entityId: id,
          before: { permissions: toPublic(before).permissions },
          after: { permissions: toPublic(updated).permissions },
          meta,
        },
        tx,
      );
      return updated;
    });
    return toPublic(after);
  }

  async resetPassword(id: string, dto: ResetPasswordDto, actor: AuthContext, meta: RequestMeta) {
    const user = await this.findOrThrow(id);
    if (user.role !== 'SUPERVISOR') {
      throw Errors.forbidden('الأدمن يغيّر كلمة مروره من صفحة حسابه');
    }
    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash, passwordChangedAt: new Date() } });
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' },
      });
      await this.audit.log({ action: 'user.password_reset', actor, entityType: 'user', entityId: id, meta }, tx);
    });
    return { ok: true };
  }

  async revokeSessions(id: string, actor: AuthContext, meta: RequestMeta) {
    await this.findOrThrow(id);
    // إن ألغى الأدمن جلساته هو، نُبقي الجلسة الحالية
    const except = id === actor.user.id ? actor.session.id : undefined;
    const revoked = await this.sessions.revokeAllForUser(id, 'REVOKED_BY_ADMIN', except);
    await this.audit.log({
      action: 'user.sessions_revoked',
      actor,
      entityType: 'user',
      entityId: id,
      metadata: { revoked },
      meta,
    });
    return { revoked };
  }

  private async findOrThrow(id: string): Promise<UserWithPermissions> {
    const user = await this.prisma.user.findUnique({ where: { id }, include: userInclude });
    if (!user) throw Errors.notFound('المستخدم غير موجود');
    return user;
  }

  /** يحوّل المفاتيح إلى معرفات، ويرفض أي مفتاح غير موجود في جدول الصلاحيات. */
  private async resolvePermissionIds(keys: string[]): Promise<string[]> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const found = await this.prisma.permission.findMany({ where: { key: { in: unique } }, select: { id: true, key: true } });
    if (found.length !== unique.length) {
      const known = new Set(found.map((p) => p.key));
      throw Errors.validation('صلاحيات غير معروفة', unique.filter((k) => !known.has(k)));
    }
    return found.map((p) => p.id);
  }
}
