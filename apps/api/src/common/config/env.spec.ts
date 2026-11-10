import { parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  SESSION_SECRET: 's'.repeat(40),
  DATA_ENCRYPTION_KEY: 'k'.repeat(40),
  APP_URL: 'http://localhost:3000',
};

describe('إعدادات البيئة', () => {
  it('القيم الافتراضية الآمنة في التطوير', () => {
    const config = parseEnv({ ...base });
    expect(config).toMatchObject({
      nodeEnv: 'development',
      isSecureEnv: false,
      port: 4000,
      sessionCookieName: 'aq_session',
      cookieSameSite: 'lax',
      allowedOrigins: ['http://localhost:3000'],
      enableApiDocs: true,
      reauthWindowMs: 5 * 60_000,
    });
    expect(config.setupToken).toBeUndefined();
  });

  it('يرفض الأسرار القصيرة أو المتطابقة، ولا يطبع القيم في رسالة الخطأ', () => {
    expect(() => parseEnv({ ...base, SESSION_SECRET: 'short-secret-value' })).toThrow(/SESSION_SECRET/);
    try {
      parseEnv({ ...base, SESSION_SECRET: 'short-secret-value' });
    } catch (error) {
      expect((error as Error).message).not.toContain('short-secret-value');
    }
    expect(() => parseEnv({ ...base, DATA_ENCRYPTION_KEY: base.SESSION_SECRET })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => parseEnv({ ...base, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('الإنتاج: كوكي __Host-، HTTPS إلزامي، والتوثيق مغلق افتراضيًا', () => {
    const prod = { ...base, NODE_ENV: 'production', APP_URL: 'https://app.example.com/' };
    const config = parseEnv(prod);
    expect(config).toMatchObject({
      isSecureEnv: true,
      sessionCookieName: '__Host-aq_session',
      enableApiDocs: false,
      appUrl: 'https://app.example.com',
    });
    expect(() => parseEnv({ ...prod, APP_URL: 'http://app.example.com' })).toThrow(/HTTPS/);
    expect(parseEnv({ ...prod, ENABLE_API_DOCS: 'true' }).enableApiDocs).toBe(true);
  });

  it('رمز الإعداد في الإنتاج يتطلب وقت انتهاء', () => {
    const prod = { ...base, NODE_ENV: 'production', APP_URL: 'https://app.example.com', SETUP_TOKEN: 't'.repeat(40) };
    expect(() => parseEnv(prod)).toThrow(/SETUP_TOKEN_EXPIRES_AT/);
    const config = parseEnv({ ...prod, SETUP_TOKEN_EXPIRES_AT: '2030-01-01T00:00:00Z' });
    expect(config.setupTokenExpiresAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(() => parseEnv({ ...base, SETUP_TOKEN: 'too-short' })).toThrow(/SETUP_TOKEN/);
  });

  it('CORS_ORIGIN يُدمج مع APP_URL دون تكرار أو شرطة أخيرة', () => {
    const config = parseEnv({ ...base, CORS_ORIGIN: 'http://localhost:3000/, https://staging.example.com ' });
    expect(config.allowedOrigins).toEqual(['http://localhost:3000', 'https://staging.example.com']);
  });
});
