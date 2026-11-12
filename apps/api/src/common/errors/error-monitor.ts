import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/env';

@Injectable()
export class ErrorMonitor {
  private lastSent = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  capture(exception: unknown): void {
    if (!this.config.sentryDsn) return;
    const now = Date.now();
    if (now - this.lastSent < 1000) return;
    this.lastSent = now;
    void this.send(exception).catch(() => undefined);
  }

  private async send(exception: unknown): Promise<void> {
    const dsn = new URL(this.config.sentryDsn!);
    const project = dsn.pathname.split('/').filter(Boolean).pop();
    if (!project || !dsn.username || !['https:', 'http:'].includes(dsn.protocol)) return;
    const endpoint = new URL(dsn.origin);
    endpoint.pathname = dsn.pathname.replace(/\/?[^/]+\/?$/, '/api/' + project + '/envelope/');
    const eventId = randomUUID().replaceAll('-', '');
    // قائمة سماح ثابتة: لا كائن طلب، ولا كوكيز أو ترويسات أو رسائل خطأ أو stack.
    const code = (exception as { code?: unknown } | null)?.code;
    const payload = {
      event_id: eventId,
      platform: 'node',
      level: 'error',
      environment: this.config.nodeEnv,
      timestamp: new Date().toISOString(),
      message: 'خطأ داخلي في API',
      tags: typeof code === 'string' && /^P\d{4}$/.test(code) ? { prisma_code: code } : {},
    };
    await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': 'Sentry sentry_version=7, sentry_key=' + dsn.username,
      },
      body: [JSON.stringify({ event_id: eventId }), JSON.stringify({ type: 'event' }), JSON.stringify(payload), ''].join('\n'),
    });
  }
}
