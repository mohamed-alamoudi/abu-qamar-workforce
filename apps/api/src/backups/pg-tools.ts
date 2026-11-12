import { spawn } from 'child_process';
import type { BackupConfig } from '../common/config/env';

/** حد أقصى لحجم النسخة في الذاكرة (512 ميغابايت) — قاعدة متجر واحد أصغر من ذلك بكثير. */
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

export class PgToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgToolError';
  }
}

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslmode?: string;
}

export function parseDatabaseUrl(url: string): PgConnection {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    sslmode: parsed.searchParams.get('sslmode') ?? undefined,
  };
}

/** رابط القاعدة نفسها مع اسم قاعدة مختلف (لقاعدة تجربة الاسترداد على الخادم نفسه). */
export function withDatabaseName(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * تشغيل pg_dump و pg_restore.
 * - الأمر قابل للضبط: ثنائي أصلي (Render) أو `docker exec -i -e PGPASSWORD <حاوية> pg_dump` محليًا.
 * - كلمة المرور تُمرَّر في متغير البيئة PGPASSWORD فقط — لا تظهر في سطر الأوامر ولا في السجلات.
 * - لا يُستعمل shell إطلاقًا (spawn بمصفوفة وسائط)، فلا مجال لحقن أوامر.
 */
export class PgTools {
  constructor(private readonly config: BackupConfig) {}

  private connectionArgs(connection: PgConnection): string[] {
    return [
      `--host=${this.config.pgToolsHost ?? connection.host}`,
      `--port=${this.config.pgToolsPort ?? connection.port}`,
      `--username=${connection.user}`,
      `--dbname=${connection.database}`,
      '--no-password',
    ];
  }

  private run(command: string[], args: string[], connection: PgConnection, input?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const [bin, ...prefix] = command;
      const child = spawn(bin, [...prefix, ...args], {
        env: { ...process.env, PGPASSWORD: connection.password, ...(connection.sslmode ? { PGSSLMODE: connection.sslmode } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failed: Error | null = null;

      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BACKUP_BYTES) {
          failed = new PgToolError('حجم النسخة تجاوز الحد المسموح');
          child.kill();
          return;
        }
        chunks.push(chunk);
      });
      // قد تتضمن أخطاء COPY محتوى صفوف حساسة.
      child.stderr.resume();
      child.on('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        reject(new PgToolError(code === 'ENOENT' ? `الأداة ${bin} غير موجودة على الخادم` : `تعذر تشغيل ${bin}`));
      });
      child.on('close', (code) => {
        if (failed) return reject(failed);
        if (code !== 0) {
          return reject(new PgToolError(`فشلت أداة PostgreSQL (رمز ${code})`));
        }
        resolve(Buffer.concat(chunks));
      });
      // إغلاق القناة مبكرًا من الطرف الآخر (EPIPE) يظهر كخطأ خروج، لا كاستثناء غير ملتقط
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
  }

  /** نسخة بصيغة pg_dump المخصصة (‎-Fc) من لقطة محددة، دون مالكين أو صلاحيات. */
  dump(databaseUrl: string, snapshotId?: string): Promise<Buffer> {
    const connection = parseDatabaseUrl(databaseUrl);
    const args = ['--format=custom', '--no-owner', '--no-privileges', ...(snapshotId ? [`--snapshot=${snapshotId}`] : [])];
    return this.run(this.config.pgDumpCommand, [...args, ...this.connectionArgs(connection)], connection);
  }

  /** فهرس محتويات الأرشيف (لا يتصل بأي قاعدة) — يثبت أن الملف أرشيف pg_dump صالح. */
  async listContents(archive: Buffer): Promise<string[]> {
    const connection: PgConnection = { host: '', port: 0, user: '', password: '', database: '' };
    const output = await this.run(this.config.pgRestoreCommand, ['--list'], connection, archive);
    return output
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith(';'));
  }

  /** استرداد كامل داخل معاملة واحدة: إما ينجح كله أو لا يتغير شيء. */
  async restore(databaseUrl: string, archive: Buffer): Promise<void> {
    const connection = parseDatabaseUrl(databaseUrl);
    const args = ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error'];
    await this.run(this.config.pgRestoreCommand, [...args, ...this.connectionArgs(connection)], connection, archive);
  }
}
