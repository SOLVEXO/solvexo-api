/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AiStudioController } from './ai-studio.controller';
import { AiStudioService } from './ai-studio.service';
import { AiStudioCreditsService } from './ai-studio-credits.service';
import { TextGenerationService } from './providers/text-generation.service';
import { KeywordDataService } from './providers/keyword-data.service';
import { PricingDataService } from './providers/pricing-data.service';
import { ImageEnhanceService } from './providers/image-enhance.service';

/**
 * AI Studio — seller-only AI tools (Listing Writer, SEO Booster, Email
 * Campaigns, Worksheet Builder, Price Optimizer, Image Enhancer stub).
 *
 * Depends on the @Global PlatformPlansModule for AiCreditsService (the wallet
 * is the single balance source; top-ups stay on the existing
 * extra_ai_credits add-on purchase) — no explicit import needed.
 *
 * RedisModule must be imported alongside AuthModule here — JwtAuthGuard
 * injects RedisService, and every other module using JwtAuthGuard in this
 * codebase imports both (AuthModule exports the guard but not its Redis
 * dependency), so this is required, not redundant.
 * See src/ai-studio/README.md for env vars and provider plug-in points.
 */
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AiStudioController],
  providers: [
    AiStudioService,
    AiStudioCreditsService,
    TextGenerationService,
    KeywordDataService,
    PricingDataService,
    ImageEnhanceService,
  ],
})
export class AiStudioModule {}
