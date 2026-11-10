import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Prisma } from '@abu-qamar/database';
import { AdminOnly } from '../common/auth/decorators';
import { paginate, PaginationQueryDto, toSkipTake } from '../common/dto/pagination.dto';
import { PrismaService } from '../common/prisma/prisma.service';

export class AuditQueryDto extends PaginationQueryDto {
  /** بادئة اسم الحدث، مثل: auth. أو user.permissions_changed */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

@ApiTags('audit')
@ApiCookieAuth()
@Controller('audit-logs')
@AdminOnly()
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'سجل التدقيق (للأدمن فقط) مع الترقيم والتصفية' })
  async list(@Query() query: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...toSkipTake(query) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(items, total, query);
  }
}
