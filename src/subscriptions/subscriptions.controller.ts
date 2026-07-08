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
import { SubscribeDto } from './dto/subscribe.dto';
import { ChangePlanDto } from './dto/change-plan.dto';

@ApiTags('Subscriptions')
@Controller('api/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — static routes registered first (see Orders/POS controllers for
  // the same "static before parameterized" convention used elsewhere).
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('public/:storeId/plans')
  browsePlans(@Param('storeId') storeId: string) {
    return this.subscriptionsService.browsePlans(storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  subscribe(@Req() req: any, @Body() dto: SubscribeDto) {
    return this.subscriptionsService.subscribe(req.user.userId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my')
  listMySubscriptions(@Req() req: any, @Query() query: any) {
    return this.subscriptionsService.listMySubscriptions(req.user.userId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my/:id')
  getMySubscriptionById(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.getMySubscriptionById(req.user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/pause')
  selfPause(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.selfPauseSubscription(req.user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/resume')
  selfResume(@Req() req: any, @Param('id') id: string) {
    return this.subscriptionsService.selfResumeSubscription(req.user.userId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/cancel')
  selfCancel(@Req() req: any, @Param('id') id: string, @Query('atPeriodEnd') atPeriodEnd: string, @Body() body: { reason?: string } = {}) {
    return this.subscriptionsService.selfCancelSubscription(req.user.userId, id, atPeriodEnd === 'true', body.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('my/:id/change-plan')
  changePlan(@Req() req: any, @Param('id') id: string, @Body() dto: ChangePlanDto) {
    return this.subscriptionsService.changePlan(req.user.userId, id, dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN
  // ═══════════════════════════════════════════════════════════════════════════

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/overview')
  adminOverview() {
    return this.subscriptionsService.adminGetOverview();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/stores')
  adminStoreBreakdown(@Query() query: any) {
    return this.subscriptionsService.adminGetStoreBreakdown(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/stores/:storeId')
  adminStoreDetail(@Param('storeId') storeId: string) {
    return this.subscriptionsService.adminGetStoreDetail(storeId);
  }

  // ── Dunning / retry visibility ──────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/payment-failures')
  adminPaymentFailures(@Query() query: any) {
    return this.subscriptionsService.adminGetPaymentFailures(query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/subscriptions/:id/payment-attempts')
  adminSubscriptionPaymentAttempts(@Param('id') id: string, @Query() query: any) {
    return this.subscriptionsService.adminGetSubscriptionPaymentAttempts(id, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/subscriptions/:id')
  adminSubscriptionDetail(@Param('id') id: string) {
    return this.subscriptionsService.adminGetSubscriptionDetail(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('admin/plans/:id/suspend')
  adminSuspendPlan(@Param('id') id: string) {
    return this.subscriptionsService.adminSuspendPlan(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch('admin/plans/:id/unsuspend')
  adminUnsuspendPlan(@Param('id') id: string) {
    return this.subscriptionsService.adminUnsuspendPlan(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — store-scoped (parameterized routes registered last)
  // ═══════════════════════════════════════════════════════════════════════════

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/plans')
  createPlan(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreatePlanDto) {
    return this.subscriptionsService.createPlan(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/plans')
  listPlans(@Req() req: any, @Param('storeId') storeId: string) {
    return this.subscriptionsService.listPlans(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/plans/:id')
  getPlanById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.subscriptionsService.getPlanById(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/plans/:id')
  updatePlan(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.subscriptionsService.updatePlan(req.user.userId, storeId, id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/plans/:id')
  archivePlan(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Query('force') force: string) {
    return this.subscriptionsService.archivePlan(req.user.userId, storeId, id, force === 'true');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/dashboard')
  getDashboard(@Req() req: any, @Param('storeId') storeId: string) {
    return this.subscriptionsService.getDashboard(req.user.userId, storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/export')
  async exportCsv(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any, @Res() res: Response) {
    const csv = await this.subscriptionsService.exportCsv(req.user.userId, storeId, query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="subscribers-${storeId}.csv"`);
    res.send(csv);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/subscribers')
  listSubscriptions(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.subscriptionsService.listSubscriptions(req.user.userId, storeId, query);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get(':storeId/subscribers/:id')
  getSubscriptionById(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.subscriptionsService.getSubscriptionById(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/subscribers/:id/pause')
  pauseSubscription(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.subscriptionsService.pauseSubscription(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/subscribers/:id/resume')
  resumeSubscription(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.subscriptionsService.resumeSubscription(req.user.userId, storeId, id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch(':storeId/subscribers/:id/cancel')
  cancelSubscription(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('id') id: string,
    @Query('atPeriodEnd') atPeriodEnd: string,
    @Body() body: { reason?: string } = {},
  ) {
    return this.subscriptionsService.cancelSubscription(req.user.userId, storeId, id, atPeriodEnd === 'true', body.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post(':storeId/plans/estimate-health')
  estimatePlanHealth(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() body: { benefits?: any[]; monthlyPriceUSD: number },
  ) {
    return this.subscriptionsService.estimatePlanHealth(req.user.userId, storeId, body.benefits ?? [], body.monthlyPriceUSD);
  }
}
