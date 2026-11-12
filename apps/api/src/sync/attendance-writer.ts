import { Injectable } from '@nestjs/common';
import type { Prisma } from '@abu-qamar/database';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { Errors } from '../common/errors/app-exception';
import { todayInZone } from '../common/utils/dates';
import type { AttendanceOperationDto } from './attendance-sync.dto';

export const ATTENDANCE_WRITER = Symbol('ATTENDANCE_WRITER');
export type AttendanceWrite = Pick<AttendanceOperationDto, 'baseVersion' | 'employeeId' | 'departmentId' | 'sessionId' | 'checkInAt' | 'checkOutAt' | 'reason'> & {
  clientOperationId: string;
  actor: AuthContext;
  meta: RequestMeta;
  timezone: string;
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

function duration(start: Date, end: Date) {
  if (end <= start) throw Errors.validation('وقت الانصراف يجب أن يلي وقت الحضور');
  return Math.floor((end.getTime() - start.getTime()) / 60_000);
}

@Injectable()
export class DirectAttendanceWriter implements AttendanceWriter {
  checkIn(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    return this.create(tx, input, false);
  }

  manual(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    return this.create(tx, input, true);
  }

  private async create(tx: Prisma.TransactionClient, input: AttendanceWrite, closed: boolean) {
    if (!input.employeeId || !input.checkInAt || (closed && !input.checkOutAt) || input.baseVersion != null || input.sessionId) {
      throw Errors.validation('بيانات تسجيل الدوام غير مكتملة أو غير صالحة');
    }
    const employee = await tx.employee.findUnique({ where: { id: input.employeeId } });
    if (!employee || employee.status !== 'ACTIVE') throw Errors.validation('الموظف غير موجود أو متوقف');
    const departmentId = input.departmentId ?? employee.departmentId;
    if (!departmentId) throw Errors.validation('حدد القسم الذي عمل فيه الموظف');
    const checkInAt = new Date(input.checkInAt);
    const checkOutAt = closed ? new Date(input.checkOutAt!) : null;
    return tx.workSession.create({
      data: {
        employeeId: employee.id, departmentId, checkInAt, checkOutAt,
        originalCheckInAt: checkInAt, originalCheckOutAt: checkOutAt,
        status: closed ? 'CLOSED' : 'OPEN',
        workedMinutes: checkOutAt ? duration(checkInAt, checkOutAt) : null,
        workDate: todayInZone(input.timezone, checkInAt),
        clientOperationId: input.clientOperationId,
        createdById: input.actor.user.id,
        source: 'OFFLINE_SYNC',
      },
      select: { id: true, version: true },
    });
  }

  checkOut(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    return this.update(tx, input, false);
  }

  correction(tx: Prisma.TransactionClient, input: AttendanceWrite) {
    return this.update(tx, input, true);
  }

  private async update(tx: Prisma.TransactionClient, input: AttendanceWrite, correction: boolean) {
    if (!input.sessionId || !input.baseVersion || (!correction && !input.checkOutAt) ||
        (correction && (!input.reason?.trim() || (!input.checkInAt && !input.checkOutAt)))) {
      throw Errors.validation('بيانات تعديل سجل الدوام غير مكتملة');
    }
    const session = await tx.workSession.findUnique({ where: { id: input.sessionId }, include: { breaks: true } });
    if (!session) throw Errors.notFound('سجل الدوام غير موجود');
    if (session.version !== input.baseVersion) throw new AttendanceVersionConflict(session.version);
    if (session.status === 'VOIDED' || session.approvalStatus === 'APPROVED' || (!correction && session.status !== 'OPEN')) {
      throw Errors.conflict('حالة سجل الدوام الحالية لا تسمح بالتعديل');
    }
    const checkInAt = correction && input.checkInAt ? new Date(input.checkInAt) : session.checkInAt;
    const checkOutAt = input.checkOutAt ? new Date(input.checkOutAt) : session.checkOutAt;
    let workedMinutes = checkOutAt ? duration(checkInAt, checkOutAt) : null;
    for (const item of session.breaks) {
      if (item.startAt < checkInAt || (checkOutAt && (!item.endAt || item.endAt > checkOutAt))) {
        throw Errors.conflict('أوقات الدوام تتعارض مع الاستراحات المسجلة');
      }
      if (workedMinutes !== null && item.endAt && !item.isPaid) workedMinutes -= duration(item.startAt, item.endAt);
    }
    const after = await tx.workSession.update({
      where: { id: session.id, version: input.baseVersion },
      data: {
        checkInAt, checkOutAt, workedMinutes,
        workDate: todayInZone(input.timezone, checkInAt),
        status: checkOutAt ? 'CLOSED' : 'OPEN',
        originalCheckOutAt: correction ? session.originalCheckOutAt : checkOutAt,
        updatedById: input.actor.user.id, version: { increment: 1 },
      },
    });
    if (correction) {
      await tx.attendanceCorrection.create({
        data: {
          sessionId: session.id, correctedById: input.actor.user.id, reason: input.reason,
          before: { checkInAt: session.checkInAt.toISOString(), checkOutAt: session.checkOutAt?.toISOString() ?? null },
          after: { checkInAt: after.checkInAt.toISOString(), checkOutAt: after.checkOutAt?.toISOString() ?? null },
        },
      });
    }
    return { id: after.id, version: after.version };
  }
}
