/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AffiliateService } from './affiliate.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateAffiliateDto } from './dto/create-affiliate.dto';
import { UpdateAffiliateDto } from './dto/update-affiliate.dto';
import { UpdateAffiliateProgramDto } from './dto/update-affiliate-program.dto';

@ApiTags('Affiliate')
@Controller('api/affiliate')
export class AffiliateController {
  constructor(private readonly affiliateService: AffiliateService) {}

  // ── Seller-facing ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/program')
  getProgram(@Req() req: any, @Param('storeId') storeId: string) {
    return this.affiliateService.getProgramSettings(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/program')
  updateProgram(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateAffiliateProgramDto) {
    return this.affiliateService.updateProgramSettings(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/stats')
  getStats(@Req() req: any, @Param('storeId') storeId: string) {
    return this.affiliateService.getStats(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/referrals')
  listReferrals(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.affiliateService.listReferrals(req.user.userId, storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateAffiliateDto) {
    return this.affiliateService.createAffiliate(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.affiliateService.listAffiliates(req.user.userId, storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/:affiliateId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('affiliateId') affiliateId: string, @Body() dto: UpdateAffiliateDto) {
    return this.affiliateService.updateAffiliate(req.user.userId, storeId, affiliateId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/:affiliateId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('affiliateId') affiliateId: string) {
    return this.affiliateService.removeAffiliate(req.user.userId, storeId, affiliateId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/:affiliateId/pay')
  pay(@Req() req: any, @Param('storeId') storeId: string, @Param('affiliateId') affiliateId: string) {
    return this.affiliateService.payAffiliate(req.user.userId, storeId, affiliateId);
  }

  // ── Public — the referral link an affiliate shares ───────────────────────

  @Get('r/:code')
  async trackClick(@Param('code') code: string, @Res() res: Response) {
    const redirectUrl = await this.affiliateService.trackClick(code);
    return res.redirect(302, redirectUrl);
  }
}
