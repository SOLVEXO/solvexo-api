import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { RedisModule } from '../redis/redis.module';
import { PlatformHealthService } from './platform-health.service';

// QueueModule is @Global() (see its own header comment) — every
// @InjectQueue(QUEUE_NAMES.X) token PlatformHealthService needs is already
// available without importing it here, same as DatabaseModule (also
// @Global()) for DatabaseService. TerminusModule and RedisModule are NOT
// global — see health.module.ts, which imports the exact same pair for the
// exact same reason (HealthCheckService/MongooseHealthIndicator, RedisService).
@Module({
  imports: [TerminusModule, RedisModule],
  providers: [PlatformHealthService],
  exports: [PlatformHealthService],
})
export class PlatformHealthModule {}
