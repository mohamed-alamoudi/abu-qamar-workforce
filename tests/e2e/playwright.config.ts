import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const localEnv = resolve(__dirname, '../../.env');
if (existsSync(localEnv)) process.loadEnvFile?.(localEnv);

/**
 * اختبارات E2E تعمل على نظام مشغَّل فعلًا (pnpm dev) بقاعدة تطوير/اختبار.
 * المتغيرات: E2E_BASE_URL (افتراضي http://localhost:3000)،
 * E2E_ADMIN_USERNAME و E2E_ADMIN_PASSWORD لحساب أدمن موجود في تلك القاعدة.
 */
export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    locale: 'ar',
    channel: process.env.E2E_BROWSER_CHANNEL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
