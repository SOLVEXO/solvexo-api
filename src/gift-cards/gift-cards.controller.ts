/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { GiftCardsService } from './gift-cards.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { UpdateGiftCardSettingsDto } from './dto/update-gift-card-settings.dto';
import { IssueManualGiftCardDto } from './dto/issue-manual-gift-card.dto';
import { CreatePurchaseIntentDto } from './dto/create-purchase-intent.dto';
import { resolveBuyerStoreScope } from '../common/store-scope.util';

@ApiTags('Gift Cards')
@Controller('api/gift-cards')
export class GiftCardsController {
  constructor(private readonly giftCardsService: GiftCardsService) {}

  /** The gift card page opened from the link in the gift card email (no login; the signed token is the key).
   *  Declared first so `view/:token` is never read as `:storeId/<something>`. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('view/:token')
  getPublicView(@Param('token') token: string) {
    return this.giftCardsService.getPublicView(token);
  }

  // ── Seller-facing ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('giftcards.view', 'giftcards.manage')
  @Get(':storeId/settings')
  getSettings(@Req() req: any, @Param('storeId') storeId: string) {
    return this.giftCardsService.getSettings(actingSellerId(req.user), storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('giftcards.manage')
  @Patch(':storeId/settings')
  updateSettings(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateGiftCardSettingsDto) {
    return this.giftCardsService.updateSettings(actingSellerId(req.user), storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('giftcards.manage')
  @Post(':storeId/issue')
  issueManual(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: IssueManualGiftCardDto) {
    return this.giftCardsService.issueManual(actingSellerId(req.user), storeId, dto);
  }

  // Real "Edit existing card value" — see GiftCardsService.adjustBalance's
  // own doc comment. Closes the Tier-2 audit's disclosed "Create/edit" gap
  // (issuance was already real, editing an existing card wasn't).
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('giftcards.manage')
  @Patch(':storeId/:giftCardId/adjust')
  adjustBalance(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('giftCardId') giftCardId: string,
    @Body() body: { delta: number; reason?: string; notify?: boolean },
  ) {
    return this.giftCardsService.adjustBalance(actingSellerId(req.user), storeId, giftCardId, body.delta, body.reason ?? '', body.notify === true);
  }

  /** Re-sends the gift card email with the card's current balance. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('giftcards.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':storeId/:giftCardId/resend')
  resendEmail(@Req() req: any, @Param('storeId') storeId: string, @Param('giftCardId') giftCardId: string) {
    return this.giftCardsService.resendGiftCardEmail(actingSellerId(req.user), storeId, giftCardId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('giftcards.view')
  @Get(':storeId')
  listGiftCards(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.giftCardsService.listGiftCards(actingSellerId(req.user), storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('giftcards.deactivate')
  @Patch(':storeId/:giftCardId/disable')
  disableGiftCard(@Req() req: any, @Param('storeId') storeId: string, @Param('giftCardId') giftCardId: string, @Body() body?: { notify?: boolean }) {
    return this.giftCardsService.disableGiftCard(actingSellerId(req.user), storeId, giftCardId, body?.notify === true);
  }

  /** The issue/redeem/refund ledger for one gift card — previously written
   *  on every balance change but never readable from anywhere. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('giftcards.view')
  @Get(':storeId/:giftCardId/transactions')
  listTransactions(@Req() req: any, @Param('storeId') storeId: string, @Param('giftCardId') giftCardId: string, @Query() query: any) {
    return this.giftCardsService.listTransactions(actingSellerId(req.user), storeId, giftCardId, query);
  }

  // ── Buyer-facing ──────────────────────────────────────────────────────────

  @Get(':storeId/public-settings')
  getPublicSettings(@Param('storeId') storeId: string) {
    return this.giftCardsService.getPublicSettings(storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':storeId/purchase-intent')
  createPurchaseIntent(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePurchaseIntentDto) {
    const scopedStoreId = resolveBuyerStoreScope(req.user.storeId, storeId);
    return this.giftCardsService.createPurchaseIntent(req.user.userId, scopedStoreId, dto);
  }
}
