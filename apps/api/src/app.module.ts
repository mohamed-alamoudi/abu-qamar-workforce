import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BackupsModule } from './backups/backups.module';
import { SecurityGuard } from './common/auth/security.guard';
import { ConfigModule } from './common/config/config.module';
import { getConfig } from './common/config/env';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { ErrorMonitor } from './common/errors/error-monitor';
import { PrismaModule } from './common/prisma/prisma.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DepartmentsModule } from './departments/departments.module';
import { EmployeesModule } from './employees/employees.module';
import { HealthController } from './health/health.controller';
import { MaintenanceGuard, MaintenanceModule, MaintenanceRequestInterceptor } from './maintenance/maintenance.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PermissionsModule } from './permissions/permissions.module';
import { SettingsModule } from './settings/settings.module';
import { AttendanceSyncModule } from './sync/attendance-sync.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ThrottlerModule.forRootAsync({
      useFactory: () => [{ ttl: 60_000, limit: getConfig().rateLimitPerMinute }],
    }),
    AuditModule,
    NotificationsModule,
    AuthModule,
    PermissionsModule,
    UsersModule,
    SettingsModule,
    DashboardModule,
    DepartmentsModule,
    EmployeesModule,
    MaintenanceModule,
    BackupsModule,
    AttendanceSyncModule,
  ],
  controllers: [HealthController],
  providers: [
    ErrorMonitor,
    { provide: APP_INTERCEPTOR, useExisting: MaintenanceRequestInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // الترتيب مهم: تحديد المعدل أولًا ثم الحارس الأمني
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: MaintenanceGuard },
    { provide: APP_GUARD, useClass: SecurityGuard },
  ],
})
export class AppModule {}
