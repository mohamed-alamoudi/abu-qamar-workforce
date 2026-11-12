import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BackupsModule } from '../backups/backups.module';
import { ConfigModule } from '../common/config/config.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { BackupsService } from '../backups/backups.service';

@Module({ imports: [ConfigModule, PrismaModule, AuditModule, MaintenanceModule, BackupsModule] })
class BackupCliModule {}

async function main() {
  const [command = 'scheduled', id] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(BackupCliModule, { logger: ['warn', 'error'] });
  try {
    const backups = app.get(BackupsService);
    if (command === 'scheduled') {
      const result = await backups.runScheduled();
      console.log(JSON.stringify(result));
      if (result.expired.failed) process.exitCode = 1;
    } else if (command === 'expire') {
      const result = await backups.expire();
      console.log(JSON.stringify(result));
      if (result.failed) process.exitCode = 1;
    } else if (command === 'drill' && id) {
      const result = await backups.drill(id, null);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'rescan') {
      console.log(JSON.stringify(await backups.rescan(null)));
    } else {
      throw new Error('الأوامر المتاحة: scheduled | expire | drill <id> | rescan');
    }
  } finally {
    await app.close();
  }
}

void main().catch(() => {
  console.error('تعذّر إكمال مهمة النسخ الاحتياطي. راجع سجل الخادم.');
  process.exitCode = 1;
});
