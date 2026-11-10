import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hmacBase64Url(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** مقارنة بزمن ثابت لنصين (تُقارن بصماتهما لتوحيد الطول). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function deriveKey(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(`abu-qamar:${purpose}`).digest();
}

/** تشفير AES-256-GCM. الناتج: v1.iv.tag.ciphertext (base64url). */
export function encryptSecret(plain: string, secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, purpose), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, secret: string, purpose: string): string {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('صيغة البيانات المشفرة غير صالحة');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, purpose), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
