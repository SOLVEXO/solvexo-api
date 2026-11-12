/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { FulfillmentServicesService } from './fulfillment.service';

/** Seller side: connect a 3PL, see its requests. Permissions: fulfillment.view / fulfillment.manage. */
@ApiTags('Fulfillment services (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/fulfillment-services/:storeId')
export class FulfillmentServicesController {
  constructor(private readonly svc: FulfillmentServicesService, private readonly db: DatabaseService) {}
  private async own(req: any, storeId: string) {
    const sellerId = actingSellerId(req.user);
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, sellerId);
    return { sellerId, actor: { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) } };
  }

  @Get() @RequirePermission('fulfillment.view')
  async list(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.listServices(s); }
  @Post() @RequirePermission('fulfillment.manage')
  async create(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { const o = await this.own(req, s); return this.svc.createService(s, o.sellerId, o.actor, b); }
  @Patch(':id') @RequirePermission('fulfillment.manage')
  async update(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { const o = await this.own(req, s); return this.svc.updateService(s, o.actor, id, b); }
  @Post(':id/rotate-secret') @RequirePermission('fulfillment.manage')
  async rotate(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { const o = await this.own(req, s); return this.svc.rotateSecret(s, o.actor, id); }
  @Delete(':id') @RequirePermission('fulfillment.manage')
  async remove(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { const o = await this.own(req, s); return this.svc.deleteService(s, o.actor, id); }

  @Get('requests/list') @RequirePermission('fulfillment.view')
  async requests(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.listRequests(s, q); }
  @Post('requests') @RequirePermission('fulfillment.manage')
  async send(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { const o = await this.own(req, s); return this.svc.createRequest(s, o.actor, String(b?.orderId ?? ''), String(b?.serviceId ?? '')); }
  @Post('requests/:id/retry') @RequirePermission('fulfillment.manage')
  async retry(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { const o = await this.own(req, s); return this.svc.retry(s, o.actor, id); }
  @Post('requests/:id/cancel') @RequirePermission('fulfillment.manage')
  async cancel(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { const o = await this.own(req, s); return this.svc.cancelRequest(s, o.actor, id); }
}

/** The 3PL calls this (no login: authenticated by the HMAC signature of the shared secret). */
@ApiTags('Fulfillment callbacks (public, signed)')
@Controller('api/fulfillment-callbacks')
export class FulfillmentCallbackController {
  constructor(private readonly svc: FulfillmentServicesService) {}
  @Post(':serviceId')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async callback(@Param('serviceId') id: string, @Headers('x-solvexo-signature') sig: string, @Req() req: any, @Body() body: any) {
    const raw = req.rawBody ? Buffer.from(req.rawBody).toString('utf8') : JSON.stringify(body ?? {});
    return this.svc.handleCallback(id, raw, String(sig ?? ''), body);
  }
}
