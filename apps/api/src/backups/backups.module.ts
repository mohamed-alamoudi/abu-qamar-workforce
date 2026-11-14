import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { AdminOnly, Auth, Meta, RequireReauth } from '../common/auth/decorators';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { APP_CONFIG, AppConfig } from '../common/config/env';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { BackupsService } from './backups.service';
import { BACKUP_STORAGE } from './storage/backup-storage';
import { LocalBackupStorage } from './storage/local-storage';
import { S3BackupStorage } from './storage/s3-storage';

@ApiTags('backups')
@ApiCookieAuth()
@AdminOnly()
@Controller('backups')
class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get()
  list() {
    return this.backups.list();
  }

  @Post()
  create(@Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.backups.create('MANUAL', auth, meta);
  }

  @Post('reset-workers')
  @HttpCode(200)
  @RequireReauth()
  resetWorkers(@Body('confirmation') confirmation: unknown, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.backups.resetWorkers(confirmation, auth, meta);
  }

  @Get(':id/preview')
  preview(@Param('id', ParseUUIDPipe) id: string) {
    return this.backups.preview(id);
  }

  @Post(':id/verify')
  @HttpCode(200)
  verify(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.backups.verify(id, auth, meta);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequireReauth()
  restore(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.backups.restore(id, auth, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireReauth()
  remove(@Param('id', ParseUUIDPipe) id: string, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.backups.remove(id, auth, meta);
  }
}

@Module({
  imports: [NotificationsModule, SettingsModule],
  controllers: [BackupsController],
  providers: [
    BackupsService,
    {
      provide: BACKUP_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.backup.driver === 'local') return new LocalBackupStorage(config.backup.localDir);
        if (!config.backup.s3) throw new Error('إعدادات تخزين النسخ الاحتياطية ناقصة');
        return new S3BackupStorage(config.backup.s3);
      },
    },
  ],
  exports: [BackupsService],
})
export class BackupsModule {}
