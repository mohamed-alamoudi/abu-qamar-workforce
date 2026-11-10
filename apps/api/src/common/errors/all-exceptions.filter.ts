import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiErrorBody, ERROR_CODES } from '@abu-qamar/shared';
import { AppException } from './app-exception';

const STATUS_CODES: Record<number, string> = {
  400: ERROR_CODES.VALIDATION_FAILED,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  429: ERROR_CODES.RATE_LIMITED,
};

const STATUS_MESSAGES: Record<number, string> = {
  400: 'الطلب غير صالح',
  401: 'يجب تسجيل الدخول أولًا',
  403: 'ليست لديك صلاحية لتنفيذ هذه العملية',
  404: 'العنصر المطلوب غير موجود',
  409: 'تعارض مع بيانات موجودة',
  413: 'حجم الطلب كبير جدًا',
  429: 'طلبات كثيرة. انتظر قليلًا ثم حاول مجددًا',
};

/**
 * يوحّد شكل الأخطاء، ويمنع تسريب التفاصيل الداخلية:
 * الأخطاء غير المتوقعة تُسجَّل في الخادم (دون جسم الطلب أو الكوكيز) ويُعاد للعميل رد عام.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const body = this.toBody(exception, req);
    if (res.headersSent) return;
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, req: Request): ApiErrorBody {
    if (exception instanceof AppException) {
      return { statusCode: exception.getStatus(), code: exception.code, message: exception.message, details: exception.details };
    }
    if (exception instanceof ThrottlerException) {
      return { statusCode: 429, code: ERROR_CODES.RATE_LIMITED, message: STATUS_MESSAGES[429] };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      // أخطاء ValidationPipe: message مصفوفة رسائل
      const raw = typeof response === 'object' && response !== null ? (response as { message?: unknown }).message : undefined;
      if (status === 400 && Array.isArray(raw)) {
        return { statusCode: 400, code: ERROR_CODES.VALIDATION_FAILED, message: 'البيانات المدخلة غير صالحة', details: raw };
      }
      return {
        statusCode: status,
        code: STATUS_CODES[status] ?? (status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.VALIDATION_FAILED),
        message: STATUS_MESSAGES[status] ?? (status >= 500 ? 'حدث خطأ غير متوقع' : 'تعذر تنفيذ الطلب'),
      };
    }

    const prismaCode = (exception as { code?: unknown } | null)?.code;
    if (prismaCode === 'P2002') {
      return { statusCode: 409, code: ERROR_CODES.CONFLICT, message: 'القيمة مستخدمة مسبقًا' };
    }
    if (prismaCode === 'P2025') {
      return { statusCode: 404, code: ERROR_CODES.NOT_FOUND, message: 'السجل غير موجود' };
    }

    const err = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`${req.method} ${req.path} → ${err.name}: ${err.message}`, err.stack);
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, code: ERROR_CODES.INTERNAL_ERROR, message: 'حدث خطأ غير متوقع' };
  }
}
