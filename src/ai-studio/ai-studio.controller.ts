/* eslint-disable prettier/prettier */
import {
  Body, Controller, Get, Param, Post, Query, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { AiStudioService } from './ai-studio.service';
import {
  AcceptGenerationDto, GenerateEmailDto, GenerateImageEnhanceDto, GenerateListingDto,
  GeneratePriceDto, GenerateSeoDto, GenerateWorksheetDto,
} from './dto/generate.dto';

/**
 * AI Studio — SELLER-ONLY. Every route is behind JwtAuthGuard + RolesGuard +
 * @Roles('seller') (buyers get 403, not a hidden UI) and every handler
 * re-verifies store ownership in the service.
 *
 * Generate endpoints:
 *  - are rate-limited per-route (on top of the wallet, which is the real
 *    spend cap) to stop runaway clients from hammering the AI provider;
 *  - accept the optional Idempotency-Key header (same interceptor as other
 *    charge-bearing mutations) so a mobile retry never double-charges credits.
 *
 * Credits top-up intentionally has NO endpoint here — "Buy Credits" is the
 * existing add-on purchase: POST api/platform-plans/:storeId/addons with
 * addonType 'extra_ai_credits' (reuses the platform payment abstraction).
 */
@ApiTags('AI Studio')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureFlagGuard)
@Roles('seller')
@RequireFeature('aiStudio')
@Controller('api/ai-studio')
export class AiStudioController {
  constructor(private readonly aiStudio: AiStudioService) {}

  // ---- credits & history ----

  @Get(':storeId/credits')
  getCredits(@Req() req: any, @Param('storeId') storeId: string) {
    return this.aiStudio.getCredits(req.user.userId, storeId);
  }

  @Get(':storeId/generations')
  listGenerations(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.aiStudio.listGenerations(req.user.userId, storeId, query);
  }

  @Get(':storeId/generations/:generationId')
  getGeneration(@Req() req: any, @Param('storeId') storeId: string, @Param('generationId') generationId: string) {
    return this.aiStudio.getGeneration(req.user.userId, storeId, generationId);
  }

  /** "Use This" / "Edit → save" — accept the output, optionally write it to the product. */
  @Post(':storeId/generations/:generationId/accept')
  acceptGeneration(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('generationId') generationId: string,
    @Body() dto: AcceptGenerationDto,
  ) {
    return this.aiStudio.acceptGeneration(req.user.userId, storeId, generationId, dto);
  }

  // ---- the 6 tools ----

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/listing-writer/generate')
  generateListing(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateListingDto) {
    return this.aiStudio.generateListing(req.user.userId, storeId, dto);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/seo-booster/generate')
  generateSeo(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateSeoDto) {
    return this.aiStudio.generateSeo(req.user.userId, storeId, dto);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/email-campaigns/generate')
  generateEmail(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateEmailDto) {
    return this.aiStudio.generateEmail(req.user.userId, storeId, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/worksheet-builder/generate')
  generateWorksheet(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateWorksheetDto) {
    return this.aiStudio.generateWorksheet(req.user.userId, storeId, dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/price-optimizer/generate')
  generatePrice(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GeneratePriceDto) {
    return this.aiStudio.generatePrice(req.user.userId, storeId, dto);
  }

  /** Async — returns a jobId immediately; poll the jobs route below. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/image-enhancer/generate')
  startImageEnhance(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateImageEnhanceDto) {
    return this.aiStudio.startImageEnhance(req.user.userId, storeId, dto);
  }

  @Get(':storeId/image-enhancer/jobs/:jobId')
  getImageJob(@Req() req: any, @Param('storeId') storeId: string, @Param('jobId') jobId: string) {
    return this.aiStudio.getImageJob(req.user.userId, storeId, jobId);
  }
}
