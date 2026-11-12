import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma } from '@abu-qamar/database';
import { PrismaService } from '../common/prisma/prisma.service';

export interface NewNotification {
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async notifyUser(userId: string, n: NewNotification): Promise<void> {
    await this.prisma.notification.create({ data: { userId, ...n } });
  }

  /** إشعار للأدمن الرئيسي. لا يُفشل العملية الأصلية إن تعذر حفظ الإشعار. */
  async notifyAdmin(n: NewNotification, tx?: Prisma.TransactionClient): Promise<void> {
    if (tx) {
      const admin = await tx.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
      if (admin) await tx.notification.create({ data: { userId: admin.id, ...n } });
      return;
    }
    try {
      const admin = await this.prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
      if (admin) await this.notifyUser(admin.id, n);
    } catch (error) {
      this.logger.error(`تعذر إنشاء إشعار ${n.type}: ${(error as Error).message}`);
    }
  }
}
