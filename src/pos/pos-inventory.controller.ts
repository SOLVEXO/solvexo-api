/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosInventoryService } from './pos-inventory.service';

/**
 * G3.1 — inventory for the till. Device + PIN session; WHO may do WHAT is the permission matrix (`pos-permissions.config.ts`), not this file.
 * Reads stay available when the POS plan has lapsed (like the reports); writes need an active plan.
 */
@ApiTags('POS inventory')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/inventory')
export class PosInventoryController {
  constructor(private readonly svc: PosInventoryService) {}
  private t = (e?: string, a?: string) => ({ employee: e, approver: a });

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('overview/:storeId')
  overview(@Req() req: any, @Param('storeId') storeId: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.overview(req, storeId, this.t(e)); }

  // G5.1: the locations a till may filter the stock list by
  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('locations/:storeId')
  locations(@Req() req: any, @Param('storeId') storeId: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.locations(req, storeId, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('stock/:storeId')
  stock(@Req() req: any, @Param('storeId') storeId: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.stock(req, storeId, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('low-stock/:storeId')
  lowStock(@Req() req: any, @Param('storeId') storeId: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.lowStock(req, storeId, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('lots/:storeId/:variantId')
  lots(@Req() req: any, @Param('storeId') storeId: string, @Param('variantId') variantId: string, @Query('qty') qty: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.lotsSuggest(req, storeId, variantId, Number(qty), this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('lookup/:storeId')
  lookup(@Req() req: any, @Param('storeId') storeId: string, @Query('code') code: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.lookup(req, storeId, code, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('movements/:storeId')
  movements(@Req() req: any, @Param('storeId') storeId: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.movements(req, storeId, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('variant/:storeId/:variantId')
  detail(@Req() req: any, @Param('storeId') storeId: string, @Param('variantId') variantId: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.detail(req, storeId, variantId, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('adjust/:storeId/:variantId')
  adjust(@Req() req: any, @Param('storeId') storeId: string, @Param('variantId') variantId: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string, @Headers('x-pos-approver-token') a?: string) { return this.svc.adjust(req, storeId, variantId, body, this.t(e, a)); }

  // ── stock counts (count by scan: `find` resolves a barcode to the count line, `items` records the counted quantity)
  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('counts/:storeId')
  countStart(@Req() req: any, @Param('storeId') storeId: string, @Body() body: { locationId?: string }, @Headers('x-pos-employee-token') e?: string) { return this.svc.countStart(req, storeId, body?.locationId, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('counts/:storeId')
  countList(@Req() req: any, @Param('storeId') storeId: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.countList(req, storeId, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('counts/:storeId/:id')
  countGet(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.countGet(req, storeId, id, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('counts/:storeId/:id/find')
  countFind(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Query('code') code: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.countFind(req, storeId, id, code, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('counts/:storeId/:id/items/:itemId')
  countEnter(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Param('itemId') itemId: string, @Body() body: { countedQty: number }, @Headers('x-pos-employee-token') e?: string) { return this.svc.countEnter(req, storeId, id, itemId, body?.countedQty, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('counts/:storeId/:id/finish')
  countFinish(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.countFinish(req, storeId, id, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('counts/:storeId/:id/cancel')
  countCancel(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.countCancel(req, storeId, id, this.t(e)); }

  // ── approval limits (D6): managers read, the owner edits
  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('limits/:storeId')
  limits(@Req() req: any, @Param('storeId') storeId: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.limits(req, storeId, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('limits/:storeId')
  setLimits(@Req() req: any, @Param('storeId') storeId: string, @Body() body: Record<string, number>, @Headers('x-pos-employee-token') e?: string) { return this.svc.setLimits(req, storeId, body, this.t(e)); }

  // ── G4.6: transfers, expiry, write-off
  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('transfers/:storeId')
  transfers(@Req() req: any, @Param('storeId') storeId: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.transfers(req, storeId, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('transfers/:storeId')
  transferShip(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.transferShip(req, storeId, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('transfers/:storeId/:id/receive')
  transferReceive(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.transferReceive(req, storeId, id, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post('transfers/:storeId/:id/cancel')
  transferCancel(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.transferCancel(req, storeId, id, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('expiry/:storeId')
  expiry(@Req() req: any, @Param('storeId') storeId: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.expiry(req, storeId, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('lots/:storeId/:lotId/write-off')
  writeOff(@Req() req: any, @Param('storeId') storeId: string, @Param('lotId') lotId: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.writeOffLot(req, storeId, lotId, body, this.t(e)); }
}
