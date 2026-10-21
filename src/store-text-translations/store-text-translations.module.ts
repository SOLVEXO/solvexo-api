/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AiStudioModule } from '../ai-studio/ai-studio.module';
import { PublicStoreTextTranslationsController, StoreTextTranslationsController } from './store-text-translations.controller';
import { StoreTextTranslationsService } from './store-text-translations.service';

// AuthModule + RedisModule: JwtAuthGuard needs them. AiStudioModule exports the text provider used by "Translate automatically".
@Module({
  imports: [AuthModule, RedisModule, AiStudioModule],
  controllers: [StoreTextTranslationsController, PublicStoreTextTranslationsController],
  providers: [StoreTextTranslationsService],
})
export class StoreTextTranslationsModule {}
