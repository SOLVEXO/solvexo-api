import { Module } from '@nestjs/common';
import { ExchangeRateService } from './exchange-rate.service';
import { ExchangeRateController, AdminFxController } from './exchange-rate.controller';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

// `RedisModule` alongside `AuthModule` is required by every module whose
// controller uses `JwtAuthGuard` — the guard injects `RedisService` for its
// session-revocation check, and that only resolves if this module's own DI
// graph includes it (not implied by importing `AuthModule` alone). Same
// pattern `StoreThemeModule`/`CollectionTemplateModule`/`MetafieldsModule` already follow.
@Module({
  // ActivityLogModule is @Global() (see its own module file) so it doesn't
  // need to be re-imported here for ActivityLogService to be injectable.
  imports: [AdminConfigModule, AuthModule, RedisModule],
  controllers: [ExchangeRateController, AdminFxController],
  providers: [ExchangeRateService],
  exports: [ExchangeRateService],
})
export class ExchangeRateModule {}
