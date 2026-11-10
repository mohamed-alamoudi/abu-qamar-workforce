/** قيم بيئة عشوائية لاختبارات الوحدة (لا أسرار ثابتة في الكود). */
import { randomBytes } from 'crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://unit:unit@localhost:1/unit_tests_do_not_connect';
process.env.SESSION_SECRET = randomBytes(48).toString('base64url');
process.env.DATA_ENCRYPTION_KEY = randomBytes(48).toString('base64url');
process.env.APP_URL = 'http://localhost:3000';
