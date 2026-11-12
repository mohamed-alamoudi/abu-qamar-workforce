import { randomBytes, randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BackupsService } from '../../apps/api/src/backups/backups.service';
import { BACKUP_STORAGE, BackupStorage } from '../../apps/api/src/backups/storage/backup-storage';
import { MaintenanceService } from '../../apps/api/src/maintenance/maintenance.module';
import { ADMIN, createSupervisor, createTestApp, resetDatabase, setupAdmin, TestContext } from './helpers';

describe('النسخ الاحتياطي والاسترداد', () => {
  let ctx: TestContext;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aq-backups-'));
    process.env.BACKUP_LOCAL_DIR = directory;
    process.env.BACKUP_STORAGE_DRIVER = 'local';
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    process.env.PG_DUMP_COMMAND = process.env.TEST_PG_DUMP_COMMAND ?? 'pg_dump';
    process.env.PG_RESTORE_COMMAND = process.env.TEST_PG_RESTORE_COMMAND ?? 'pg_restore';
    if (process.env.TEST_PG_TOOLS_HOST) process.env.PG_TOOLS_HOST = process.env.TEST_PG_TOOLS_HOST;
    if (process.env.TEST_PG_TOOLS_PORT) process.env.PG_TOOLS_PORT = process.env.TEST_PG_TOOLS_PORT;
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('restores into a scratch database, verifies counts and rejects corrupted ciphertext', async () => {
    const admin = await setupAdmin(ctx);
    const supervisor = await createSupervisor(ctx, admin);
    await supervisor.client.get('/backups').expect(403);
    const response = await admin.post('/backups').expect(201);
    const id: string = response.body.id;
    const preview = await admin.get('/backups/' + id + '/preview').expect(200);
    expect(preview.body.tables).toContainEqual({ name: 'users', inBackup: 2, current: 2 });
    await admin.post('/backups/' + id + '/verify').expect(200);
    await ctx.prisma.session.updateMany({ data: { reauthAt: null } });
    const denied = await admin.post('/backups/' + id + '/restore').expect(403);
    expect(denied.body.code).toBe('REAUTH_REQUIRED');

    const maintenance = ctx.app.get(MaintenanceService);
    maintenance.enter('restore');
    try {
      await admin.post('/backups').expect(503);
      await admin.post('/sync/attendance').expect(503);
    } finally {
      maintenance.exit();
    }

    const service = ctx.app.get(BackupsService);
    const scratch = 'aq_backup_restore_' + randomUUID().replaceAll('-', '');
    const drill = await service.drill(id, null, null, scratch);
    expect(drill).toMatchObject({ ok: true, diffs: [] });
    expect(drill.tables).toBeGreaterThan(30);
    expect(await ctx.prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${scratch}) AS present`)
      .toEqual([{ present: false }]);
    const storage = ctx.app.get<BackupStorage>(BACKUP_STORAGE);
    const record = await ctx.prisma.backupRecord.findUniqueOrThrow({ where: { id } });
    const key = record.storageKey!;
    const contents = await storage.get(key);
    contents[contents.length - 1] ^= 1;
    await storage.put(key, contents);
    await admin.get('/backups/' + id + '/preview').expect(422);
    await admin.post('/auth/reauth', { password: ADMIN.password }).expect(200);
    await admin.post('/backups/' + id + '/restore').expect(422);
    expect(await ctx.prisma.backupRecord.count({ where: { type: 'PRE_RESTORE' } })).toBe(0);
  });
});
