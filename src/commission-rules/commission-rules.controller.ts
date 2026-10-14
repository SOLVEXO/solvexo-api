/* eslint-disable prettier/prettier */
import { Controller, Get, Put, Delete, Param, Body, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CommissionRulesService } from './commission-rules.service';
import { SetCommissionRateDto } from './dto/set-commission-rate.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RequireApproval } from '../auth/decorators/admin-guards.decorator';
@ApiTags('Admin Commission Rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/commission-rules')
export class CommissionRulesController {
  constructor(private readonly commissionRulesService: CommissionRulesService) {}

  // ─── Global default ──────────────────────────────────────────────────────

  @RequirePermission('commission.manage')
  @Get('global')
  getGlobalDefault() {
    return this.commissionRulesService.getGlobalDefault();
  }

  @RequirePermission('commission.manage')
  @RequireApproval('commission.change')
  @Put('global')
  setGlobalDefault(@Req() req: any, @Body() dto: SetCommissionRateDto) {
    return this.commissionRulesService.setGlobalDefault(dto.rate, dto.notes, req.user.userId);
  }

  @RequirePermission('commission.manage')
  @Get('global/history')
  getGlobalHistory() {
    return this.commissionRulesService.getHistory('global', null);
  }

  // ─── Per-seller overrides (static list route BEFORE parameterized) ──────

  @RequirePermission('commission.manage')
  @Get('sellers')
  listSellerOverrides(@Query() query: any) {
    return this.commissionRulesService.listSellerOverrides(query);
  }

  @RequirePermission('commission.manage')
  @Get('sellers/:storeId')
  resolveForStore(@Param('storeId') storeId: string) {
    return this.commissionRulesService.resolveRate(storeId);
  }

  @RequirePermission('commission.manage')
  @Get('sellers/:storeId/override')
  getSellerOverride(@Param('storeId') storeId: string) {
    return this.commissionRulesService.getSellerOverride(storeId);
  }

  @RequirePermission('commission.manage')
  @Get('sellers/:storeId/history')
  getSellerHistory(@Param('storeId') storeId: string) {
    return this.commissionRulesService.getHistory('seller', storeId);
  }

  @RequirePermission('commission.manage')
  @RequireApproval('commission.change')
  @Put('sellers/:storeId')
  setSellerOverride(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: SetCommissionRateDto) {
    return this.commissionRulesService.setSellerOverride(storeId, dto.rate, dto.notes, req.user.userId);
  }

  @RequirePermission('commission.manage')
  @RequireApproval('commission.change')
  @Delete('sellers/:storeId')
  removeSellerOverride(@Req() req: any, @Param('storeId') storeId: string) {
    return this.commissionRulesService.removeSellerOverride(storeId, req.user.userId);
  }
}
