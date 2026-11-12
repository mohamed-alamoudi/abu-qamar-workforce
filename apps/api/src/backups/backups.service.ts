import { Inject, Injectable, Logger } from '@nestjs/common';
import { BackupRecord, BackupType, Prisma, PrismaClient } from '@abu-qamar/database';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { APP_CONFIG, AppConfig } from '../common/config/env';
import { AppException, Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { MaintenanceService } from '../maintenance/maintenance.module';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.module';
import {
  BackupIntegrityError,
  BackupManifest,
  decryptBackup,
  encryptBackup,
  parseManifest,
  sha256Buffer,
  signManifest,
} from './backup-crypto';
import { parseDatabaseUrl, PgToolError, PgTools, withDatabaseName } from './pg-tools';
import { BACKUP_STORAGE, BackupObjectNotFoundError, BackupStorage } from './storage/backup-storage';

const MANIFEST_SUFFIX = '.manifest.json';
const STALE_AFTER_MS = 2 * 3_600_000;
const DUMP_TIMEOUT_MS = 10 * 60_000;

type Db = Pick<PrismaClient, '$queryRaw' | '$queryRawUnsafe'>;

export interface RestoreStep {
  step: number;
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RestoreReport {
  backupId: string;
  safetyBackupId: string | null;
  restoredAt: string;
  steps: RestoreStep[];
  tableCounts: Record<string, number>;
}

interface Inspected {
  record: BackupRecord;
  manifest: BackupManifest;
  /** أرشيف pg_dump بعد فك التشفير */
  archive: Buffer;
  /** عدد الجداول التي يحمل الأرشيف بياناتها */
  dataTables: number;
}

/** مدة الاحتفاظ حسب السياسة المعتمدة (docs/backup-restore.md). اليدوية تبقى حتى يحذفها الأدمن. */
export function expiryFor(type: BackupType, from: Date): Date | null {
  const start = DateTime.fromJSDate(from, { zone: 'utc' });
  if (type === 'DAILY' || type === 'PRE_RESTORE') return start.plus({ days: 30 }).toJSDate();
  if (type === 'WEEKLY') return start.plus({ months: 3 }).toJSDate();
  return null;
}

/** النسخة المجدولة: أسبوعية في أول يوم من الأسبوع المحلي، ويومية في بقية الأيام. */
export function scheduledTypeFor(now: Date, timezone: string, weekStartsOn: number): 'DAILY' | 'WEEKLY' {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  // luxon: الاثنين = 1 … الأحد = 7 ؛ JavaScript: الأحد = 0
  return local.weekday % 7 === weekStartsOn ? 'WEEKLY' : 'DAILY';
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function countTables(db: Db): Promise<Record<string, number>> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "public".${quoteIdent(tablename)}`);
    counts[tablename] = Number(rows[0].n);
  }
  return counts;
}

async function latestMigration(db: Db): Promise<string> {
  const rows = await db.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    ORDER BY migration_name DESC LIMIT 1`;
  if (!rows[0]) throw new Error('لا توجد migrations مطبَّقة على القاعدة');
  return rows[0].migration_name;
}

function diffCounts(expected: Record<string, number>, actual: Record<string, number>): string[] {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const diffs: string[] = [];
  for (const name of [...names].sort()) {
    if (expected[name] !== actual[name]) diffs.push(`${name}: المتوقع ${expected[name] ?? 'غير موجود'}، الفعلي ${actual[name] ?? 'غير موجود'}`);
  }
  return diffs;
}

@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);
  private readonly pgTools: PgTools;
  /** نسخة أو استرداد واحد في الوقت نفسه داخل هذه العملية */
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly maintenance: MaintenanceService,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BACKUP_STORAGE) private readonly storage: BackupStorage,
  ) {
    this.pgTools = new PgTools(config.backup);
  }

  // ───────────────────────────── أدوات داخلية ─────────────────────────────

  private get key(): string {
    const key = this.config.backup.encryptionKey;
    if (!key) throw Errors.backupNotConfigured();
    return key;
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy || this.maintenance.active) throw Errors.conflict('توجد عملية نسخ أو استرداد أخرى جارية. انتظر انتهاءها');
    this.busy = true;
    // اتصال مستقل حتى يبقى القفل قائمًا عندما يُعيد الاسترداد فتح مجمع اتصالات API.
    const lock = new PrismaClient({ datasources: { db: { url: this.config.databaseUrl } } });
    try {
      return await lock.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(610416, 20261112) AS acquired`;
        if (!row.acquired) throw Errors.conflict('توجد عملية نسخ احتياطي أو استرداد أخرى جارية');
        return work();
      }, { timeout: 45 * 60_000 });
    } finally {
      this.busy = false;
      await lock.$disconnect();
    }
  }

  private toPublic(record: BackupRecord & { triggeredBy?: { fullName: string } | null }) {
    return {
      id: record.id,
      type: record.type,
      status: record.status,
      sizeBytes: record.sizeBytes === null ? null : Number(record.sizeBytes),
      checksumSha256: record.checksumSha256,
      schemaVersion: record.schemaVersion,
      encrypted: record.encrypted,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      verifiedAt: record.verifiedAt,
      expiresAt: record.expiresAt,
      errorMessage: record.errorMessage,
      triggeredByName: record.triggeredBy?.fullName ?? null,
    };
  }

  private storageKeyFor(id: string, type: BackupType, at: Date): string {
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const parts = [this.config.backup.prefix, 'backups', stamp.slice(0, 4), stamp.slice(4, 6), `${type.toLowerCase()}-${stamp}-${id}.aqbk`];
    return parts.filter(Boolean).join('/');
  }

  private describe(error: unknown): string {
    if (error instanceof AppException || error instanceof PgToolError || error instanceof BackupIntegrityError) return error.message;
    if (error instanceof BackupObjectNotFoundError) return 'ملف النسخة غير موجود في التخزين';
    // أخطاء غير متوقعة: الاسم فقط، دون نص قد يحمل تفاصيل الاتصال
    return `خطأ غير متوقع (${error instanceof Error ? error.name : 'unknown'})`;
  }

  private async markStale(): Promise<void> {
    await this.prisma.backupRecord.updateMany({
      where: { status: 'IN_PROGRESS', startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
      data: { status: 'FAILED', errorMessage: 'انقطعت العملية قبل اكتمالها', completedAt: new Date() },
    });
  }

  // ───────────────────────────── إنشاء نسخة ─────────────────────────────

  /**
   * ينشئ نسخة مشفّرة:
   * لقطة واحدة متسقة (REPEATABLE READ + pg_export_snapshot) يُقرأ منها عدد الصفوف ويأخذ منها pg_dump،
   * فتطابق الأعداد المسجلة محتوى الملف تمامًا ويمكن التحقق منها بعد الاسترداد.
   */
  private async createInternal(type: BackupType, actor: AuthContext | null, meta: RequestMeta | null) {
    const encryptionKey = this.key;
    await this.markStale();
    const startedAt = new Date();
    const record = await this.prisma.backupRecord.create({
      data: { type, status: 'IN_PROGRESS', startedAt, triggeredById: actor?.user.id ?? null, expiresAt: expiryFor(type, startedAt) },
    });

    try {
      const { archive, tableCounts, schemaVersion } = await this.prisma.$transaction(
        async (tx) => {
          const snapshot = await tx.$queryRaw<{ id: string }[]>`SELECT pg_export_snapshot() AS id`;
          return {
            tableCounts: await countTables(tx),
            schemaVersion: await latestMigration(tx),
            archive: await this.pgTools.dump(this.config.databaseUrl, snapshot[0].id),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: DUMP_TIMEOUT_MS, maxWait: 15_000 },
      );

      const encrypted = encryptBackup(archive, encryptionKey);
      const checksumSha256 = sha256Buffer(encrypted);
      const storageKey = this.storageKeyFor(record.id, type, startedAt);
      const manifest = signManifest(
        {
          formatVersion: 1,
          id: record.id,
          type,
          storageKey,
          createdAt: startedAt.toISOString(),
          sizeBytes: encrypted.length,
          checksumSha256,
          schemaVersion,
          tableCounts,
        },
        encryptionKey,
      );
      await this.storage.put(storageKey, encrypted);
      await this.storage.put(storageKey + MANIFEST_SUFFIX, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

      // تحقق فوري: ما وصل إلى التخزين هو ما أُرسل فعلًا
      const stored = await this.storage.get(storageKey);
      if (sha256Buffer(stored) !== checksumSha256) throw new BackupIntegrityError('الملف المخزَّن لا يطابق ما أُرسل');

      const completed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.backupRecord.update({
          where: { id: record.id },
          data: { status: 'COMPLETED', storageKey, sizeBytes: BigInt(encrypted.length), checksumSha256, schemaVersion, completedAt: new Date() },
        });
        await this.audit.log(
          {
            action: 'backup.created',
            actor,
            entityType: 'backup',
            entityId: record.id,
            after: { type, sizeBytes: encrypted.length, schemaVersion, storage: this.storage.driver },
            meta,
          },
          tx,
        );
        return updated;
      });
      return { record: completed, archive, manifest };
    } catch (error) {
      const message = this.describe(error);
      this.logger.error(`فشل النسخ الاحتياطي (${type}): ${message}`);
      await this.prisma.backupRecord
        .update({ where: { id: record.id }, data: { status: 'FAILED', errorMessage: message.slice(0, 500), completedAt: new Date() } })
        .catch(() => undefined);
      await this.notifications.notifyAdmin({
        type: 'BACKUP_FAILED',
        title: 'فشل النسخ الاحتياطي',
        body: `تعذر إنشاء النسخة الاحتياطية (${TYPE_LABEL[type]}): ${message}`.slice(0, 500),
        data: { backupId: record.id, backupType: type },
      });
      throw error instanceof AppException ? error : Errors.conflict(`تعذر إنشاء النسخة الاحتياطية: ${message}`);
    }
  }

  async create(type: BackupType, actor: AuthContext | null, meta: RequestMeta | null = null) {
    return this.exclusive(async () => this.toPublic((await this.createInternal(type, actor, meta)).record));
  }

  /** للمهمة المجدولة: نسخة واحدة في اليوم المحلي (أسبوعية أول الأسبوع ويومية غير ذلك)، ثم تنظيف المنتهية. */
  async runScheduled(now = new Date()) {
    return this.exclusive(async () => {
      const settings = await this.settings.getAll();
      const timezone = settings['general.timezone'];
      const type = scheduledTypeFor(now, timezone, settings['general.weekStartsOn']);
      const dayStart = DateTime.fromJSDate(now, { zone: timezone }).startOf('day').toJSDate();
      const existing = await this.prisma.backupRecord.findFirst({
        where: { type: { in: ['DAILY', 'WEEKLY'] }, status: { in: ['COMPLETED', 'VERIFIED'] }, startedAt: { gte: dayStart } },
      });
      const created = existing ? null : this.toPublic((await this.createInternal(type, null, null)).record);
      const expired = await this.expireInternal(now);
      return { type, skipped: existing !== null, backup: created, expired };
    });
  }

  // ───────────────────────────── القراءة ─────────────────────────────

  async list() {
    const records = await this.prisma.backupRecord.findMany({
      orderBy: { startedAt: 'desc' },
      take: 200,
      include: { triggeredBy: { select: { fullName: true } } },
    });
    return {
      configured: !!this.config.backup.encryptionKey,
      storage: this.storage.driver,
      maintenance: this.maintenance.status(),
      currentSchemaVersion: await latestMigration(this.prisma),
      items: records.map((r) => this.toPublic(r)),
    };
  }

  // ───────────────────────────── فحص السلامة ─────────────────────────────

  /**
   * الخطوات 2–4 من الاسترداد: لا تُقبل إلا نسخة مسجلة في النظام، موقَّع بيانها بمفتاحه،
   * بصمتها مطابقة، يُفك تشفيرها بنجاح، وأرشيفها صالح.
   */
  private async inspect(id: string): Promise<Inspected> {
    const encryptionKey = this.key;
    const record = await this.prisma.backupRecord.findUnique({ where: { id } });
    if (!record) throw Errors.notFound('النسخة الاحتياطية غير موجودة');
    if (!['COMPLETED', 'VERIFIED'].includes(record.status) || !record.storageKey || !record.checksumSha256) {
      throw Errors.conflict('هذه النسخة غير مكتملة أو انتهت صلاحيتها ولا يمكن استخدامها');
    }
    try {
      const file = await this.storage.get(record.storageKey);
      if (sha256Buffer(file) !== record.checksumSha256) throw new BackupIntegrityError('بصمة الملف (SHA-256) لا تطابق المسجلة: الملف تالف أو مستبدل');
      const manifest = parseManifest(await this.storage.get(record.storageKey + MANIFEST_SUFFIX), encryptionKey);
      if (manifest.id !== record.id || manifest.storageKey !== record.storageKey || manifest.checksumSha256 !== record.checksumSha256) {
        throw new BackupIntegrityError('بيان النسخة لا يخص هذا الملف');
      }
      const archive = decryptBackup(file, encryptionKey);
      let toc: string[];
      try {
        toc = await this.pgTools.listContents(archive);
      } catch (error) {
        if (error instanceof PgToolError && /غير موجودة|تعذر تشغيل/.test(error.message)) throw error;
        throw new BackupIntegrityError('محتوى النسخة ليس أرشيف قاعدة بيانات صالحًا');
      }
      const dataTables = toc.filter((line) => /\sTABLE DATA\s/.test(line)).length;
      if (dataTables === 0) throw new BackupIntegrityError('النسخة لا تحتوي بيانات جداول');
      return { record, manifest, archive, dataTables };
    } catch (error) {
      if (error instanceof BackupIntegrityError || error instanceof BackupObjectNotFoundError) {
        const message = this.describe(error);
        await this.audit.log({ action: 'backup.integrity_failed', entityType: 'backup', entityId: id, metadata: { reason: message } });
        await this.notifications.notifyAdmin({
          type: 'BACKUP_FAILED',
          title: 'نسخة احتياطية غير سليمة',
          body: `فشل فحص سلامة نسخة احتياطية: ${message}`.slice(0, 500),
          data: { backupId: id },
        });
        throw Errors.backupIntegrity(message);
      }
      if (error instanceof PgToolError) throw Errors.conflict(error.message);
      throw error;
    }
  }

  async verify(id: string, actor: AuthContext | null, meta: RequestMeta | null = null) {
    const { record, dataTables } = await this.inspect(id);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.backupRecord.update({ where: { id: record.id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
      await this.audit.log({ action: 'backup.verified', actor, entityType: 'backup', entityId: id, metadata: { dataTables }, meta }, tx);
      return next;
    });
    return this.toPublic(updated);
  }

  /** معاينة ما ستعيده النسخة مقارنةً بالوضع الحالي، قبل اتخاذ قرار الاسترداد. */
  async preview(id: string) {
    const { record, manifest, dataTables } = await this.inspect(id);
    const currentSchemaVersion = await latestMigration(this.prisma);
    const currentCounts = await countTables(this.prisma);
    const tables = [...new Set([...Object.keys(manifest.tableCounts), ...Object.keys(currentCounts)])]
      .sort()
      .map((name) => ({ name, inBackup: manifest.tableCounts[name] ?? null, current: currentCounts[name] ?? null }));
    return {
      backup: this.toPublic(record),
      integrity: { checksumMatches: true, signatureValid: true, decrypted: true, archiveValid: true, dataTables },
      schema: {
        backupVersion: manifest.schemaVersion,
        currentVersion: currentSchemaVersion,
        compatible: manifest.schemaVersion === currentSchemaVersion,
      },
      tables,
    };
  }

  // ───────────────────────────── الاسترداد ─────────────────────────────

  private async reconnect(): Promise<void> {
    // الاتصالات القديمة تحمل خططًا مخزّنة لجداول حُذفت وأُعيد إنشاؤها
    await this.prisma.$disconnect();
    await this.prisma.$connect();
  }

  /** بعد الاسترداد: سجلات النسخ الأحدث من النسخة المستردة تُعاد، وتُلغى كل الجلسات، ويُسجَّل الحدث. */
  private async finalizeRestore(restoredId: string, preserved: BackupRecord[], actor: AuthContext | null, meta: RequestMeta | null, safetyId: string) {
    const userIds = new Set((await this.prisma.user.findMany({ select: { id: true } })).map((u) => u.id));
    const actorExists = !!actor && userIds.has(actor.user.id);
    await this.prisma.$transaction(async (tx) => {
      for (const row of preserved) {
        const data = { ...row, triggeredById: row.triggeredById && userIds.has(row.triggeredById) ? row.triggeredById : null };
        await tx.backupRecord.upsert({ where: { id: row.id }, create: data, update: data });
      }
      await tx.backupRecord.update({ where: { id: restoredId }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
      await tx.session.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'backup_restore' } });
      await tx.auditLog.create({
        data: {
          action: 'backup.restored',
          actorId: actorExists ? actor.user.id : null,
          actorUsername: actor?.user.username ?? 'cli',
          entityType: 'backup',
          entityId: restoredId,
          metadata: { safetyBackupId: safetyId },
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
        },
      });
    });
  }

  /**
   * الخطوات العشر (القسم 15). يفرض الحارس إعادة التحقق من كلمة المرور على مسار الاسترداد.
   */
  async restore(
    id: string,
    actor: AuthContext,
    meta: RequestMeta,
  ): Promise<RestoreReport> {
    return this.exclusive(async () => {
      const steps: RestoreStep[] = [];
      const done = (step: number, name: string, detail?: string) => steps.push({ step, name, ok: true, detail });

      // 1–2
      const inspected = await this.inspect(id);
      done(1, 'اختيار النسخة', `${TYPE_LABEL[inspected.record.type]} — ${inspected.record.startedAt.toISOString()}`);
      done(2, 'فحص سلامة الملف', 'البصمة والتوقيع والتشفير سليمة');

      // 3
      const currentSchemaVersion = await latestMigration(this.prisma);
      if (inspected.manifest.schemaVersion !== currentSchemaVersion) {
        throw Errors.conflict('إصدار مخطط النسخة غير مطابق لإصدار القاعدة الحالية');
      }
      done(3, 'التحقق من إصدار القاعدة', inspected.manifest.schemaVersion);

      // 4
      const totalRows = Object.values(inspected.manifest.tableCounts).reduce((a, b) => a + b, 0);
      done(4, 'معاينة المحتوى', `${inspected.dataTables} جدولًا، ${totalRows} صفًّا`);

      if (!this.maintenance.enter('restore')) throw Errors.conflict('النظام في وضع الصيانة مسبقًا');
      let reopen = true;
      try {
        await this.maintenance.drainRequests();
        // نغلق الكتابة قبل التقاط نسخة الأمان كي تشمل أحدث البيانات.
        const safety = await this.createInternal('PRE_RESTORE', actor, meta);
        done(5, 'نسخة أمان من البيانات الحالية', safety.record.id);
        done(6, 'إعادة التحقق من هوية الأدمن');
        done(7, 'إيقاف الكتابة والمزامنة');

        const preserved = await this.prisma.backupRecord.findMany();
        await this.audit.log({ action: 'backup.restore_started', actor, entityType: 'backup', entityId: id, metadata: { safetyBackupId: safety.record.id }, meta });

        try {
          await this.pgTools.restore(this.config.databaseUrl, inspected.archive);
          await this.reconnect();
          done(8, 'الاسترداد');

          const restoredCounts = await countTables(this.prisma);
          const diffs = diffCounts(inspected.manifest.tableCounts, restoredCounts);
          const restoredSchema = await latestMigration(this.prisma);
          if (diffs.length > 0 || restoredSchema !== inspected.manifest.schemaVersion) {
            throw new BackupIntegrityError('أعداد الصفوف أو إصدار المخطط بعد الاسترداد لا يطابق النسخة');
          }
          done(9, 'فحص البيانات', 'أعداد الصفوف في كل الجداول مطابقة لما سُجِّل وقت النسخ');

          await this.finalizeRestore(id, preserved, actor, meta, safety.record.id);
          done(10, 'إعادة فتح النظام', 'أُلغيت كل الجلسات، سجّل الدخول من جديد');
          return { backupId: id, safetyBackupId: safety.record.id, restoredAt: new Date().toISOString(), steps, tableCounts: restoredCounts };
        } catch (error) {
          // حتى عند انقطاع الأداة بعد تنفيذ COMMIT، نستعيد حالة ما قبل العملية ونتحقق منها.
          try {
            await this.pgTools.restore(this.config.databaseUrl, safety.archive);
            await this.reconnect();
            const counts = await countTables(this.prisma);
            if (diffCounts(safety.manifest.tableCounts, counts).length ||
                await latestMigration(this.prisma) !== safety.manifest.schemaVersion) {
              throw new BackupIntegrityError('تعذر التحقق من نسخة الأمان بعد استردادها');
            }
            await this.finalizeRestore(safety.record.id, preserved, actor, meta, safety.record.id);
          } catch {
            reopen = false;
            throw await this.restoreFailed(id, 'تعذر الرجوع إلى نسخة الأمان. بقي النظام في الصيانة لمراجعة مسؤول التشغيل', actor, meta);
          }
          throw await this.restoreFailed(id, 'تعذر إكمال الاسترداد وأُعيدت البيانات من نسخة الأمان: ' + this.describe(error), actor, meta);
        }
      } finally {
        if (reopen) this.maintenance.exit();
      }
    });
  }

  private async restoreFailed(id: string, message: string, actor: AuthContext | null, meta: RequestMeta | null): Promise<AppException> {
    this.logger.error(message);
    await this.audit
      .log({ action: 'backup.restore_failed', actor, entityType: 'backup', entityId: id, metadata: { reason: message }, meta })
      .catch(() => undefined);
    await this.notifications.notifyAdmin({ type: 'BACKUP_FAILED', title: 'فشل استرداد نسخة احتياطية', body: message.slice(0, 500), data: { backupId: id } });
    return Errors.conflict(message);
  }

  /**
   * تجربة استرداد في قاعدة منفصلة مؤقتة على الخادم نفسه: تُنشأ، تُسترد فيها النسخة، تُفحص أعداد الصفوف، ثم تُحذف.
   * لا تمس القاعدة الأساسية. تتطلب أن يملك مستخدم القاعدة صلاحية CREATE DATABASE.
   */
  async drill(id: string, actor: AuthContext | null, meta: RequestMeta | null = null, scratchName?: string) {
    return this.exclusive(async () => {
      const inspected = await this.inspect(id);
      const current = parseDatabaseUrl(this.config.databaseUrl).database;
      const scratch = scratchName ?? `${current}_restore_drill`.slice(0, 63);
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(scratch) || scratch === current) throw Errors.validation('اسم قاعدة التجربة غير صالح');
      const scratchUrl = withDatabaseName(this.config.databaseUrl, scratch);

      await this.prisma.$executeRawUnsafe(`CREATE DATABASE ${quoteIdent(scratch)}`);
      let diffs: string[];
      let counts: Record<string, number>;
      try {
        await this.pgTools.restore(scratchUrl, inspected.archive);
        const client = new PrismaClient({ datasources: { db: { url: scratchUrl } } });
        try {
          counts = await countTables(client);
          diffs = diffCounts(inspected.manifest.tableCounts, counts);
          if ((await latestMigration(client)) !== inspected.manifest.schemaVersion) diffs.push('إصدار القاعدة لا يطابق المسجل');
        } finally {
          await client.$disconnect();
        }
      } catch (error) {
        if (error instanceof PgToolError) throw Errors.conflict(`فشلت تجربة الاسترداد: ${error.message}`);
        throw error;
      } finally {
        await this.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdent(scratch)} WITH (FORCE)`).catch(() => undefined);
      }

      const ok = diffs.length === 0;
      await this.prisma.$transaction(async (tx) => {
        if (ok) await tx.backupRecord.update({ where: { id }, data: { status: 'VERIFIED', verifiedAt: new Date() } });
        await this.audit.log(
          { action: ok ? 'backup.restore_drill_passed' : 'backup.restore_drill_failed', actor, entityType: 'backup', entityId: id, metadata: { diffs: diffs.slice(0, 10) }, meta },
          tx,
        );
      });
      if (!ok) {
        await this.notifications.notifyAdmin({
          type: 'BACKUP_FAILED',
          title: 'فشلت تجربة الاسترداد',
          body: `النسخة المستردة لا تطابق المسجل: ${diffs.slice(0, 3).join('؛ ')}`.slice(0, 500),
          data: { backupId: id },
        });
      }
      return { ok, tables: Object.keys(counts).length, totalRows: Object.values(counts).reduce((a, b) => a + b, 0), diffs };
    });
  }

  // ───────────────────────────── الاحتفاظ والحذف ─────────────────────────────

  private async discard(record: BackupRecord): Promise<void> {
    if (record.storageKey) {
      await this.storage.delete(record.storageKey);
      await this.storage.delete(record.storageKey + MANIFEST_SUFFIX);
    }
    await this.prisma.backupRecord.update({ where: { id: record.id }, data: { status: 'EXPIRED' } });
  }

  /** يحذف من التخزين النسخ التي انتهت مدة الاحتفاظ بها ويعلّم سجلاتها EXPIRED. */
  async expire(now = new Date()): Promise<{ expired: number; failed: number }> {
    return this.exclusive(() => this.expireInternal(now));
  }

  private async expireInternal(now: Date): Promise<{ expired: number; failed: number }> {
    await this.markStale();
    const due = await this.prisma.backupRecord.findMany({
      where: { status: { in: ['COMPLETED', 'VERIFIED'] }, expiresAt: { lte: now } },
    });
    let expired = 0;
    let failed = 0;
    for (const record of due) {
      try {
        await this.discard(record);
        expired++;
      } catch (error) {
        failed++;
        this.logger.error(`تعذر حذف نسخة منتهية ${record.id}: ${this.describe(error)}`);
      }
    }
    if (expired > 0) await this.audit.log({ action: 'backup.expired', entityType: 'backup', metadata: { expired, failed } });
    return { expired, failed };
  }

  /** حذف نسخة يدوية (البقية تنتهي تلقائيًا وفق السياسة). */
  async remove(id: string, actor: AuthContext, meta: RequestMeta): Promise<void> {
    return this.exclusive(() => this.removeInternal(id, actor, meta));
  }

  private async removeInternal(id: string, actor: AuthContext, meta: RequestMeta): Promise<void> {
    const record = await this.prisma.backupRecord.findUnique({ where: { id } });
    if (!record) throw Errors.notFound('النسخة الاحتياطية غير موجودة');
    if (record.type !== 'MANUAL') throw Errors.conflict('تُحذف النسخ اليدوية فقط؛ البقية تنتهي تلقائيًا وفق سياسة الاحتفاظ');
    if (record.status === 'IN_PROGRESS') throw Errors.conflict('النسخة ما زالت قيد الإنشاء');
    await this.discard(record);
    await this.audit.log({ action: 'backup.deleted', actor, entityType: 'backup', entityId: id, before: { type: record.type, startedAt: record.startedAt }, meta });
  }

  /**
   * يعيد بناء سجلات النسخ من بيانات التخزين الموقَّعة (بعد استرداد كارثي إلى قاعدة جديدة مثلًا).
   * يُقبل فقط بيان توقيعه صحيح بمفتاح هذا النظام؛ ما عداه يُتجاهل ويُحصى.
   */
  async rescan(actor: AuthContext | null, meta: RequestMeta | null = null) {
    return this.exclusive(() => this.rescanInternal(actor, meta));
  }

  private async rescanInternal(actor: AuthContext | null, meta: RequestMeta | null): Promise<{ imported: number; known: number; rejected: number }> {
    const encryptionKey = this.key;
    const prefix = [this.config.backup.prefix, 'backups'].filter(Boolean).join('/') + '/';
    const keys = (await this.storage.list(prefix)).filter((k) => k.endsWith(MANIFEST_SUFFIX));
    let imported = 0;
    let known = 0;
    let rejected = 0;
    for (const key of keys) {
      try {
        const manifest = parseManifest(await this.storage.get(key), encryptionKey);
        if (manifest.storageKey + MANIFEST_SUFFIX !== key || !/^[0-9a-f-]{36}$/i.test(manifest.id)) throw new BackupIntegrityError('البيان لا يطابق موقعه');
        const existing = await this.prisma.backupRecord.findUnique({ where: { id: manifest.id } });
        if (existing && ['COMPLETED', 'VERIFIED', 'EXPIRED'].includes(existing.status)) {
          known++;
          continue;
        }
        const createdAt = new Date(manifest.createdAt);
        const data = {
          type: manifest.type,
          status: 'COMPLETED' as const,
          storageKey: manifest.storageKey,
          sizeBytes: BigInt(manifest.sizeBytes),
          checksumSha256: manifest.checksumSha256,
          schemaVersion: manifest.schemaVersion,
          startedAt: createdAt,
          completedAt: createdAt,
          expiresAt: expiryFor(manifest.type, createdAt),
          errorMessage: null,
        };
        await this.prisma.backupRecord.upsert({ where: { id: manifest.id }, create: { id: manifest.id, ...data }, update: data });
        imported++;
      } catch {
        rejected++;
      }
    }
    await this.audit.log({ action: 'backup.rescanned', actor, entityType: 'backup', metadata: { imported, known, rejected }, meta });
    return { imported, known, rejected };
  }
}

export const TYPE_LABEL: Record<BackupType, string> = {
  DAILY: 'يومية',
  WEEKLY: 'أسبوعية',
  MANUAL: 'يدوية',
  PRE_RESTORE: 'قبل الاسترداد',
};
