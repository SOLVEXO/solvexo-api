/* eslint-disable prettier/prettier */
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

@ApiTags('Subscriptions (Seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/seller')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // PLANS
  // ═══════════════════════════════════════════════════════════════════════════

  @Post('subscription-plans')
  createPlan(@Req() req: any, @Body() dto: CreatePlanDto) {
    return this.subscriptionsService.createPlan(req.user.userId, dto);
  }

  @Get('subscription-plans')
  listPlans(@Req() req: any) {
    return this.subscriptionsService.listPlans(req.user.userId);
  }

  // Static route BEFORE parameterized — none here, but keeping the rule in mind
  @Get('subscription-plans/:id')
  getPlanById(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.getPlanById(req.user.userId, id);
  }

  @Patch('subscription-plans/:id')
  updatePlan(@Req() req: any, @Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.subscriptionsService.updatePlan(req.user.userId, id, dto);
  }

  @Delete('subscription-plans/:id')
  archivePlan(@Req() req: any, @Param('id') id: string, @Query('force') force: string) {
    return this.subscriptionsService.archivePlan(req.user.userId, id, force === 'true');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTIONS — static routes MUST come before /:id
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('subscriptions/dashboard')
  getDashboard(@Req() req: any) {
    return this.subscriptionsService.getDashboard(req.user.userId);
  }

  @Get('subscriptions/export')
  async exportCsv(@Req() req: any, @Query() query: any, @Res() res: Response) {
    const sellerId = req.user.userId;
    const csv = await this.subscriptionsService.exportCsv(sellerId, query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="subscriptions.csv"');
    res.send(csv);
  }

  @Get('subscriptions')
  listSubscriptions(@Req() req: any, @Query() query: any) {
    return this.subscriptionsService.listSubscriptions(req.user.userId, query);
  }

  // Parameterized routes with static sub-routes BEFORE plain /:id
  @Patch('subscriptions/:id/pause')
  pauseSubscription(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.pauseSubscription(req.user.userId, id);
  }

  @Patch('subscriptions/:id/resume')
  resumeSubscription(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.resumeSubscription(req.user.userId, id);
  }

  @Patch('subscriptions/:id/cancel')
  cancelSubscription(
    @Req() req: any,
    @Param('id') id: string,
    @Query('atPeriodEnd') atPeriodEnd: string,
  ) {
    return this.subscriptionsService.cancelSubscription(
      req.user.userId, id, atPeriodEnd === 'true',
    );
  }

  @Get('subscriptions/:id')
  getSubscriptionById(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.getSubscriptionById(req.user.userId, id);
  }
}
