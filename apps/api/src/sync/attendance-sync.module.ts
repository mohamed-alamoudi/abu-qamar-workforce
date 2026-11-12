import { Body, Controller, HttpCode, Inject, Injectable, Module, Post } from '@nestjs/common';
import { Prisma } from '@abu-qamar/database';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { AnyAuthenticated, Auth, Meta } from '../common/auth/decorators';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { APP_CONFIG, AppConfig } from '../common/config/env';
import { AppException, Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { MaintenanceService } from '../maintenance/maintenance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { AttendanceModule } from '../attendance/attendance.module';
import { AttendanceAction, AttendanceBatchDto, AttendanceOperationDto } from './attendance-sync.dto';
import { ATTENDANCE_WRITER, AttendanceVersionConflict, AttendanceWriter, SharedAttendanceWriter } from './attendance-writer';

const permissions: Record<AttendanceAction, string> = {
  CHECK_IN: 'attendance.check_in',
  CHECK_OUT: 'attendance.check_out',
  MANUAL: 'attendance.correct',
  CORRECTION: 'attendance.correct',
};
const methods = { CHECK_IN: 'checkIn', CHECK_OUT: 'checkOut', MANUAL: 'manual', CORRECTION: 'correction' } as const;

@Injectable()
class AttendanceSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly maintenance: MaintenanceService,
    private readonly notifications: NotificationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ATTENDANCE_WRITER) private readonly writer: AttendanceWriter,
  ) {}

  async batch(batch: AttendanceBatchDto, auth: AuthContext, meta: RequestMeta) {
    if (batch.userId !== auth.user.id) throw Errors.forbidden();
    const results = [];
    for (const operation of batch.operations) {
      const outcome = await this.process(operation, auth, meta);
      if (!outcome.duplicate && ['CONFLICT', 'REJECTED'].includes(outcome.record.status)) {
        await this.notifications.notifyAdmin({
          type: outcome.record.status === 'CONFLICT' ? 'ATTENDANCE_CONFLICT' : 'SYNC_FAILED',
          title: outcome.record.status === 'CONFLICT' ? 'تعارض في سجل الدوام' : 'فشلت مزامنة الدوام',
          body: outcome.record.resultMessage ?? 'تعذر تطبيق العملية',
          data: { operationId: operation.operationId },
        });
      }
      const { record, duplicate } = outcome;
      results.push({
        operationId: operation.operationId,
        status: duplicate ? 'DUPLICATE' : record.status,
        originalStatus: record.status,
        entityId: record.entityId,
        message: record.resultMessage,
        conflictData: record.conflictData,
      });
    }
    return { results };
  }

  private async process(op: AttendanceOperationDto, auth: AuthContext, meta: RequestMeta) {
    for (let attempt = 0; ; attempt++) {
      if (this.maintenance.active) throw Errors.maintenance();
      try {
        return await this.prisma.$transaction(async (tx) => {
          const session = await tx.session.findUnique({
            where: { id: auth.session.id },
            include: { user: { include: { permissions: { include: { permission: true } } } } },
          });
          const now = new Date();
          if (session && !session.user.isActive) throw Errors.accountDisabled();
          if (!session || session.userId !== auth.user.id || session.tokenHash !== auth.session.tokenHash ||
              session.revokedAt || session.expiresAt <= now ||
              (!session.rememberDevice && now.getTime() - session.lastSeenAt.getTime() > this.config.sessionIdleMs)) {
            throw Errors.unauthenticated();
          }
          const allowed = session.user.role === 'ADMIN' ||
            session.user.permissions.some(({ permission }) => permission.key === permissions[op.action]);
          const prior = await tx.syncOperation.findUnique({ where: { operationId: op.operationId } });
          if (prior) {
            if (!allowed || prior.userId !== session.userId || prior.deviceId !== op.deviceId) throw Errors.forbidden();
            const fields = ['action', 'employeeId', 'sessionId', 'departmentId', 'baseVersion', 'checkInAt', 'checkOutAt', 'reason', 'createdAt'];
            const stored = prior.payload as Record<string, unknown>;
            const incoming = op as unknown as Record<string, unknown>;
            if (fields.some((field) => stored[field] !== incoming[field])) throw Errors.conflict('معرّف العملية مستخدم لبيانات مختلفة');
            await this.audit.log({
              action: 'sync.duplicate', actor: auth, meta, entityType: 'sync_operation', entityId: prior.id,
              metadata: { operationId: op.operationId, outcome: 'DUPLICATE', originalStatus: prior.status },
            }, tx);
            return { record: prior, duplicate: true };
          }

          const payload = { ...op };
          const initial = await tx.syncOperation.create({ data: {
            operationId: op.operationId, deviceId: op.deviceId, userId: session.userId,
            entityType: 'work_session', entityId: op.sessionId, action: op.action, payload,
            baseVersion: op.baseVersion, clientCreatedAt: new Date(op.createdAt),
          } });
          let data: Prisma.SyncOperationUpdateInput;
          if (!allowed) {
            data = { status: 'REJECTED', resultMessage: 'صلاحيات الحساب الحالية لا تسمح بهذه العملية' };
          } else {
            await tx.$executeRawUnsafe('SAVEPOINT attendance_write');
            try {
              const result = await this.writer[methods[op.action]](tx, {
                ...op, clientOperationId: op.operationId,
                actor: { ...auth, user: { ...auth.user, role: session.user.role, permissions: session.user.permissions.map(({ permission }) => permission.key) } },
                meta,
              });
              data = { status: 'APPLIED', entityId: result.id, resultMessage: 'تمت مزامنة العملية' };
              await this.audit.log({
                action: 'attendance.synced', actor: auth, meta, entityType: 'work_session', entityId: result.id,
                metadata: { operationId: op.operationId, action: op.action, version: result.version },
              }, tx);
            } catch (error) {
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT attendance_write');
              data = this.rejected(error, op.baseVersion);
            }
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT attendance_write');
          }
          const record = await tx.syncOperation.update({ where: { id: initial.id }, data });
          return { record, duplicate: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      } catch (error) {
        if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError &&
            ['P2002', 'P2034'].includes(error.code)) continue;
        throw error;
      }
    }
  }

  private rejected(error: unknown, baseVersion?: number): Prisma.SyncOperationUpdateInput {
    if (error instanceof AttendanceVersionConflict) {
      return { status: 'CONFLICT', resultMessage: error.message, conflictData: { baseVersion, currentVersion: error.currentVersion } };
    }
    if (error instanceof AppException) {
      return { status: error.getStatus() === 409 ? 'CONFLICT' : 'REJECTED', resultMessage: error.message };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2004') return {
        status: 'CONFLICT', resultMessage: 'أوقات العملية تتعارض مع قيود سجلات الدوام', conflictData: { baseVersion },
      };
      if (error.code === 'P2003') return { status: 'REJECTED', resultMessage: 'الموظف أو القسم غير موجود' };
    }
    throw error;
  }
}

@ApiTags('sync')
@ApiCookieAuth()
@AnyAuthenticated()
@Controller('sync/attendance')
class AttendanceSyncController {
  constructor(private readonly sync: AttendanceSyncService) {}

  @Post()
  @HttpCode(200)
  submit(@Body() body: AttendanceBatchDto, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.sync.batch(body, auth, meta);
  }
}

@Module({
  imports: [NotificationsModule, AttendanceModule],
  controllers: [AttendanceSyncController],
  providers: [AttendanceSyncService, { provide: ATTENDANCE_WRITER, useClass: SharedAttendanceWriter }],
})
export class AttendanceSyncModule {}
