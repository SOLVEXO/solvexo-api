/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Query, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminClientsService } from './admin-clients.service';
import { ClientActivityQueryDto } from './dto/client-activity-query.dto';
import { MerchantHealthQueryDto } from './dto/merchant-health-query.dto';
import { MerchantHealthService } from './merchant-health.service';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
// A "client" is a `Seller` document — see AdminClientsService's own header
// comment. This controller composes already-`sellerId`-scoped data from
// Users/Analytics/Finance/platform-plans into one workspace per client,
// rather than the admin having to visit five separate pages per seller.
@ApiTags('Admin Clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/clients')
export class AdminClientsController {
  constructor(
    private readonly adminClientsService: AdminClientsService,
    private readonly merchantHealth: MerchantHealthService,
  ) {}

  // ── Merchant health (declared before the ':sellerId/...' routes) ──

  /** Health score of every store, with the at-risk summary. Default order: lowest score first. */
  @RequirePermission('clients.view')
  @Get('health')
  getHealth(@Query() query: MerchantHealthQueryDto) {
    return this.merchantHealth.list(query);
  }

  @RequirePermission('clients.view')
  @Get('health/export')
  async exportHealth(@Query() query: MerchantHealthQueryDto, @Res() res: Response) {
    const csv = await this.merchantHealth.exportCsv(query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="solvexo-merchant-health.csv"');
    res.send(csv);
  }

  @RequirePermission('clients.view')
  @Get('health/store/:storeId')
  getStoreHealth(@Param('storeId') storeId: string) {
    return this.merchantHealth.forStore(storeId);
  }

  @RequirePermission('clients.view')
  @Get(':sellerId/overview')
  getOverview(@Param('sellerId') sellerId: string) {
    return this.adminClientsService.getOverview(sellerId);
  }

  @RequirePermission('clients.view')
  @Get(':sellerId/finance')
  getFinance(@Param('sellerId') sellerId: string) {
    return this.adminClientsService.getFinance(sellerId);
  }

  @RequirePermission('clients.view')
  @Get(':sellerId/moderation')
  getModeration(@Param('sellerId') sellerId: string) {
    return this.adminClientsService.getModeration(sellerId);
  }

  @RequirePermission('clients.view')
  @Get(':sellerId/activity')
  getActivity(@Param('sellerId') sellerId: string, @Query() query: ClientActivityQueryDto) {
    return this.adminClientsService.getActivity(sellerId, query);
  }
}
