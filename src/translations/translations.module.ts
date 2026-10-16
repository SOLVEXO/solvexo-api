import { Module } from '@nestjs/common';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { DatabaseModule } from '@/database/database.module';
import { TranslationsController } from './translations.controller';
import { TranslationsService } from './translations.service';

// AuthModule + RedisModule: the controller's JwtAuthGuard needs RedisService (same fix MarketsModule needed).
@Module({
  imports: [AuthModule, RedisModule, DatabaseModule],
  controllers: [TranslationsController],
  providers: [TranslationsService],
  exports: [TranslationsService],
})
export class TranslationsModule {}
