/** يُنفَّذ مرة واحدة قبل اختبارات التكامل: يطبّق كل الـ migrations على قاعدة الاختبار. */
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { loadRootEnvFile } from '../src/common/config/env';
import { assertSafeTestDatabaseUrl } from './test-database';

export default function globalSetup(): void {
  loadRootEnvFile();
  const url = assertSafeTestDatabaseUrl(process.env.DATABASE_URL_TEST, process.env.DATABASE_URL);
  const databaseDir = resolve(__dirname, '../../../packages/database');
  const prismaCli = require.resolve('prisma/build/index.js', { paths: [databaseDir] });
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: databaseDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
