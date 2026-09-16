/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Put, Delete, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { LoyaltyService } from './loyalty.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { UpdateProgramDto } from './dto/update-program.dto';
import { UpdateEarningRulesDto } from './dto/update-earning-rules.dto';
import { UpdateTiersDto } from './dto/update-tiers.dto';
import { CreateRewardDto } from './dto/create-reward.dto';
import { UpdateRewardDto } from './dto/update-reward.dto';
import { AwardPointsDto } from './dto/award-points.dto';
import { RedeemRewardDto } from './dto/redeem-reward.dto';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { actingSellerId } from '../common/acting-seller-id.util';

@ApiTags('Loyalty & Rewards')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('api/loyalty')
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  // ── SELLER: PROGRAM ────────────────────────────────────────────────────────

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.view', 'loyalty.manage', 'loyalty.points.award')
  @Get(':storeId/overview')
  getOverview(@Req() req: any, @Param('storeId') storeId: string) {
    return this.loyaltyService.getOverview(actingSellerId(req.user), storeId);
  }

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.view', 'loyalty.manage', 'loyalty.points.award')
  @Get(':storeId/program')
  getProgram(@Req() req: any, @Param('storeId') storeId: string) {
    return this.loyaltyService.getProgram(actingSellerId(req.user), storeId);
  }

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.manage')
  @Patch(':storeId/program')
  updateProgram(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateProgramDto) {
    return this.loyaltyService.updateProgram(actingSellerId(req.user), storeId, dto);
  }

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.manage')
  @Patch(':storeId/earning-rules')
  updateEarningRules(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateEarningRulesDto) {
    return this.loyaltyService.updateEarningRules(actingSellerId(req.user), storeId, dto);
  }

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.manage')
  @Put(':storeId/tiers')
  updateTiers(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateTiersDto) {
    return this.loyaltyService.updateTiers(actingSellerId(req.user), storeId, dto);
  }

  // ── SELLER: MEMBERS ────────────────────────────────────────────────────────

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.view', 'loyalty.manage', 'loyalty.points.award')
  @Get(':storeId/members')
  getMembers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.loyaltyService.getMembers(actingSellerId(req.user), storeId, query);
  }

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.view', 'loyalty.manage', 'loyalty.points.award')
  @Get(':storeId/members/:memberId/transactions')
  getMemberTransactions(@Req() req: any, @Param('storeId') storeId: string, @Param('memberId') memberId: string, @Query() query: any) {
    return this.loyaltyService.getMemberTransactions(actingSellerId(req.user), storeId, memberId, query);
  }

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.points.award')
  @Post(':storeId/members/:memberId/award')
  awardPoints(@Req() req: any, @Param('storeId') storeId: string, @Param('memberId') memberId: string, @Body() dto: AwardPointsDto) {
    return this.loyaltyService.manualAward(actingSellerId(req.user), storeId, memberId, dto);
  }

  // ── SELLER: REWARDS CATALOG ────────────────────────────────────────────────

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.manage')
  @Post(':storeId/rewards')
  createReward(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateRewardDto) {
    return this.loyaltyService.createReward(actingSellerId(req.user), storeId, dto);
  }

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.manage')
  @Patch(':storeId/rewards/:rewardId')
  updateReward(@Req() req: any, @Param('storeId') storeId: string, @Param('rewardId') rewardId: string, @Body() dto: UpdateRewardDto) {
    return this.loyaltyService.updateReward(actingSellerId(req.user), storeId, rewardId, dto);
  }

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.manage')
  @Delete(':storeId/rewards/:rewardId')
  deleteReward(@Req() req: any, @Param('storeId') storeId: string, @Param('rewardId') rewardId: string) {
    return this.loyaltyService.deleteReward(actingSellerId(req.user), storeId, rewardId);
  }

  // Seller's own management view needs inactive rewards too (to re-enable
  // them) — the buyer-facing `:storeId/rewards` below always filters to
  // active-only, so this is a distinct route rather than a query param to
  // keep the public endpoint's contract simple.
  @Roles('seller', 'staff')
  @RequirePermission('loyalty.view', 'loyalty.manage', 'loyalty.points.award')
  @Get(':storeId/rewards/manage')
  getRewardsForManagement(@Req() req: any, @Param('storeId') storeId: string) {
    return this.loyaltyService.getRewardsForSeller(actingSellerId(req.user), storeId);
  }

  // ── SELLER: ISSUED VOUCHERS ────────────────────────────────────────────────

  @Roles('seller', 'staff')
  @RequirePermission('loyalty.view', 'loyalty.manage', 'loyalty.points.award')
  @Get(':storeId/vouchers')
  listVouchers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.loyaltyService.listVouchers(actingSellerId(req.user), storeId, query);
  }

  // ── PUBLIC/BUYER: REWARDS CATALOG + BALANCE + REDEEM ──────────────────────

  @Get(':storeId/rewards')
  getRewards(@Req() req: any, @Param('storeId') storeId: string) {
    const scopedStoreId = resolveBuyerStoreScope(req.user.storeId, storeId);
    return this.loyaltyService.getRewards(scopedStoreId, true);
  }

  @Get(':storeId/my-balance')
  getMyBalance(@Req() req: any, @Param('storeId') storeId: string) {
    const scopedStoreId = resolveBuyerStoreScope(req.user.storeId, storeId);
    return this.loyaltyService.getMyBalance(scopedStoreId, req.user.userId);
  }

  @Post(':storeId/redeem')
  redeem(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: RedeemRewardDto) {
    const scopedStoreId = resolveBuyerStoreScope(req.user.storeId, storeId);
    return this.loyaltyService.redeemReward(scopedStoreId, req.user.userId, dto.rewardId);
  }
}
