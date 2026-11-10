import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/auth/decorators';
import { PrismaService } from '../common/prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  @SkipThrottle()
  @ApiOperation({ summary: 'فحص صحة الخادم وقاعدة البيانات (لـ Render Health Check)' })
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException();
    }
    return { status: 'ok', database: 'up', uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }
}
