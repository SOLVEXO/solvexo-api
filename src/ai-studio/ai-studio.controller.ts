/* eslint-disable prettier/prettier */
import {
  Body, Controller, Get, Param, Post, Query, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { actingSellerId } from '../common/acting-seller-id.util';
import { AiStudioService } from './ai-studio.service';
import {
  AcceptGenerationDto, GenerateEmailDto, GenerateImageEnhanceDto, GenerateListingDto,
  GeneratePriceDto, GenerateSeoDto, GenerateWorksheetDto,
} from './dto/generate.dto';

/**
 * AI Studio — SELLER (and now staff, gated) only. Every route is behind
 * JwtAuthGuard + RolesGuard + PermissionsGuard (buyers get 403, not a
 * hidden UI) and every handler re-verifies store ownership in the service.
 * `aistudio.view` covers credits/history (read-only); `aistudio.use`
 * covers the 6 real generation tools + accepting a result — there is no
 * separate "AI Studio settings" route to gate, so no `aistudio.manage` key
 * exists (verified against the real routes below, not guessed).
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
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@Controller('api/ai-studio')
export class AiStudioController {
  constructor(private readonly aiStudio: AiStudioService) {}

  // ---- credits & history ----

  @RequirePermission('aistudio.view', 'aistudio.use')
  @Get(':storeId/credits')
  getCredits(@Req() req: any, @Param('storeId') storeId: string) {
    return this.aiStudio.getCredits(actingSellerId(req.user), storeId);
  }

  @RequirePermission('aistudio.view', 'aistudio.use')
  @Get(':storeId/generations')
  listGenerations(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.aiStudio.listGenerations(actingSellerId(req.user), storeId, query);
  }

  @RequirePermission('aistudio.view', 'aistudio.use')
  @Get(':storeId/generations/:generationId')
  getGeneration(@Req() req: any, @Param('storeId') storeId: string, @Param('generationId') generationId: string) {
    return this.aiStudio.getGeneration(actingSellerId(req.user), storeId, generationId);
  }

  /** "Use This" / "Edit → save" — accept the output, optionally write it to the product. */
  @RequirePermission('aistudio.use')
  @Post(':storeId/generations/:generationId/accept')
  acceptGeneration(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('generationId') generationId: string,
    @Body() dto: AcceptGenerationDto,
  ) {
    return this.aiStudio.acceptGeneration(actingSellerId(req.user), storeId, generationId, dto);
  }

  // ---- the 6 tools ----

  @RequirePermission('aistudio.use')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/listing-writer/generate')
  generateListing(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateListingDto) {
    return this.aiStudio.generateListing(actingSellerId(req.user), storeId, dto);
  }

  @RequirePermission('aistudio.use')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/seo-booster/generate')
  generateSeo(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateSeoDto) {
    return this.aiStudio.generateSeo(actingSellerId(req.user), storeId, dto);
  }

  @RequirePermission('aistudio.use')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/email-campaigns/generate')
  generateEmail(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateEmailDto) {
    return this.aiStudio.generateEmail(actingSellerId(req.user), storeId, dto);
  }

  @RequirePermission('aistudio.use')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/worksheet-builder/generate')
  generateWorksheet(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateWorksheetDto) {
    return this.aiStudio.generateWorksheet(actingSellerId(req.user), storeId, dto);
  }

  @RequirePermission('aistudio.use')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/price-optimizer/generate')
  generatePrice(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GeneratePriceDto) {
    return this.aiStudio.generatePrice(actingSellerId(req.user), storeId, dto);
  }

  /** Async — returns a jobId immediately; poll the jobs route below. */
  @RequirePermission('aistudio.use')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/image-enhancer/generate')
  startImageEnhance(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: GenerateImageEnhanceDto) {
    return this.aiStudio.startImageEnhance(actingSellerId(req.user), storeId, dto);
  }

  @RequirePermission('aistudio.view', 'aistudio.use')
  @Get(':storeId/image-enhancer/jobs/:jobId')
  getImageJob(@Req() req: any, @Param('storeId') storeId: string, @Param('jobId') jobId: string) {
    return this.aiStudio.getImageJob(actingSellerId(req.user), storeId, jobId);
  }
}
