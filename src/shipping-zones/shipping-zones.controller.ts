/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { ShippingZonesService } from './shipping-zones.service';
import { CreateShippingZoneDto } from './dto/create-shipping-zone.dto';
import { UpdateShippingZoneDto } from './dto/update-shipping-zone.dto';

// Each store owns and manages its own shipping zones/local-delivery rates —
// no platform-wide admin equivalent (the old admin-managed global zone table
// + its checkout fallback were removed; a store with no zones of its own now
// simply has no shipping option at checkout, same as real Shopify).
@ApiTags('Store Shipping Zones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.shipping.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/shipping-zones/store/:storeId')
export class StoreShippingZonesController {
  constructor(private readonly shippingZonesService: ShippingZonesService) {}

  @Get()
  list(@Req() req: any, @Param('storeId') storeId: string, @Query('zoneType') zoneType?: 'shipping' | 'local_delivery') {
    return this.shippingZonesService.listForSeller(storeId, actingSellerId(req.user), zoneType);
  }

  @Post()
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateShippingZoneDto) {
    return this.shippingZonesService.createForSeller(storeId, actingSellerId(req.user), dto);
  }

  @Patch(':zoneId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('zoneId') zoneId: string, @Body() dto: UpdateShippingZoneDto) {
    return this.shippingZonesService.updateForSeller(storeId, actingSellerId(req.user), zoneId, dto);
  }

  @Delete(':zoneId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('zoneId') zoneId: string) {
    return this.shippingZonesService.removeForSeller(storeId, actingSellerId(req.user), zoneId);
  }
}
