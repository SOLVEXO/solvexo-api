import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { StoreFaqController } from './store-faq.controller';
import { PublicStoreFaqController } from './public-store-faq.controller';
import { StoreFaqService } from './store-faq.service';

// `RedisModule` alongside `AuthModule` is required by every module whose
// controller uses `JwtAuthGuard` — the guard injects `RedisService` for its
// session-revocation check, and that only resolves if this module's own DI
// graph includes it (not implied by importing `AuthModule` alone). Same
// pattern `StoreThemeModule`/`CollectionTemplateModule`/`MetafieldsModule` already follow.
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [StoreFaqController, PublicStoreFaqController],
  providers: [StoreFaqService],
  exports: [StoreFaqService],
})
export class StoreFaqModule {}
