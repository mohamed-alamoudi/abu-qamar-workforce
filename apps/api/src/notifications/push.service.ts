import { Injectable, Logger } from '@nestjs/common';
import { sendNotification, WebPushError } from 'web-push';
import { PrismaService } from '../common/prisma/prisma.service';

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
      (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
       host === 'web.push.apple.com' || host.endsWith('.push.apple.com') ||
       host === 'wns.windows.com' || host.endsWith('.notify.windows.com'));
  } catch {
    return false;
  }
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  constructor(private readonly prisma: PrismaService) {}

  get publicKey(): string | null {
    return process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PUBLIC_KEY || null : null;
  }

  async send(userId: string, notificationId: string): Promise<void> {
    const publicKey = this.publicKey;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) return;
    try {
      const subscriptions = await this.prisma.pushSubscription.findMany({
        where: { session: { userId, revokedAt: null, expiresAt: { gt: new Date() }, user: { isActive: true } } },
      });
      await Promise.all(subscriptions.map(async ({ endpoint, p256dh, auth, sessionId }) => {
        if (!isPushEndpoint(endpoint)) return;
        try {
          await sendNotification({ endpoint, keys: { p256dh, auth } }, JSON.stringify({ id: notificationId }), {
            vapidDetails: { publicKey, privateKey, subject: process.env.VAPID_SUBJECT || process.env.APP_URL || '' },
            TTL: 300,
            timeout: 5000,
          });
        } catch (error) {
          if (error instanceof WebPushError && [404, 410].includes(error.statusCode)) {
            await this.prisma.pushSubscription.deleteMany({ where: { endpoint, sessionId, p256dh, auth } });
          } else {
            this.logger.warn('تعذر توصيل إشعار إلى خدمة الدفع');
          }
        }
      }));
    } catch {
      this.logger.warn('تعذر إرسال إشعارات الهاتف');
    }
  }
}
