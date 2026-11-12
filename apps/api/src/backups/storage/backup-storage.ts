/**
 * تخزين النسخ الاحتياطية خلف واجهة واحدة:
 * - `LocalBackupStorage` للتطوير والاختبار (مجلد على القرص).
 * - `S3BackupStorage` للإنتاج (أي خدمة متوافقة مع S3)، منفصلة عن قاعدة البيانات.
 *
 * الملفات تُنقل كاملة في الذاكرة (Buffer). قاعدة متجر واحد صغيرة (عشرات الميغابايت على الأكثر)،
 * والحد الأقصى مفروض في الخدمة (MAX_BACKUP_BYTES).
 */
export interface BackupStorage {
  readonly driver: 'local' | 's3';
  put(key: string, data: Buffer): Promise<void>;
  /** يرمي BackupObjectNotFoundError إن لم يوجد الملف */
  get(key: string): Promise<Buffer>;
  /** لا يرمي إن كان الملف غير موجود */
  delete(key: string): Promise<void>;
  /** المفاتيح التي تبدأ بهذه البادئة */
  list(prefix: string): Promise<string[]>;
}

export const BACKUP_STORAGE = Symbol('BACKUP_STORAGE');

export class BackupObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`ملف النسخة غير موجود في التخزين: ${key}`);
    this.name = 'BackupObjectNotFoundError';
  }
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** المفاتيح يولّدها النظام فقط؛ هذا الفحص يمنع أي مسار خارج المجلد لو وصل مفتاح غير متوقع. */
export function assertSafeKey(key: string): void {
  if (key.length > 255 || !SAFE_KEY.test(key) || key.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('مفتاح تخزين غير صالح');
  }
}
