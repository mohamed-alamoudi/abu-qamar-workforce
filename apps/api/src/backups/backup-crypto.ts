import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * صيغة ملف النسخة الاحتياطية المشفّر:
 *   AQBK1 (5 بايت) ‖ IV (12) ‖ النص المشفّر ‖ وسم المصادقة GCM (16)
 * الترويسة تدخل في المصادقة (AAD)، فأي تغيير في أي بايت يُفشل فك التشفير.
 */
const MAGIC = Buffer.from('AQBK1', 'ascii');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class BackupIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

function deriveKey(secret: string, purpose: 'encrypt' | 'manifest'): Buffer {
  return createHmac('sha256', secret).update(`abu-qamar:backup:${purpose}`).digest();
}

export function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function encryptBackup(plain: Buffer, secret: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, 'encrypt'), iv);
  cipher.setAAD(MAGIC);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, data, cipher.getAuthTag()]);
}

export function decryptBackup(file: Buffer, secret: string): Buffer {
  if (file.length < MAGIC.length + IV_LENGTH + TAG_LENGTH || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupIntegrityError('الملف ليس نسخة احتياطية أنشأها هذا النظام');
  }
  const iv = file.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const tag = file.subarray(file.length - TAG_LENGTH);
  const data = file.subarray(MAGIC.length + IV_LENGTH, file.length - TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, 'encrypt'), iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new BackupIntegrityError('تعذر فك تشفير النسخة: الملف تالف أو مفتاح التشفير مختلف');
  }
}

/** بيان النسخة: يُحفظ بجانب الملف في التخزين، وموقّع بمفتاح النسخ ليُثبت أن النظام هو من أنشأها. */
export interface BackupManifest {
  formatVersion: 1;
  id: string;
  type: 'DAILY' | 'WEEKLY' | 'MANUAL' | 'PRE_RESTORE';
  storageKey: string;
  createdAt: string;
  sizeBytes: number;
  checksumSha256: string;
  schemaVersion: string;
  /** عدد الصفوف في كل جدول لحظة أخذ النسخة (من اللقطة نفسها التي قرأها pg_dump) */
  tableCounts: Record<string, number>;
  signature: string;
}

function canonical(manifest: Omit<BackupManifest, 'signature'>): string {
  const counts = Object.keys(manifest.tableCounts)
    .sort()
    .map((t) => `${t}=${manifest.tableCounts[t]}`)
    .join(',');
  return [
    manifest.formatVersion,
    manifest.id,
    manifest.type,
    manifest.storageKey,
    manifest.createdAt,
    manifest.sizeBytes,
    manifest.checksumSha256,
    manifest.schemaVersion,
    counts,
  ].join('\n');
}

export function signManifest(manifest: Omit<BackupManifest, 'signature'>, secret: string): BackupManifest {
  const signature = createHmac('sha256', deriveKey(secret, 'manifest')).update(canonical(manifest)).digest('hex');
  return { ...manifest, signature };
}

/** يعيد البيان إن كان سليم البنية وتوقيعه صحيحًا، وإلا يرمي خطأ سلامة. */
export function parseManifest(raw: Buffer, secret: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new BackupIntegrityError('بيان النسخة غير مقروء');
  }
  const m = value as Partial<BackupManifest> | null;
  const validCounts =
    !!m &&
    typeof m.tableCounts === 'object' &&
    m.tableCounts !== null &&
    Object.values(m.tableCounts).every((n) => Number.isInteger(n) && n >= 0);
  if (
    !m ||
    m.formatVersion !== 1 ||
    typeof m.id !== 'string' ||
    !['DAILY', 'WEEKLY', 'MANUAL', 'PRE_RESTORE'].includes(m.type as string) ||
    typeof m.storageKey !== 'string' ||
    typeof m.createdAt !== 'string' ||
    Number.isNaN(Date.parse(m.createdAt)) ||
    typeof m.sizeBytes !== 'number' ||
    typeof m.checksumSha256 !== 'string' ||
    typeof m.schemaVersion !== 'string' ||
    typeof m.signature !== 'string' ||
    !validCounts
  ) {
    throw new BackupIntegrityError('بيان النسخة غير صالح');
  }
  const manifest = m as BackupManifest;
  const { signature, ...unsigned } = manifest;
  const expected = signManifest(unsigned, secret).signature;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new BackupIntegrityError('توقيع بيان النسخة غير صحيح: لم ينشئها هذا النظام أو عُدِّلت');
  }
  return manifest;
}
