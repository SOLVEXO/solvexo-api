/* eslint-disable prettier/prettier */
import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthCheckService, HealthCheck, MongooseHealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { RedisService } from '@/redis/redis.service';

/**
 * Liveness/readiness endpoints for load balancers and orchestrators
 * (Kubernetes readinessProbe/livenessProbe, ECS health checks, etc.). Split
 * into two so a slow-but-recovering dependency doesn't cause an
 * orchestrator to kill and restart a perfectly healthy process.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
    private readonly redisService: RedisService,
  ) {}

  /** Liveness — is the process itself up and able to respond at all. */
  @Get('live')
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** Readiness — are this instance's real dependencies (DB, cache) actually usable. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb', { timeout: 2000 }),
      (): HealthIndicatorResult => ({
        redis: { status: this.redisService.isConnected ? 'up' : 'down' },
      }),
    ]);
  }
}
