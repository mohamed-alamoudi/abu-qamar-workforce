import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** يحمّل ملف .env من جذر المستودع (إن وجد) دون تجاوز المتغيرات المعرّفة مسبقًا. */
export function loadRootEnvFile(): void {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (existsSync(file)) loadDotenv({ path: file });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const intWithDefault = (def: number, min = 0) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).default(def));
const boolWithDefault = (def: boolean) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : undefined),
    z.boolean().default(def),
  );

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(emptyToUndefined, z.enum(['development', 'test', 'staging', 'production']).default('development')),
    PORT: intWithDefault(4000, 1),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL مطلوب'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET يجب ألا يقل عن 32 حرفًا'),
    DATA_ENCRYPTION_KEY: z.string().min(32, 'DATA_ENCRYPTION_KEY يجب ألا يقل عن 32 حرفًا'),
    APP_URL: z.string().url('APP_URL يجب أن يكون رابطًا صالحًا'),
    CORS_ORIGIN: optionalString,
    TRUST_PROXY: intWithDefault(0),
    SESSION_TTL_HOURS: intWithDefault(12, 1),
    SESSION_IDLE_MINUTES: intWithDefault(120, 1),
    REMEMBER_DEVICE_TTL_DAYS: intWithDefault(30, 1),
    REAUTH_WINDOW_MINUTES: intWithDefault(5, 1),
    COOKIE_SAMESITE: z.preprocess(emptyToUndefined, z.enum(['lax', 'strict', 'none']).default('lax')),
    SETUP_TOKEN: z.preprocess(emptyToUndefined, z.string().min(32, 'SETUP_TOKEN يجب ألا يقل عن 32 حرفًا').optional()),
    SETUP_TOKEN_EXPIRES_AT: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
    RATE_LIMIT_PER_MINUTE: intWithDefault(300, 1),
    LOGIN_RATE_LIMIT_PER_MINUTE: intWithDefault(10, 1),
    ENABLE_API_DOCS: boolWithDefault(false),
    // ── النسخ الاحتياطي ──
    BACKUP_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().min(32, 'BACKUP_ENCRYPTION_KEY يجب ألا يقل عن 32 حرفًا').optional()),
    BACKUP_STORAGE_DRIVER: z.preprocess(emptyToUndefined, z.enum(['local', 's3']).optional()),
    BACKUP_LOCAL_DIR: optionalString,
    BACKUP_STORAGE_BUCKET: optionalString,
    BACKUP_STORAGE_REGION: optionalString,
    BACKUP_STORAGE_ACCESS_KEY: optionalString,
    BACKUP_STORAGE_SECRET_KEY: optionalString,
    BACKUP_STORAGE_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url('BACKUP_STORAGE_ENDPOINT يجب أن يكون رابطًا صالحًا').optional()),
    BACKUP_STORAGE_PREFIX: optionalString,
    BACKUP_STORAGE_FORCE_PATH_STYLE: z.preprocess(emptyToUndefined, z.string().optional()),
    PG_DUMP_COMMAND: optionalString,
    PG_RESTORE_COMMAND: optionalString,
    PG_TOOLS_HOST: optionalString,
    PG_TOOLS_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).optional()),
    // ── مراقبة الأخطاء (اختيارية) ──
    SENTRY_DSN: z.preprocess(emptyToUndefined, z.string().url('SENTRY_DSN يجب أن يكون رابطًا صالحًا').optional()),
  })
  .superRefine((env, ctx) => {
    const strict = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
    if (strict && env.SETUP_TOKEN && !env.SETUP_TOKEN_EXPIRES_AT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SETUP_TOKEN_EXPIRES_AT'],
        message: 'يجب تحديد SETUP_TOKEN_EXPIRES_AT مع SETUP_TOKEN في بيئتي الإنتاج والتجربة',
      });
    }
    if (strict && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['APP_URL'], message: 'APP_URL يجب أن يكون HTTPS في الإنتاج' });
    }
    if (env.BACKUP_ENCRYPTION_KEY && [env.SESSION_SECRET, env.DATA_ENCRYPTION_KEY].includes(env.BACKUP_ENCRYPTION_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BACKUP_ENCRYPTION_KEY'],
        message: 'BACKUP_ENCRYPTION_KEY يجب أن يختلف عن SESSION_SECRET و DATA_ENCRYPTION_KEY',
      });
    }
    const s3 = env.BACKUP_STORAGE_DRIVER === 's3' || (!env.BACKUP_STORAGE_DRIVER && !!env.BACKUP_STORAGE_BUCKET);
    if (s3) {
      for (const key of ['BACKUP_STORAGE_BUCKET', 'BACKUP_STORAGE_REGION', 'BACKUP_STORAGE_ACCESS_KEY', 'BACKUP_STORAGE_SECRET_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} مطلوب لتخزين النسخ على S3` });
      }
    }
    if (strict && env.BACKUP_STORAGE_ENDPOINT && !env.BACKUP_STORAGE_ENDPOINT.startsWith('https://')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BACKUP_STORAGE_ENDPOINT'], message: 'BACKUP_STORAGE_ENDPOINT يجب أن يكون HTTPS في الإنتاج' });
    }
    if (env.SESSION_SECRET === env.DATA_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATA_ENCRYPTION_KEY'],
        message: 'DATA_ENCRYPTION_KEY يجب أن يختلف عن SESSION_SECRET',
      });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'staging' | 'production';
  /** إنتاج أو تجربة: كوكيز Secure، وإخفاء تفاصيل الأخطاء */
  isSecureEnv: boolean;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  dataEncryptionKey: string;
  appUrl: string;
  allowedOrigins: string[];
  trustProxy: number;
  sessionTtlMs: number;
  sessionIdleMs: number;
  rememberTtlMs: number;
  reauthWindowMs: number;
  cookieSameSite: 'lax' | 'strict' | 'none';
  sessionCookieName: string;
  setupToken?: string;
  setupTokenExpiresAt?: Date;
  rateLimitPerMinute: number;
  loginRateLimitPerMinute: number;
  enableApiDocs: boolean;
  backup: BackupConfig;
  /** عنوان خدمة مراقبة الأخطاء (متوافق مع Sentry). غير معرّف = المراقبة معطلة. */
  sentryDsn?: string;
}

export interface BackupS3Config {
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

export interface BackupConfig {
  /** غير معرّف = النسخ الاحتياطي معطل (يُرفض الطلب برسالة واضحة) */
  encryptionKey?: string;
  driver: 'local' | 's3';
  localDir: string;
  prefix: string;
  s3?: BackupS3Config;
  /** أمر تشغيل pg_dump / pg_restore (قد يكون عبر docker exec محليًا) مقسّمًا إلى أجزاء */
  pgDumpCommand: string[];
  pgRestoreCommand: string[];
  /** العنوان والمنفذ كما تراهما أدوات PostgreSQL (يختلفان عن DATABASE_URL عند التشغيل داخل حاوية) */
  pgToolsHost?: string;
  pgToolsPort?: number;
}

/** "docker exec -i db pg_dump" أو مصفوفة JSON (لمسارات فيها مسافات). */
export function parseCommand(value: string | undefined, fallback: string): string[] {
  const text = (value ?? '').trim();
  if (!text) return [fallback];
  if (text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === 'string' && p)) return parsed as string[];
    throw new Error('صيغة أمر أدوات PostgreSQL غير صالحة');
  }
  return text.split(/\s+/);
}

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function parseEnv(source: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // نعرض أسماء المتغيرات والرسائل فقط — لا نطبع القيم أبدًا.
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`إعدادات البيئة غير صالحة:\n${lines.join('\n')}`);
  }
  const env = result.data;
  const isSecureEnv = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  const normalize = (o: string) => o.trim().replace(/\/+$/, '');
  const origins = new Set<string>([normalize(env.APP_URL)]);
  for (const o of (env.CORS_ORIGIN ?? '').split(',')) if (o.trim()) origins.add(normalize(o));

  return {
    nodeEnv: env.NODE_ENV,
    isSecureEnv,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    dataEncryptionKey: env.DATA_ENCRYPTION_KEY,
    appUrl: normalize(env.APP_URL),
    allowedOrigins: [...origins],
    trustProxy: env.TRUST_PROXY,
    sessionTtlMs: env.SESSION_TTL_HOURS * 3_600_000,
    sessionIdleMs: env.SESSION_IDLE_MINUTES * 60_000,
    rememberTtlMs: env.REMEMBER_DEVICE_TTL_DAYS * 86_400_000,
    reauthWindowMs: env.REAUTH_WINDOW_MINUTES * 60_000,
    cookieSameSite: env.COOKIE_SAMESITE,
    // بادئة __Host- تفرض Secure و Path=/ وتمنع تحديد Domain (متاحة فقط مع HTTPS).
    sessionCookieName: isSecureEnv ? '__Host-aq_session' : 'aq_session',
    setupToken: env.SETUP_TOKEN,
    setupTokenExpiresAt: env.SETUP_TOKEN_EXPIRES_AT,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    loginRateLimitPerMinute: env.LOGIN_RATE_LIMIT_PER_MINUTE,
    enableApiDocs: !isSecureEnv || env.ENABLE_API_DOCS,
    backup: {
      encryptionKey: env.BACKUP_ENCRYPTION_KEY,
      driver: env.BACKUP_STORAGE_DRIVER ?? (env.BACKUP_STORAGE_BUCKET ? 's3' : 'local'),
      localDir: env.BACKUP_LOCAL_DIR ?? join(findRepoRoot(), '.backups'),
      prefix: (env.BACKUP_STORAGE_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
      s3:
        env.BACKUP_STORAGE_BUCKET && env.BACKUP_STORAGE_REGION && env.BACKUP_STORAGE_ACCESS_KEY && env.BACKUP_STORAGE_SECRET_KEY
          ? {
              bucket: env.BACKUP_STORAGE_BUCKET,
              region: env.BACKUP_STORAGE_REGION,
              accessKey: env.BACKUP_STORAGE_ACCESS_KEY,
              secretKey: env.BACKUP_STORAGE_SECRET_KEY,
              endpoint: env.BACKUP_STORAGE_ENDPOINT?.replace(/\/+$/, ''),
              forcePathStyle: env.BACKUP_STORAGE_FORCE_PATH_STYLE
                ? ['1', 'true', 'yes'].includes(env.BACKUP_STORAGE_FORCE_PATH_STYLE.toLowerCase())
                : !!env.BACKUP_STORAGE_ENDPOINT,
            }
          : undefined,
      pgDumpCommand: parseCommand(env.PG_DUMP_COMMAND, 'pg_dump'),
      pgRestoreCommand: parseCommand(env.PG_RESTORE_COMMAND, 'pg_restore'),
      pgToolsHost: env.PG_TOOLS_HOST,
      pgToolsPort: env.PG_TOOLS_PORT,
    },
    sentryDsn: env.SENTRY_DSN,
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cached) {
    loadRootEnvFile();
    cached = parseEnv(process.env);
  }
  return cached;
}

/** للاختبارات فقط. */
export function resetConfigCache(): void {
  cached = undefined;
}
