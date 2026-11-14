import { CallHandler, CanActivate, ExecutionContext, Global, Injectable, Module, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { finalize } from 'rxjs';
import { Errors } from '../common/errors/app-exception';

/**
 * وضع الصيانة: أثناء الاسترداد يرفض الخادم كل الكتابة والمزامنة.
 *
 * الحالة في ذاكرة العملية عمدًا — لا يمكن حفظها في القاعدة لأن القاعدة نفسها تُستبدل أثناء الاسترداد.
 * هذا صحيح ما دام الخادم نسخة واحدة (كما في render.yaml). عند تشغيل أكثر من نسخة يجب نقل العلم إلى مخزن مشترك.
 */
@Injectable()
export class MaintenanceService {
  private reason: string | null = null;
  private since: Date | null = null;
  private runningRequests = 0;
  private readonly waiters = new Set<() => void>();

  trackRequest(): () => void {
    if (this.active) throw Errors.maintenance();
    this.runningRequests++;
    return () => {
      if (--this.runningRequests === 0) for (const finish of this.waiters) finish();
    };
  }

  async drainRequests(): Promise<void> {
    if (this.runningRequests === 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        this.waiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.waiters.delete(finish);
        reject(Errors.conflict('لم تنتهِ الطلبات الجارية في الوقت المحدد. حاول مجددًا'));
      }, 30_000);
      this.waiters.add(finish);
    });
  }

  get active(): boolean {
    return this.reason !== null;
  }

  status(): { active: boolean; reason: string | null; since: string | null } {
    return { active: this.active, reason: this.reason, since: this.since?.toISOString() ?? null };
  }

  /** يعيد false إن كان وضع الصيانة مفعّلًا مسبقًا (عملية أخرى جارية). */
  enter(reason: string): boolean {
    if (this.reason !== null) return false;
    this.reason = reason;
    this.since = new Date();
    return true;
  }

  exit(): void {
    this.reason = null;
    this.since = null;
  }
}



/** يُسجَّل قبل الحارس الأمني: أثناء الصيانة تُرفض كل الطلبات المغيِّرة للحالة وكل مسارات المزامنة. */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly maintenance: MaintenanceService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.maintenance.active) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (req.path !== '/health') throw Errors.maintenance();
    return true;
  }
}

/** يُعيد الفحص بعد المصادقة وينتظر الاسترداد اكتمال المعالجات التي بدأت قبله. */
@Injectable()
export class MaintenanceRequestInterceptor implements NestInterceptor {
  constructor(private readonly maintenance: MaintenanceService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.path === '/health') return next.handle();
    if (req.method === 'POST' && /^\/backups\/(?:[^/]+\/restore|reset-workers)\/?$/.test(req.path)) return next.handle();
    const release = this.maintenance.trackRequest();
    return next.handle().pipe(finalize(release));
  }
}

@Global()
@Module({
  providers: [MaintenanceService, MaintenanceGuard, MaintenanceRequestInterceptor],
  exports: [MaintenanceService, MaintenanceGuard, MaintenanceRequestInterceptor],
})
export class MaintenanceModule {}
