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
