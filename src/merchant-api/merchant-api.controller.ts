/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { ApiTokenGuard, ApiTokensService, NeedsApiScope } from './api-tokens.service';
import { MerchantWebhooksService } from './merchant-webhooks.service';
import { ApiWritesService } from './api-writes.service';
import { ApiReadsService } from './api-reads.service';

/** Seller settings: webhooks + API tokens. Permission: settings.general.manage. Needs the plan's API & webhooks feature to create. */
@ApiTags('Webhooks and API tokens (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/merchant-api/:storeId')
export class MerchantApiSettingsController {
  constructor(private readonly hooks: MerchantWebhooksService, private readonly tokens: ApiTokensService, private readonly db: DatabaseService, private readonly entitlements: EntitlementsService) {}
  private async own(req: any, s: string, write = false) {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, s, actingSellerId(req.user));
    if (write) await this.entitlements.assertFeatureAllowed(s, 'apiWebhooksAllowed', 'API & webhooks');
    return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) };
  }

  @Get('webhooks') @RequirePermission('settings.general.manage') async list(@Req() r: any, @Param('storeId') s: string) { await this.own(r, s); return this.hooks.list(s); }
  @Post('webhooks') @RequirePermission('settings.general.manage') async create(@Req() r: any, @Param('storeId') s: string, @Body() b: any) { const a = await this.own(r, s, true); return this.hooks.create(s, a, b); }
  @Patch('webhooks/:id') @RequirePermission('settings.general.manage') async update(@Req() r: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { const a = await this.own(r, s); return this.hooks.update(s, a, id, b); }
  @Post('webhooks/:id/rotate-secret') @RequirePermission('settings.general.manage') async rotate(@Req() r: any, @Param('storeId') s: string, @Param('id') id: string) { const a = await this.own(r, s); return this.hooks.rotate(s, a, id); }
  @Delete('webhooks/:id') @RequirePermission('settings.general.manage') async remove(@Req() r: any, @Param('storeId') s: string, @Param('id') id: string) { const a = await this.own(r, s); return this.hooks.remove(s, a, id); }
  @Get('webhooks/:id/deliveries') @RequirePermission('settings.general.manage') async log(@Req() r: any, @Param('storeId') s: string, @Param('id') id: string, @Query() q: any) { await this.own(r, s); return this.hooks.deliveryLog(s, id, q); }
  @Post('deliveries/:deliveryId/redeliver') @RequirePermission('settings.general.manage') async redeliver(@Req() r: any, @Param('storeId') s: string, @Param('deliveryId') id: string) { const a = await this.own(r, s); return this.hooks.redeliver(s, a, id); }

  @Get('tokens') @RequirePermission('settings.general.manage') async tlist(@Req() r: any, @Param('storeId') s: string) { await this.own(r, s); return this.tokens.list(s); }
  @Post('tokens') @RequirePermission('settings.general.manage') async tcreate(@Req() r: any, @Param('storeId') s: string, @Body() b: any) { const a = await this.own(r, s, true); return this.tokens.create(s, a, b); }
  @Delete('tokens/:id') @RequirePermission('settings.general.manage') async trevoke(@Req() r: any, @Param('storeId') s: string, @Param('id') id: string) { const a = await this.own(r, s); return this.tokens.revoke(s, a, id); }
}

/**
 * Public Admin API (v1): Bearer `sxk_` token, store-scoped (the store is always the token's own), documented in
 * GET /api/merchant/v1/openapi.json. Lists are newest first with `limit` / `cursor` / `updated_since`; the response is
 * `{ items, has_more, next_cursor }`. Writes need a write_* scope and an Idempotency-Key header.
 */
@ApiTags('Merchant API v1')
@UseGuards(ApiTokenGuard)
@Controller('api/merchant/v1')
export class MerchantApiV1Controller {
  constructor(private readonly db: DatabaseService, private readonly writes: ApiWritesService, private readonly reads: ApiReadsService) {}
  private page(q: any) { const page = Math.max(1, Number(q?.page) || 1); const limit = Math.min(50, Math.max(1, Number(q?.limit) || 20)); return { page, limit, skip: (page - 1) * limit }; }
  /** Integrations built before cursors send `page`: they keep the old answer (raw rows + total). */
  private legacy(q: any) { return q?.page !== undefined && q?.cursor === undefined; }

  @Get('store')
  store(@Req() req: any) { return this.reads.store(req.apiToken.storeId); }

  @Get('orders') @NeedsApiScope('read_orders')
  async orders(@Req() req: any, @Query() q: any) {
    const storeId = req.apiToken.storeId;
    if (!this.legacy(q)) return this.reads.orders(storeId, q);
    const { page, limit, skip } = this.page(q);
    const f = { isDelete: false, 'sellerOrders.storeId': storeId };
    const m = (this.db.repositories as any).orderModel;
    const [items, total] = await Promise.all([m.find(f).select('orderNumber orderStatus isPaid totalAmount currency createdAt').sort({ _id: -1 }).skip(skip).limit(limit).lean(), m.countDocuments(f)]);
    return { items, total, page, limit };
  }

  @Get('orders/:id') @NeedsApiScope('read_orders')
  order(@Req() req: any, @Param('id') id: string) { return this.reads.order(req.apiToken.storeId, id); }

  /** WRITE: ship lines of this store's part of the order. Needs write_orders + Idempotency-Key. Answers with the updated order. */
  @Post('orders/:id/fulfillments') @NeedsApiScope('write_orders')
  async fulfil(@Req() req: any, @Param('id') id: string, @Body() body: any, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.writes.once(req.apiToken, key, { id, body }, async () => { await this.writes.fulfilOrder(req.apiToken, id, body); return this.reads.order(req.apiToken.storeId, id); });
    res.setHeader('Idempotent-Replayed', String(r.replayed)); return r.result;
  }

  @Get('products') @NeedsApiScope('read_products')
  async products(@Req() req: any, @Query() q: any) {
    const storeId = req.apiToken.storeId;
    if (!this.legacy(q)) return this.reads.products(storeId, q);
    const { page, limit, skip } = this.page(q);
    const f = { storeId, isDelete: false };
    const m = (this.db.repositories as any).productModel;
    const [items, total] = await Promise.all([m.find(f).select('name slug status vendor tags images createdAt updatedAt').sort({ _id: -1 }).skip(skip).limit(limit).lean(), m.countDocuments(f)]);
    return { items, total, page, limit };
  }

  @Get('products/:id') @NeedsApiScope('read_products')
  product(@Req() req: any, @Param('id') id: string) { return this.reads.product(req.apiToken.storeId, id); }

  /** WRITE: product status / tags. Needs the write_products scope and an Idempotency-Key header; answers with `Idempotent-Replayed: true` on a retry. */
  @Patch('products/:id') @NeedsApiScope('write_products')
  async patchProduct(@Req() req: any, @Param('id') id: string, @Body() body: any, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.writes.once(req.apiToken, key, { id, body }, () => this.writes.updateProduct(req.apiToken, id, body));
    res.setHeader('Idempotent-Replayed', String(r.replayed)); return r.result;
  }

  @Get('collections') @NeedsApiScope('read_products')
  collections(@Req() req: any, @Query() q: any) { return this.reads.collections(req.apiToken.storeId, q); }

  @Get('inventory') @NeedsApiScope('read_inventory')
  inventory(@Req() req: any, @Query() q: any) { return this.reads.inventory(req.apiToken.storeId, q); }

  /** WRITE: relative stock change of one variant. Needs write_inventory + Idempotency-Key. */
  @Post('inventory/adjust') @NeedsApiScope('write_inventory')
  async adjustInventory(@Req() req: any, @Body() body: any, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const r = await this.writes.once(req.apiToken, key, body, () => this.writes.adjustInventory(req.apiToken, body));
    res.setHeader('Idempotent-Replayed', String(r.replayed)); return r.result;
  }

  @Get('customers') @NeedsApiScope('read_customers')
  customers(@Req() req: any, @Query() q: any) { return this.reads.customers(req.apiToken.storeId, q); }

  @Get('customers/:id') @NeedsApiScope('read_customers')
  customer(@Req() req: any, @Param('id') id: string) { return this.reads.customer(req.apiToken.storeId, id); }
}
