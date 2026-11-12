import { createHash, createHmac } from 'crypto';
import type { BackupS3Config } from '../../common/config/env';
import { assertSafeKey, BackupObjectNotFoundError, BackupStorage } from './backup-storage';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** ترميز RFC 3986 كما تشترطه AWS (لا يُرمَّز: A-Z a-z 0-9 - _ . ~). */
export function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignInput {
  method: string;
  host: string;
  /** المسار مرمَّزًا (يبدأ بـ /) */
  path: string;
  query?: Record<string, string>;
  /** ترويسات إضافية تدخل في التوقيع (بأحرف صغيرة) */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKey: string;
  secretKey: string;
  now: Date;
}

/** توقيع AWS Signature Version 4 لخدمة S3. يعيد الترويسات الكاملة للطلب. */
export function signS3Request(input: SignInput): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(input.query ?? {})
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode((input.query as Record<string, string>)[k])}`)
    .join('&');
  const canonicalRequest = [input.method, input.path, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, dateStamp), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }) => Promise<Response>;

/**
 * تخزين متوافق مع S3 (AWS S3، Cloudflare R2، Backblaze B2، MinIO...) دون حزم إضافية:
 * طلبات REST موقّعة بـ SigV4 عبر fetch المضمّن في Node.
 */
export class S3BackupStorage implements BackupStorage {
  readonly driver = 's3' as const;
  private readonly base: URL;
  private readonly bucketInPath: boolean;

  constructor(
    private readonly config: BackupS3Config,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init as RequestInit),
    private readonly clock: () => Date = () => new Date(),
  ) {
    const endpoint = config.endpoint ?? `https://s3.${config.region}.amazonaws.com`;
    const url = new URL(endpoint);
    this.bucketInPath = config.forcePathStyle;
    if (!this.bucketInPath) url.hostname = `${config.bucket}.${url.hostname}`;
    this.base = url;
  }

  private async send(method: string, key: string | null, query: Record<string, string> = {}, body?: Buffer): Promise<Response> {
    const segments = [
      ...this.base.pathname.split('/').filter(Boolean),
      ...(this.bucketInPath ? [this.config.bucket] : []),
      ...(key ? key.split('/') : []),
    ];
    const path = `/${segments.map(awsEncode).join('/')}`;
    const headers = signS3Request({
      method,
      host: this.base.host,
      path,
      query,
      payloadHash: body ? sha256Hex(body) : EMPTY_SHA256,
      region: this.config.region,
      accessKey: this.config.accessKey,
      secretKey: this.config.secretKey,
      now: this.clock(),
    });
    // الترويسة host يضبطها fetch نفسه
    const { host: _host, ...sendHeaders } = headers;
    void _host;
    if (body) sendHeaders['content-type'] = 'application/octet-stream';
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${awsEncode(k)}=${awsEncode(query[k])}`)
      .join('&');
    return this.fetchImpl(`${this.base.protocol}//${this.base.host}${path}${qs ? `?${qs}` : ''}`, { method, headers: sendHeaders, body });
  }

  /** لا نضع نص الرد في رسالة الخطأ (قد يحتوي تفاصيل الحساب)، فقط رمز الحالة. */
  private fail(action: string, response: Response): never {
    throw new Error(`فشل ${action} في تخزين النسخ (HTTP ${response.status})`);
  }

  async put(key: string, data: Buffer): Promise<void> {
    assertSafeKey(key);
    const response = await this.send('PUT', key, {}, data);
    if (!response.ok) this.fail('رفع الملف', response);
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const response = await this.send('GET', key);
    if (response.status === 404) throw new BackupObjectNotFoundError(key);
    if (!response.ok) this.fail('تنزيل الملف', response);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const response = await this.send('DELETE', key);
    if (!response.ok && response.status !== 404) this.fail('حذف الملف', response);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const response = await this.send('GET', null, query);
      if (!response.ok) this.fail('سرد الملفات', response);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(match[1]));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || undefined
        : undefined;
    } while (token);
    return keys.sort();
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
