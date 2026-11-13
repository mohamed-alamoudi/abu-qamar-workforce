import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { AuthContext } from '../common/auth/auth.types';
import { AnyAuthenticated, Auth } from '../common/auth/decorators';
import { paginate, PaginationQueryDto, toSkipTake } from '../common/dto/pagination.dto';
import { Errors } from '../common/errors/app-exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { isPushEndpoint, PushService } from './push.service';

class PushSubscriptionDto {
  @IsString()
  @MaxLength(2048)
  endpoint!: string;

  @Matches(/^[\w-]{87}$/)
  p256dh!: string;

  @Matches(/^[\w-]{22}$/)
  auth!: string;
}

export class NotificationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unreadOnly?: boolean;
}

@ApiTags('notifications')
@ApiCookieAuth()
@Controller('notifications')
@AnyAuthenticated()
export class NotificationsController {
  constructor(private readonly prisma: PrismaService, private readonly push: PushService) {}

  @Get('push')
  async pushConfig(@Auth() auth: AuthContext) {
    const publicKey = this.push.publicKey;
    const subscribed = publicKey ? await this.prisma.pushSubscription.count({ where: { sessionId: auth.session.id } }) > 0 : false;
    return { publicKey, subscribed };
  }

  @Post('push')
  async subscribe(@Auth() auth: AuthContext, @Body() dto: PushSubscriptionDto) {
    if (!this.push.publicKey || !isPushEndpoint(dto.endpoint)) throw Errors.validation('اشتراك إشعارات الهاتف غير صالح');
    const data = { ...dto, sessionId: auth.session.id };
    await this.prisma.pushSubscription.upsert({ where: { endpoint: dto.endpoint }, create: data, update: data });
    return { ok: true };
  }

  @Delete('push')
  async unsubscribe(@Auth() auth: AuthContext) {
    await this.prisma.pushSubscription.deleteMany({ where: { sessionId: auth.session.id } });
    return { ok: true };
  }

  @Delete()
  async removeAll(@Auth() auth: AuthContext) {
    const result = await this.prisma.notification.deleteMany({ where: { userId: auth.user.id } });
    return { deleted: result.count };
  }

  @Delete(':id')
  async remove(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const result = await this.prisma.notification.deleteMany({ where: { id, userId: auth.user.id } });
    if (!result.count) throw Errors.notFound('الإشعار غير موجود');
    return { ok: true };
  }

  @Get()
  @ApiOperation({ summary: 'إشعارات المستخدم الحالي مع عدد غير المقروء' })
  async list(@Auth() auth: AuthContext, @Query() query: NotificationsQueryDto) {
    const where = { userId: auth.user.id, ...(query.unreadOnly ? { readAt: null } : {}) };
    const [items, total, unreadCount] = await this.prisma.$transaction([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: auth.user.id, readAt: null } }),
    ]);
    return { ...paginate(items, total, query), unreadCount };
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'تعليم كل الإشعارات كمقروءة' })
  async readAll(@Auth() auth: AuthContext) {
    const result = await this.prisma.notification.updateMany({
      where: { userId: auth.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'تعليم إشعار كمقروء' })
  async read(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId: auth.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const exists = await this.prisma.notification.count({ where: { id, userId: auth.user.id } });
      if (!exists) throw Errors.notFound('الإشعار غير موجود');
    }
    return { ok: true };
  }
}
