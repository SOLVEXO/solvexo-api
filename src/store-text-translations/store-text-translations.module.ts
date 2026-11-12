/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AiTextModule } from '../ai/ai-text.module';
import { PublicStoreTextTranslationsController, StoreTextTranslationsController } from './store-text-translations.controller';
import { StoreTextTranslationsService } from './store-text-translations.service';

// AuthModule + RedisModule: JwtAuthGuard needs them. AiTextModule exports the text provider used by "Translate automatically".
@Module({
  imports: [AuthModule, RedisModule, AiTextModule],
  controllers: [StoreTextTranslationsController, PublicStoreTextTranslationsController],
  providers: [StoreTextTranslationsService],
})
export class StoreTextTranslationsModule {}
