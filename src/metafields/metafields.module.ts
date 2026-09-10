/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { MetafieldsController } from './metafields.controller';
import { PublicMetafieldsController } from './public-metafields.controller';
import { MetafieldsService } from './metafields.service';

// `RedisModule` alongside `AuthModule` is required by every module whose
// controller uses `JwtAuthGuard` — the guard injects `RedisService` for its
// session-revocation check, and that only resolves if this module's own DI
// graph includes it (not implied by importing `AuthModule` alone). Same
// pattern `StoreThemeModule`/`CollectionTemplateModule` already follow.
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [MetafieldsController, PublicMetafieldsController],
  providers: [MetafieldsService],
  exports: [MetafieldsService],
})
export class MetafieldsModule {}
