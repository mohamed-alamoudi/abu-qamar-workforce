import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, ErrorCode } from '@abu-qamar/shared';

/** خطأ عمل موحّد: رمز ثابت تفهمه الواجهة + رسالة عربية للمستخدم. */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    public readonly details?: unknown,
  ) {
    super({ statusCode: status, code, message, details }, status);
  }
}

export const Errors = {
  unauthenticated: () =>
    new AppException(ERROR_CODES.UNAUTHENTICATED, 'يجب تسجيل الدخول أولًا', HttpStatus.UNAUTHORIZED),
  invalidCredentials: () =>
    new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'اسم المستخدم أو كلمة المرور غير صحيحة', HttpStatus.UNAUTHORIZED),
  accountDisabled: () =>
    new AppException(ERROR_CODES.ACCOUNT_DISABLED, 'هذا الحساب معطّل. راجع مدير النظام', HttpStatus.FORBIDDEN),
  tooManyAttempts: () =>
    new AppException(
      ERROR_CODES.TOO_MANY_ATTEMPTS,
      'محاولات دخول فاشلة كثيرة. حاول مجددًا بعد 15 دقيقة',
      HttpStatus.TOO_MANY_REQUESTS,
    ),
  totpRequired: () =>
    new AppException(ERROR_CODES.TOTP_REQUIRED, 'أدخل رمز المصادقة الثنائية', HttpStatus.UNAUTHORIZED),
  invalidTotp: () => new AppException(ERROR_CODES.INVALID_TOTP, 'رمز المصادقة الثنائية غير صحيح', HttpStatus.UNAUTHORIZED),
  forbidden: (message = 'ليست لديك صلاحية لتنفيذ هذه العملية') =>
    new AppException(ERROR_CODES.FORBIDDEN, message, HttpStatus.FORBIDDEN),
  adminOnly: () => new AppException(ERROR_CODES.ADMIN_ONLY, 'هذه العملية متاحة للأدمن فقط', HttpStatus.FORBIDDEN),
  reauthRequired: () =>
    new AppException(ERROR_CODES.REAUTH_REQUIRED, 'أعد إدخال كلمة المرور لتأكيد هذه العملية', HttpStatus.FORBIDDEN),
  invalidPassword: () => new AppException(ERROR_CODES.INVALID_PASSWORD, 'كلمة المرور غير صحيحة', HttpStatus.FORBIDDEN),
  csrf: () => new AppException(ERROR_CODES.CSRF_FAILED, 'تعذر التحقق من مصدر الطلب. حدّث الصفحة وحاول مجددًا', HttpStatus.FORBIDDEN),
  originNotAllowed: () =>
    new AppException(ERROR_CODES.ORIGIN_NOT_ALLOWED, 'مصدر الطلب غير مسموح', HttpStatus.FORBIDDEN),
  notFound: (message = 'السجل غير موجود') => new AppException(ERROR_CODES.NOT_FOUND, message, HttpStatus.NOT_FOUND),
  conflict: (message: string) => new AppException(ERROR_CODES.CONFLICT, message, HttpStatus.CONFLICT),
  validation: (message: string, details?: unknown) =>
    new AppException(ERROR_CODES.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details),
  maintenance: () =>
    new AppException(
      ERROR_CODES.MAINTENANCE,
      'النظام في وضع الصيانة (استرداد نسخة احتياطية). حاول مجددًا بعد قليل',
      HttpStatus.SERVICE_UNAVAILABLE,
    ),
  backupNotConfigured: (message = 'النسخ الاحتياطي غير مهيأ: عرّف BACKUP_ENCRYPTION_KEY في إعدادات الخادم') =>
    new AppException(ERROR_CODES.BACKUP_NOT_CONFIGURED, message, HttpStatus.SERVICE_UNAVAILABLE),
  backupIntegrity: (message: string) => new AppException(ERROR_CODES.BACKUP_INTEGRITY, message, HttpStatus.UNPROCESSABLE_ENTITY),
};
