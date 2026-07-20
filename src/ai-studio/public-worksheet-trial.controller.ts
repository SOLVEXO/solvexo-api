/* eslint-disable prettier/prettier */
import { Body, Controller, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { AiStudioService } from './ai-studio.service';
import { GenerateWorksheetTrialDto } from './dto/generate.dto';

/**
 * Public, unauthenticated "Try AI Worksheet Builder for free" — the buyer-
 * facing marketing hook on the Education marketplace page. Deliberately a
 * separate controller from `AiStudioController` (seller-only, credit-metered,
 * store-scoped): this route has no storeId, no wallet, and a hard per-IP
 * rate limit instead, since it's reachable by anyone with no auth.
 */
@ApiTags('AI Studio (Public Trial)')
@UseGuards(FeatureFlagGuard)
@RequireFeature('aiStudio')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/public/worksheet-builder')
export class PublicWorksheetTrialController {
  constructor(private readonly aiStudio: AiStudioService) {}

  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('try-free')
  generateTrial(@Body() dto: GenerateWorksheetTrialDto) {
    return this.aiStudio.generateWorksheetTrial(dto);
  }
}
