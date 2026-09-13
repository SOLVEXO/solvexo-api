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

@ApiTags('Email Campaigns')
@Controller('api/email-campaigns')
export class EmailCampaignsController {
  constructor(private readonly emailCampaignsService: EmailCampaignsService) {}

  // ── Seller-facing ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateEmailCampaignDto) {
    return this.emailCampaignsService.create(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.emailCampaignsService.list(req.user.userId, storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/audience-preview')
  previewAudience(@Req() req: any, @Param('storeId') storeId: string, @Query('audience') audience: 'all' | 'buyers' | 'abandoned') {
    return this.emailCampaignsService.previewAudience(req.user.userId, storeId, audience);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/:campaignId')
  getOne(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string) {
    return this.emailCampaignsService.getOne(req.user.userId, storeId, campaignId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/:campaignId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string, @Body() dto: UpdateEmailCampaignDto) {
    return this.emailCampaignsService.update(req.user.userId, storeId, campaignId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/:campaignId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string) {
    return this.emailCampaignsService.remove(req.user.userId, storeId, campaignId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/:campaignId/send')
  sendNow(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string) {
    return this.emailCampaignsService.sendNow(req.user.userId, storeId, campaignId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/:campaignId/schedule')
  schedule(@Req() req: any, @Param('storeId') storeId: string, @Param('campaignId') campaignId: string, @Body() dto: ScheduleEmailCampaignDto) {
    return this.emailCampaignsService.schedule(req.user.userId, storeId, campaignId, dto.scheduledAt);
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
  async trackClick(@Param('id') id: string, @Res() res: Response) {
    const redirectUrl = await this.emailCampaignsService.trackClick(id);
    return res.redirect(302, redirectUrl);
  }
}
