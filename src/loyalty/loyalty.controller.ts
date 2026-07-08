/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Put, Delete, Param, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { LoyaltyService } from './loyalty.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UpdateProgramDto } from './dto/update-program.dto';
import { UpdateEarningRulesDto } from './dto/update-earning-rules.dto';
import { UpdateTiersDto } from './dto/update-tiers.dto';
import { CreateRewardDto } from './dto/create-reward.dto';
import { UpdateRewardDto } from './dto/update-reward.dto';
import { AwardPointsDto } from './dto/award-points.dto';
import { RedeemRewardDto } from './dto/redeem-reward.dto';

@ApiTags('Loyalty & Rewards')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('api/loyalty')
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  // ── SELLER: PROGRAM ────────────────────────────────────────────────────────

  @Roles('seller')
  @Get(':storeId/overview')
  getOverview(@Req() req: any, @Param('storeId') storeId: string) {
    return this.loyaltyService.getOverview(req.user.userId, storeId);
  }

  @Roles('seller')
  @Get(':storeId/program')
  getProgram(@Req() req: any, @Param('storeId') storeId: string) {
    return this.loyaltyService.getProgram(req.user.userId, storeId);
  }

  @Roles('seller')
  @Patch(':storeId/program')
  updateProgram(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateProgramDto) {
    return this.loyaltyService.updateProgram(req.user.userId, storeId, dto);
  }

  @Roles('seller')
  @Patch(':storeId/earning-rules')
  updateEarningRules(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateEarningRulesDto) {
    return this.loyaltyService.updateEarningRules(req.user.userId, storeId, dto);
  }

  @Roles('seller')
  @Put(':storeId/tiers')
  updateTiers(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateTiersDto) {
    return this.loyaltyService.updateTiers(req.user.userId, storeId, dto);
  }

  // ── SELLER: MEMBERS ────────────────────────────────────────────────────────

  @Roles('seller')
  @Get(':storeId/members')
  getMembers(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.loyaltyService.getMembers(req.user.userId, storeId, query);
  }

  @Roles('seller')
  @Get(':storeId/members/:memberId/transactions')
  getMemberTransactions(@Req() req: any, @Param('storeId') storeId: string, @Param('memberId') memberId: string, @Query() query: any) {
    return this.loyaltyService.getMemberTransactions(req.user.userId, storeId, memberId, query);
  }

  @Roles('seller')
  @Post(':storeId/members/:memberId/award')
  awardPoints(@Req() req: any, @Param('storeId') storeId: string, @Param('memberId') memberId: string, @Body() dto: AwardPointsDto) {
    return this.loyaltyService.manualAward(req.user.userId, storeId, memberId, dto);
  }

  // ── SELLER: REWARDS CATALOG ────────────────────────────────────────────────

  @Roles('seller')
  @Post(':storeId/rewards')
  createReward(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateRewardDto) {
    return this.loyaltyService.createReward(req.user.userId, storeId, dto);
  }

  @Roles('seller')
  @Patch(':storeId/rewards/:rewardId')
  updateReward(@Req() req: any, @Param('storeId') storeId: string, @Param('rewardId') rewardId: string, @Body() dto: UpdateRewardDto) {
    return this.loyaltyService.updateReward(req.user.userId, storeId, rewardId, dto);
  }

  @Roles('seller')
  @Delete(':storeId/rewards/:rewardId')
  deleteReward(@Req() req: any, @Param('storeId') storeId: string, @Param('rewardId') rewardId: string) {
    return this.loyaltyService.deleteReward(req.user.userId, storeId, rewardId);
  }

  // ── PUBLIC/BUYER: REWARDS CATALOG + BALANCE + REDEEM ──────────────────────

  @Get(':storeId/rewards')
  getRewards(@Param('storeId') storeId: string) {
    return this.loyaltyService.getRewards(storeId, true);
  }

  @Get(':storeId/my-balance')
  getMyBalance(@Req() req: any, @Param('storeId') storeId: string) {
    return this.loyaltyService.getMyBalance(storeId, req.user.userId);
  }

  @Post(':storeId/redeem')
  redeem(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: RedeemRewardDto) {
    return this.loyaltyService.redeemReward(storeId, req.user.userId, dto.rewardId);
  }
}
