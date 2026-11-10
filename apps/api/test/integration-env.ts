/**
 * يُنفَّذ قبل كل ملف اختبار تكامل: يوجّه الخادم إلى قاعدة الاختبار حصرًا
 * ويولّد أسرارًا عشوائية لكل تشغيل.
 */
import { randomBytes } from 'crypto';
import { loadRootEnvFile } from '../src/common/config/env';
import { assertSafeTestDatabaseUrl } from './test-database';

loadRootEnvFile();
process.env.DATABASE_URL = assertSafeTestDatabaseUrl(process.env.DATABASE_URL_TEST, process.env.DATABASE_URL);
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = randomBytes(48).toString('base64url');
process.env.DATA_ENCRYPTION_KEY = randomBytes(48).toString('base64url');
process.env.SETUP_TOKEN = randomBytes(32).toString('base64url');
process.env.SETUP_TOKEN_EXPIRES_AT = '';
process.env.APP_URL = 'http://localhost:3000';
process.env.CORS_ORIGIN = 'http://localhost:3000';
process.env.TRUST_PROXY = '0';
process.env.SESSION_TTL_HOURS = '12';
process.env.SESSION_IDLE_MINUTES = '120';
process.env.REMEMBER_DEVICE_TTL_DAYS = '30';
process.env.REAUTH_WINDOW_MINUTES = '5';
process.env.COOKIE_SAMESITE = 'lax';
// الحظر المؤقت (قاعدة البيانات) هو المقصود بالاختبار؛ نرفع حد المعدل العام حتى لا يتداخل معه
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '100000';
