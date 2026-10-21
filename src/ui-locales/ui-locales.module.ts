/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AiStudioModule } from '../ai-studio/ai-studio.module';
import { AdminUiLocalesController, PublicUiLocaleFillController, PublicUiLocalesController } from './ui-locales.controller';
import { UiLocalesService } from './ui-locales.service';

// AuthModule + RedisModule: JwtAuthGuard needs them. AiStudioModule exports the text provider that writes the translations.
@Module({
  imports: [AuthModule, RedisModule, AiStudioModule],
  controllers: [PublicUiLocalesController, PublicUiLocaleFillController, AdminUiLocalesController],
  providers: [UiLocalesService],
})
export class UiLocalesModule {}
