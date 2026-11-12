import { Injectable } from '@nestjs/common';
import type { Prisma } from '@abu-qamar/database';
import { lockEmployee } from '../attendance/attendance-common';
import { AttendanceService } from '../attendance/attendance.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { Errors } from '../common/errors/app-exception';
import type { AttendanceOperationDto } from './attendance-sync.dto';

export const ATTENDANCE_WRITER = Symbol('ATTENDANCE_WRITER');
export type AttendanceWrite = Pick<AttendanceOperationDto, 'baseVersion' | 'deviceId' | 'employeeId' | 'departmentId' | 'sessionId' | 'checkInAt' | 'checkOutAt' | 'reason'> & {
  clientOperationId: string;
  actor: AuthContext;
  meta: RequestMeta;
};
export type AttendanceWriteResult = { id: string; version: number };

export interface AttendanceWriter {
  checkIn(tx: Prisma.TransactionClient, input: AttendanceWrite): Promise<AttendanceWriteResult>;
  checkOut(tx: Prisma.TransactionClient, input: AttendanceWrite): Promise<AttendanceWriteResult>;
  manual(tx: Prisma.TransactionClient, input: AttendanceWrite): Promise<AttendanceWriteResult>;
  correction(tx: Prisma.TransactionClient, input: AttendanceWrite): Promise<AttendanceWriteResult>;
}

export class AttendanceVersionConflict extends Error {
  constructor(readonly currentVersion: number) {
    super('تغيّر سجل الدوام على جهاز آخر. راجع النسخة الحالية');
  }
}

@Injectable()
export class SharedAttendanceWriter implements AttendanceWriter {
  constructor(private readonly attendance: AttendanceService) {}

  checkIn(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    const { employeeId, checkInAt, departmentId, clientOperationId, actor, meta } = input;
    if (!employeeId || !checkInAt || input.sessionId || input.baseVersion || input.checkOutAt) {
      throw Errors.validation('بيانات تسجيل الحضور غير مكتملة أو غير صالحة');
    }
    return this.attendance.checkIn({ employeeId, at: checkInAt, departmentId, clientOperationId }, actor, meta, tx);
  }

  manual(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    const { employeeId, checkInAt, checkOutAt, departmentId, clientOperationId, actor, meta } = input;
    if (!employeeId || !checkInAt || input.sessionId || input.baseVersion) {
      throw Errors.validation('بيانات الإدخال اليدوي غير مكتملة أو غير صالحة');
    }
    return this.attendance.manual({ employeeId, checkInAt, checkOutAt, departmentId, clientOperationId }, actor, meta, tx);
  }

  async checkOut(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    if (!input.checkOutAt) throw Errors.validation('حدّد وقت الانصراف');
    const row = await this.session(tx, input);
    return this.attendance.checkOut({
      employeeId: row.employeeId, sessionId: row.id, at: input.checkOutAt,
      baseVersion: input.baseVersion, clientOperationId: input.clientOperationId,
    }, input.actor, input.meta, tx);
  }

  async correction(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    if (!input.reason?.trim()) throw Errors.validation('أدخل سبب التصحيح');
    const row = await this.session(tx, input);
    return this.attendance.correct(row.id, {
      checkInAt: input.checkInAt, checkOutAt: input.checkOutAt, departmentId: input.departmentId,
      reason: input.reason, baseVersion: input.baseVersion, clientOperationId: input.clientOperationId,
    }, input.actor, input.meta, tx);
  }

  private async session(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    if (!input.sessionId || !input.baseVersion) throw Errors.validation('حدّد الوردية وإصدارها');
    const where = { id: input.sessionId };
    const select = { id: true, employeeId: true, version: true } as const;
    let row = await tx.workSession.findUnique({ where, select });
    if (!row) {
      // A checkout queued on the same device can refer to a check-in by operation ID.
      const receipt = await tx.syncOperation.findUnique({ where: { operationId: input.sessionId } });
      const deviceId = (receipt?.payload as { deviceId?: string } | undefined)?.deviceId;
      if (receipt?.entityId && receipt.userId === input.actor.user.id && deviceId === input.deviceId &&
          receipt.status === 'APPLIED' && ['CHECK_IN', 'MANUAL'].includes(receipt.action)) {
        row = await tx.workSession.findUnique({ where: { id: receipt.entityId }, select });
      }
    }
    if (!row) throw Errors.notFound('سجل الدوام غير موجود');
    await lockEmployee(tx, row.employeeId);
    row = await tx.workSession.findUniqueOrThrow({ where: { id: row.id }, select });
    if (row.version !== input.baseVersion) throw new AttendanceVersionConflict(row.version);
    return row;
  }
}
