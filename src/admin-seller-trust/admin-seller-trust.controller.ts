/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RejectLeadDto } from '../admin-marketplace/dto/reject-lead.dto';
import { RequestInfoDto } from '../admin-marketplace/dto/request-info.dto';
import { AdminSellerTrustService } from './admin-seller-trust.service';
import { SellerTrustQueryDto } from './dto/seller-trust-query.dto';
import { NtnCheckDto, PayoutHoldDto, RemindDto, UpdateSellerTrustSettingsDto } from './dto/seller-trust-actions.dto';

// Reads: `clients.view`; actions: `marketplace.manage` (the same permission the Leads review always used).
@ApiTags('Admin Seller Trust')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/seller-trust')
export class AdminSellerTrustController {
  constructor(private readonly service: AdminSellerTrustService) {}

  private meta(req: any) {
    return { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  @RequirePermission('clients.view')
  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }

  @RequirePermission('clients.view')
  @Get('settings')
  getSettings() {
    return this.service.getSettings();
  }

  @RequirePermission('marketplace.manage')
  @Patch('settings')
  updateSettings(@Req() req: any, @Body() dto: UpdateSellerTrustSettingsDto) {
    return this.service.updateSettings(dto, this.meta(req));
  }

  @RequirePermission('clients.view')
  @Get('stores')
  listStores(@Query() query: SellerTrustQueryDto) {
    return this.service.listStores(query);
  }

  // Declared before `stores/:storeId` so "export" is never read as a store id.
  @RequirePermission('clients.view')
  @Get('stores/export')
  async exportStores(@Query() query: SellerTrustQueryDto, @Res() res: Response) {
    const csv = await this.service.exportStoresCsv(query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="solvexo-seller-trust.csv"');
    res.send(csv);
  }

  @RequirePermission('clients.view')
  @Get('stores/:storeId')
  getStore(@Param('storeId') storeId: string) {
    return this.service.getStoreDetail(storeId);
  }

  @RequirePermission('marketplace.manage')
  @Post('stores/:storeId/under-review')
  markUnderReview(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.markUnderReview(storeId, this.meta(req));
  }

  @RequirePermission('marketplace.manage')
  @Post('stores/:storeId/approve')
  approve(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.approve(storeId, this.meta(req));
  }

  @RequirePermission('marketplace.manage')
  @Post('stores/:storeId/reject')
  reject(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: RejectLeadDto) {
    return this.service.reject(storeId, dto.reason, this.meta(req));
  }

  @RequirePermission('marketplace.manage')
  @Post('stores/:storeId/request-info')
  requestInfo(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: RequestInfoDto) {
    return this.service.requestInfo(storeId, dto.message, this.meta(req));
  }

  @RequirePermission('marketplace.manage')
  @Post('stores/:storeId/ntn-check')
  ntnCheck(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: NtnCheckDto) {
    return this.service.recordNtnCheck(storeId, dto.result, this.meta(req));
  }

  @RequirePermission('marketplace.manage')
  @Post('stores/:storeId/payout-hold')
  payoutHold(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: PayoutHoldDto) {
    return this.service.setPayoutHold(storeId, dto.active, dto.reason, this.meta(req));
  }

  @RequirePermission('marketplace.manage')
  @Post('remind')
  remind(@Req() req: any, @Body() dto: RemindDto) {
    return this.service.remind(dto, this.meta(req));
  }
}
