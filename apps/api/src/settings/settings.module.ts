import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IANAZone } from 'luxon';
import { Prisma } from '@abu-qamar/database';
import { DEFAULT_SETTINGS, SettingKey, SettingsMap } from '@abu-qamar/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../common/auth/auth.types';
import { AdminOnly, AnyAuthenticated, Auth, Meta, RequireReauth } from '../common/auth/decorators';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';

export class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  organizationName?: string;

  /** رمز العملة ISO-4217 */
  @IsOptional()
  @IsIn(['ILS', 'USD', 'JOD', 'EGP', 'EUR'])
  currency?: string;

  /** منطقة زمنية IANA مثل Asia/Gaza */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  /** أول أيام الأسبوع: 0 = الأحد … 6 = السبت */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  weekStartsOn?: number;

  /** معامل العمل الإضافي الافتراضي */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(1)
  @Max(5)
  defaultOvertimeMultiplier?: number;
}

const DTO_TO_KEY: Record<keyof UpdateSettingsDto, SettingKey> = {
  organizationName: 'general.organizationName',
  currency: 'general.currency',
  timezone: 'general.timezone',
  weekStartsOn: 'general.weekStartsOn',
  defaultOvertimeMultiplier: 'payroll.defaultOvertimeMultiplier',
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** الإعدادات الحالية (المحفوظة فوق الافتراضية). */
  async getAll(db: Pick<PrismaService, 'systemSetting'> = this.prisma): Promise<SettingsMap> {
    const rows = await db.systemSetting.findMany();
    const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (row.key in DEFAULT_SETTINGS && typeof row.value === typeof result[row.key]) result[row.key] = row.value;
    }
    return result as SettingsMap;
  }

  async update(dto: UpdateSettingsDto, actor: AuthContext, meta: RequestMeta): Promise<SettingsMap> {
    if (dto.timezone !== undefined && !IANAZone.isValidZone(dto.timezone)) {
      throw Errors.validation('المنطقة الزمنية غير صالحة');
    }
    const changes = (Object.keys(DTO_TO_KEY) as (keyof UpdateSettingsDto)[])
      .filter((field) => dto[field] !== undefined)
      .map((field) => ({ key: DTO_TO_KEY[field], value: dto[field] as string | number }));
    if (changes.length === 0) return this.getAll();

    const before = await this.getAll();
    await this.prisma.$transaction(async (tx) => {
      for (const { key, value } of changes) {
        const json = value as Prisma.InputJsonValue;
        await tx.systemSetting.upsert({
          where: { key },
          create: { key, value: json, updatedById: actor.user.id },
          update: { value: json, updatedById: actor.user.id },
        });
      }
      await this.audit.log(
        {
          action: 'settings.updated',
          actor,
          entityType: 'system_settings',
          before: Object.fromEntries(changes.map((c) => [c.key, before[c.key]])),
          after: Object.fromEntries(changes.map((c) => [c.key, c.value])),
          meta,
        },
        tx,
      );
    });
    return this.getAll();
  }
}

@ApiTags('settings')
@ApiCookieAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'الإعدادات العامة (العملة، المنطقة الزمنية، بداية الأسبوع...)' })
  get() {
    return this.settings.getAll();
  }

  @Patch()
  @AdminOnly()
  @RequireReauth()
  @ApiOperation({ summary: 'تعديل الإعدادات (للأدمن، مع إعادة إدخال كلمة المرور)' })
  update(@Body() dto: UpdateSettingsDto, @Auth() auth: AuthContext, @Meta() meta: RequestMeta) {
    return this.settings.update(dto, auth, meta);
  }
}

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
