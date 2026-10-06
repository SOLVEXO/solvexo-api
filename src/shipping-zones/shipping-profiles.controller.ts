/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { ShippingProfilesService } from './shipping-profiles.service';
import { AssignProfileProductsDto, CreateShippingProfileDto, UpdateShippingProfileDto } from './dto/shipping-profile.dto';

// Shopify shipping profiles — same guards/permission as the store's shipping zones.
@ApiTags('Store Shipping Profiles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.shipping.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store/:storeId/shipping-profiles')
export class ShippingProfilesController {
  constructor(private readonly profilesService: ShippingProfilesService) {}

  @Get()
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.profilesService.list(storeId, actingSellerId(req.user));
  }

  @Post()
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateShippingProfileDto) {
    return this.profilesService.create(storeId, actingSellerId(req.user), dto);
  }

  // Declared before ':profileId' routes so "products" is never read as a profile id.
  @Get('products')
  searchProducts(@Req() req: any, @Param('storeId') storeId: string, @Query('q') q?: string, @Query('profileId') profileId?: string) {
    return this.profilesService.searchProducts(storeId, actingSellerId(req.user), q, profileId);
  }

  @Patch(':profileId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('profileId') profileId: string, @Body() dto: UpdateShippingProfileDto) {
    return this.profilesService.update(storeId, actingSellerId(req.user), profileId, dto);
  }

  @Delete(':profileId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('profileId') profileId: string) {
    return this.profilesService.remove(storeId, actingSellerId(req.user), profileId);
  }

  // `profileId` may be the literal "general" to move products back to the General profile.
  @Post(':profileId/products')
  assignProducts(@Req() req: any, @Param('storeId') storeId: string, @Param('profileId') profileId: string, @Body() dto: AssignProfileProductsDto) {
    return this.profilesService.assignProducts(storeId, actingSellerId(req.user), profileId, dto.productIds);
  }
}
