/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';

/**
 * Phase 8 — App Blocks. Exports `AppsService` so `StorePagesModule` and
 * `CollectionTemplateModule` can inject it to enforce app-block
 * installation/section/settings rules right alongside their own existing
 * first-party section validation — see each service's `updateSections`.
 */
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AppsController],
  providers: [AppsService],
  exports: [AppsService],
})
export class AppsModule {}
