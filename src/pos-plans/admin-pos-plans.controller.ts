/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminPosPlansService } from './admin-pos-plans.service';
import { CreatePosPlanDto } from './dto/create-pos-plan.dto';
import { UpdatePosPlanDto } from './dto/update-pos-plan.dto';
import { PosPurchaseQueryDto } from './dto/pos-purchase-query.dto';
import { GrantPosPlanDto, RevokePosPlanDto } from './dto/manual-pos-plan.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RequireApproval } from '../auth/decorators/admin-guards.decorator';
@ApiTags('Admin POS Plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin')
export class AdminPosPlansController {
  constructor(private readonly adminPosPlansService: AdminPosPlansService) {}

  @RequirePermission('billing.manage')
  @Get('pos-plans')
  listPlans() {
    return this.adminPosPlansService.listPlans();
  }

  @RequirePermission('billing.manage')
  @RequireApproval('plans.change')
  @Post('pos-plans')
  createPlan(@Body() dto: CreatePosPlanDto) {
    return this.adminPosPlansService.createPlan(dto);
  }

  @RequirePermission('billing.manage')
  @RequireApproval('plans.change')
  @Patch('pos-plans/:id')
  updatePlan(@Param('id') id: string, @Body() dto: UpdatePosPlanDto) {
    return this.adminPosPlansService.updatePlan(id, dto);
  }

  @RequirePermission('billing.manage')
  @Get('pos-purchases')
  listPurchases(@Query() query: PosPurchaseQueryDto) {
    return this.adminPosPlansService.listPurchases(query);
  }

  // ── Manual access control (support / migration / goodwill) ────────────────────────────────────────
  // Each call needs a reason; the admin id + reason are written to the audit log (category admin_audit).
  private actor(req: any) {
    return { adminId: req.user.userId, email: req.user.email ?? null, ip: req.ip ?? null, userAgent: req.headers?.['user-agent'] ?? null };
  }

  @RequirePermission('billing.manage')
  @Post('pos-purchases/grant')
  grant(@Req() req: any, @Body() dto: GrantPosPlanDto) {
    return this.adminPosPlansService.grantManually(dto, this.actor(req));
  }

  @RequirePermission('billing.manage')
  @Post('pos-purchases/extend')
  extend(@Req() req: any, @Body() dto: GrantPosPlanDto) {
    return this.adminPosPlansService.extendManually(dto, this.actor(req));
  }

  @RequirePermission('billing.manage')
  @Post('pos-purchases/revoke')
  revoke(@Req() req: any, @Body() dto: RevokePosPlanDto) {
    return this.adminPosPlansService.revokeManually(dto, this.actor(req));
  }
}
