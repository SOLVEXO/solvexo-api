/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreBadgesService } from './store-badges.service';

@ApiTags('Store badges')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@Controller('api/store-badges')
export class StoreBadgesController {
  constructor(private readonly service: StoreBadgesService) {}

  /** Any staff role may ask; the service only counts the areas that role can open. */
  @Get(':storeId')
  @RequirePermission(
    'orders.view', 'orders.return', 'orders.disputes_manage', 'orders.record_payment', 'messaging.view', 'messaging.manage',
    'onlinestore.content.manage', 'customers.view', 'reviews.manage', 'inventory.view', 'inventory.adjust',
  )
  get(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.get({ role: req.user?.role, permissions: req.user?.permissions }, actingSellerId(req.user), storeId);
  }
}
