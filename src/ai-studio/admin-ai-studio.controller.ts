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
import { AdminAiStudioService } from './admin-ai-studio.service';
import { AdminGenerateSeoDto, AdminGenerateEmailDto, AdminGenerateImageEnhanceDto, AdjustWalletDto } from './dto/admin-generate.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
/**
 * Admin AI Studio — two halves, both @Roles('admin') only:
 *
 *  - Oversight (read-only): cross-store visibility into every seller's AI
 *    Studio usage — generations, credit transactions, wallet balances.
 *  - Platform generation: SEO Booster / Email Campaigns / Image Enhancer run
 *    for Solvexo's OWN marketplace content, never charged against a seller's
 *    wallet. Listing Writer / Worksheet Builder / Price Optimizer are
 *    seller-product-specific and intentionally excluded here.
 */
@ApiTags('Admin AI Studio')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@Controller('api/admin/ai-studio')
export class AdminAiStudioController {
  constructor(private readonly adminAiStudio: AdminAiStudioService) {}

  // ---- oversight ----

  @RequirePermission('ai.manage')
  @Get('overview')
  getOverview(@Query('days') days?: string) {
    return this.adminAiStudio.getOverview(Number(days) || 28);
  }

  @RequirePermission('ai.manage')
  @Get('generations')
  listGenerations(@Query() query: any) {
    return this.adminAiStudio.listGenerations(query);
  }

  @RequirePermission('ai.manage')
  @Get('generations/:generationId')
  getGeneration(@Param('generationId') generationId: string) {
    return this.adminAiStudio.getGeneration(generationId);
  }

  @RequirePermission('ai.manage')
  @Get('wallets')
  listWallets(@Query() query: any) {
    return this.adminAiStudio.listWallets(query);
  }

  @RequirePermission('ai.manage')
  @Get('wallets/:storeId/ledger')
  getWalletLedger(@Param('storeId') storeId: string) {
    return this.adminAiStudio.getWalletLedger(storeId);
  }

  @RequirePermission('ai.manage')
  @Post('wallets/:storeId/adjust')
  adjustWallet(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AdjustWalletDto) {
    return this.adminAiStudio.adjustWallet(storeId, dto, { id: req.user.userId, name: req.user.name, role: req.user.role });
  }

  @RequirePermission('ai.manage')
  @Get('transactions')
  listTransactions(@Query() query: any) {
    return this.adminAiStudio.listTransactions(query);
  }

  // ---- platform generation (Solvexo's own content) ----

  @RequirePermission('ai.manage')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post('platform/seo-booster/generate')
  generatePlatformSeo(@Req() req: any, @Body() dto: AdminGenerateSeoDto) {
    return this.adminAiStudio.generatePlatformSeo(req.user.userId, dto);
  }

  @RequirePermission('ai.manage')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post('platform/email-campaigns/generate')
  generatePlatformEmail(@Req() req: any, @Body() dto: AdminGenerateEmailDto) {
    return this.adminAiStudio.generatePlatformEmail(req.user.userId, dto);
  }

  @RequirePermission('ai.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @Post('platform/image-enhancer/generate')
  startPlatformImageEnhance(@Req() req: any, @Body() dto: AdminGenerateImageEnhanceDto) {
    return this.adminAiStudio.startPlatformImageEnhance(req.user.userId, dto);
  }

  @RequirePermission('ai.manage')
  @Get('platform/image-enhancer/jobs/:jobId')
  getPlatformImageJob(@Param('jobId') jobId: string) {
    return this.adminAiStudio.getPlatformImageJob(jobId);
  }
}
