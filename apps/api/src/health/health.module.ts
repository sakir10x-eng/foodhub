import { Controller, Get, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformScope, Public } from '../common/decorators';

@Controller()
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @PlatformScope('health check touches no tenant data')
  @Get('health')
  async health() {
    const started = Date.now();
    let db = 'down';
    try {
      await this.prisma.unsafeRaw.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }
    return { status: db === 'up' ? 'ok' : 'degraded', db, latencyMs: Date.now() - started };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
