import { Controller, Get, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { syncReferenceData } from '@abu-qamar/database';
import { ADMIN_ONLY_ACTIONS, PERMISSION_CATEGORIES, PERMISSIONS } from '@abu-qamar/shared';
import { AdminOnly } from '../common/auth/decorators';
import { PrismaService } from '../common/prisma/prisma.service';

/** عند الإقلاع: مزامنة كتالوج الصلاحيات والإعدادات الافتراضية مع قاعدة البيانات. */
@Injectable()
export class ReferenceDataSync implements OnModuleInit {
  private readonly logger = new Logger(ReferenceDataSync.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await syncReferenceData(this.prisma);
    this.logger.log(`تمت مزامنة ${PERMISSIONS.length} صلاحية والإعدادات الافتراضية`);
  }
}

@ApiTags('permissions')
@ApiCookieAuth()
@Controller('permissions')
@AdminOnly()
export class PermissionsController {
  @Get()
  @ApiOperation({ summary: 'كتالوج الصلاحيات القابلة للمنح للمراقبين، والعمليات المحصورة بالأدمن' })
  catalog() {
    return { categories: PERMISSION_CATEGORIES, permissions: PERMISSIONS, adminOnlyActions: ADMIN_ONLY_ACTIONS };
  }
}

@Module({
  controllers: [PermissionsController],
  providers: [ReferenceDataSync],
})
export class PermissionsModule {}
