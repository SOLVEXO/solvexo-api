/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EmailCampaignsService } from './email-campaigns.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateEmailCampaignDto } from './dto/create-email-campaign.dto';
import { UpdateEmailCampaignDto, ScheduleEmailCampaignDto } from './dto/update-email-campaign.dto';
import { AudiencePreviewDto, SendTestEmailDto } from './dto/campaign-segment.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
@ApiTags('Email Campaigns')
@Controller('api/email-campaigns')
export class EmailCampaignsController {
  constructor(private readonly emailCampaignsService: EmailCampaignsService) {}

  // ── Seller-facing ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateEmailCampaignDto) {
    return this.emailCampaignsService.create(actingSellerId(req.user), storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.emailCampaignsService.list(actingSellerId(req.user), storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get(':storeId/audience-preview')
  previewAudience(@Req() req: any, @Param('storeId') storeId: string, @Query('audience') audience: 'all' | 'buyers' | 'abandoned') {
    return this.emailCampaignsService.previewAudience(actingSellerId(req.user), storeId, audience);
  }

  /** Same as the GET above, but with segment filters (too structured for a query string). */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Post(':storeId/audience-preview')
  previewAudienceWithSegment(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AudiencePreviewDto) {
    return this.emailCampaignsService.previewAudience(actingSellerId(req.user), storeId, dto.audience, dto.segment ?? null);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Post(':storeId/:campaignId/test')
  sendTest(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string, @Body() dto: SendTestEmailDto) {
    return this.emailCampaignsService.sendTest(actingSellerId(req.user), storeId, campaignId, dto.email ?? req.user.email ?? null);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get(':storeId/:campaignId')
  getOne(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string) {
    return this.emailCampaignsService.getOne(actingSellerId(req.user), storeId, campaignId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Patch(':storeId/:campaignId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string, @Body() dto: UpdateEmailCampaignDto) {
    return this.emailCampaignsService.update(actingSellerId(req.user), storeId, campaignId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Delete(':storeId/:campaignId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string) {
    return this.emailCampaignsService.remove(actingSellerId(req.user), storeId, campaignId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Post(':storeId/:campaignId/send')
  sendNow(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string) {
    return this.emailCampaignsService.sendNow(actingSellerId(req.user), storeId, campaignId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Post(':storeId/:campaignId/schedule')
  schedule(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string, @Body() dto: ScheduleEmailCampaignDto) {
    return this.emailCampaignsService.schedule(actingSellerId(req.user), storeId, campaignId, dto.scheduledAt);
  }

  // ── Public — embedded in the sent email itself ───────────────────────────

  /** 1x1 transparent GIF — the classic open-tracking pixel. `:id` is the
   *  EmailCampaignSend doc's own _id (see EmailCampaignsProcessor). */
  @Get('track/open/:id')
  async trackOpen(@Param('id') id: string, @Res() res: Response) {
    const gif = await this.emailCampaignsService.trackOpen(id);
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store');
    return res.send(gif);
  }

  @Get('track/click/:id')
  async trackClick(@Param('id') id: string, @Query('u') target: string | undefined, @Res() res: Response) {
    const redirectUrl = await this.emailCampaignsService.trackClick(id, target ?? null);
    return res.redirect(302, redirectUrl);
  }
}
