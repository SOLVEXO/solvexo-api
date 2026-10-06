// import { Controller, Get, Put, Param, Req, UseGuards } from '@nestjs/common';
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { RolesGuard } from '../auth/guards/roles.guard';
// import { OrdersService } from './orders.service';
import { PurchaseShippingLabelDto } from './dto/purchase-label.dto';
import { FulfilOrderDto } from './dto/fulfil-order.dto';
import { PurchaseReturnLabelDto, UpdateTrackingDto } from './dto/purchase-label.dto';
import { parseLabelItemsQuery } from './shipments.util';

// @Controller('api/orders')
// export class OrdersController {
//   constructor(private readonly ordersService: OrdersService) {}

//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Get('myOrders')
//   async getMyOrders(@Req() req: any) {
//     const { userId } = req.user;
//     return this.ordersService.getMyOrders(userId);
//   }

//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Get(':orderId')
//   async getOrderById(@Req() req: any, @Param('orderId') orderId: string) {
//     const { userId } = req.user;
//     return this.ordersService.getOrderById(userId, orderId);
//   }

//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Put('cancel/:orderId')
//   async cancelOrder(@Req() req: any, @Param('orderId') orderId: string) {
//     const { userId } = req.user;
//     return this.ordersService.cancelOrder(userId, orderId);
//   }
// }

import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { OrderEditingService } from './order-editing.service';
import { OrderExchangeService } from './order-exchange.service';
import { CreateExchangeDto } from './dto/order-exchange.dto';
import { EditOrderDto, OrderCommentDto, OrderNoteDto, OrderShippingAddressDto } from './dto/order-editing.dto';
const editActor = (req: any) => ({ actorId: String(req.user.userId), actorRole: (req.user.role === 'staff' ? 'staff' : 'seller') as 'seller' | 'staff' });
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { StaffStorePinned } from '../auth/decorators/staff-store-pinned.decorator';
import { OrdersService } from './orders.service';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { actingSellerId } from '../common/acting-seller-id.util';

@Controller('api/orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly orderEditing: OrderEditingService,
    private readonly orderExchange: OrderExchangeService,
  ) {}

  // Shopify order-status page: opens ONE order from a signed link, no login (how a guest tracks an order).
  @Get('status/:token')
  async getOrderByStatusToken(@Param('token') token: string) {
    return this.ordersService.getOrderByStatusToken(token);
  }

  // The signed status-page link for an order the caller owns (used by the post-purchase page).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('status-link/:orderId')
  async getOrderStatusLink(@Req() req: any, @Param('orderId') orderId: string) {
    return this.ordersService.getOrderStatusToken(req.user.userId, orderId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('my-orders')
  async getOrdersByUserId(@Req() req: any, @Query() query: any) {
    const { userId } = req.user;
    const storeId = resolveBuyerStoreScope(req.user.storeId, query.storeId);
    return this.ordersService.getOrdersByUserId(userId, query, storeId);
  }

  // signed URLs (non-stamped) + stamped stream URLs list
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('download-url')
  async getDownloadUrls(
    @Req() req: any,
    @Query('orderId') orderId: string,
    @Query('productId') productId: string,
    @Query('storeId') storeIdQuery: string,
  ) {
    const { userId } = req.user;
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.ordersService.getDownloadUrls(userId, orderId, productId, storeId);
  }

  // Store-scoped: the caller must own `:storeId` (or be staff of it with the
  // permission) AND the order must contain a sub-order for that store. The
  // previous unscoped `mark-paid/:orderId` let any seller mark any store's
  // order paid (and credit its ledger).
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.record_payment')
  @Put('mark-paid/:storeId/:orderId')
  async markPaid(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.ordersService.markPaid(actingSellerId(req.user), storeId, orderId, {
      actorId: req.user.userId ?? req.user.sellerId,
      actorRole: req.user.role,
    });
  }

  // Real "Record payments" — see OrdersService.recordOrderPayment's doc
  // comment. Distinct from the legacy `markPaid` above (kept untouched for
  // backward compatibility) — this one captures amount/method/reference and
  // supports partial/installment entries.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.record_payment')
  @Post('record-payment/:storeId/:orderId')
  async recordOrderPayment(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Body() body: { amount: number; method: 'cash' | 'bank_transfer' | 'other'; reference?: string; note?: string },
  ) {
    return this.ordersService.recordOrderPayment(
      actingSellerId(req.user), storeId, orderId, body,
      { actorId: req.user.userId ?? req.user.sellerId, actorRole: req.user.role },
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.record_payment')
  @Get('payment-records/:storeId/:orderId')
  async listOrderPayments(@Req() req: any, @Param('storeId') storeId: string, @Param('orderId') orderId: string) {
    const records = await this.ordersService.listOrderPayments(actingSellerId(req.user), storeId, orderId);
    return { success: true, data: records };
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.fulfill')
  @Put('update-status')
  async updateSellerOrderStatus(@Req() req: any, @Body() body: any) {
    return this.ordersService.updateSellerOrderStatus(
      actingSellerId(req.user),
      body,
      req.ip,
      req.headers['user-agent'],
    );
  }

  /** Shopify "Fulfil items": ship a subset/quantity of the unfulfilled lines as one shipment. */
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.fulfill')
  @Post('fulfil/:storeId/:orderId')
  async fulfilItems(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Body() dto: FulfilOrderDto,
  ) {
    return this.ordersService.fulfilItems(actingSellerId(req.user), storeId, orderId, dto, req.ip, req.headers['user-agent']);
  }

  /** Marks ONE shipment delivered; the sub-order becomes 'delivered' once every shipment is. */
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.fulfill')
  @Put('shipment-delivered/:storeId/:orderId/:shipmentId')
  async markShipmentDelivered(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Param('shipmentId') shipmentId: string,
  ) {
    return this.ordersService.markShipmentDelivered(actingSellerId(req.user), storeId, orderId, shipmentId, req.ip, req.headers['user-agent']);
  }

  /** Real one-click "mark as shipped" via a live-purchased carrier label —
   *  see OrdersService.purchaseShippingLabel's own doc comment. */
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.buy_shipping_label')
  @Put('purchase-shipping-label')
  async purchaseShippingLabel(@Req() req: any, @Body() body: PurchaseShippingLabelDto) {
    return this.ordersService.purchaseShippingLabel(
      actingSellerId(req.user), body.orderId, body.storeId, req.ip, req.headers['user-agent'],
      { rateId: body.rateId, packageId: body.packageId, items: body.items, notifyCustomer: body.notifyCustomer },
    );
  }

  /** Shopify "Buy shipping label" step 1 — real carrier rates for this order (optional ?packageId=). */
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.buy_shipping_label')
  @Get('label-rates/:storeId/:orderId')
  async listShippingLabelRates(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Query('packageId') packageId?: string,
    @Query('items') items?: string,
  ) {
    return this.ordersService.listShippingLabelRates(
      actingSellerId(req.user), orderId, storeId,
      typeof packageId === 'string' && /^[\w-]{1,40}$/.test(packageId) ? packageId : undefined,
      // Partial shipment: "itemId:qty,itemId:qty" — weigh only those lines (malformed = ignored = whole order).
      parseLabelItemsQuery(items) ?? undefined,
    );
  }

  /** Return label step 1 — carrier rates buyer -> store for approved returned lines (?itemIds=a,b&packageId=). */
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.buy_shipping_label')
  @Get('return-label-rates/:storeId/:orderId')
  async listReturnLabelRates(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Query('itemIds') itemIds?: string,
    @Query('packageId') packageId?: string,
  ) {
    const ids = typeof itemIds === 'string' ? itemIds.split(',').map((s) => s.trim()).filter((s) => /^[a-f\d]{24}$/i.test(s)).slice(0, 100) : [];
    return this.ordersService.listReturnLabelRates(
      actingSellerId(req.user), orderId, storeId, ids,
      typeof packageId === 'string' && /^[\w-]{1,40}$/.test(packageId) ? packageId : undefined,
    );
  }

  /** Return label step 2 — buys the label, saves it on the returned lines and emails the buyer. */
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.buy_shipping_label')
  @Put('purchase-return-label')
  async purchaseReturnLabel(@Req() req: any, @Body() body: PurchaseReturnLabelDto) {
    return this.ordersService.purchaseReturnLabel(
      actingSellerId(req.user), body.storeId, body.orderId, body.itemIds,
      { rateId: body.rateId, packageId: body.packageId, notifyCustomer: body.notifyCustomer },
      editActor(req),
    );
  }

  /** Edit the tracking of an old shipped order that predates per-shipment tracking. */
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.fulfill')
  @Put('tracking/:storeId/:orderId')
  async updateLegacyTracking(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Body() dto: UpdateTrackingDto,
  ) {
    return this.ordersService.updateLegacyTracking(actingSellerId(req.user), storeId, orderId, dto, editActor(req));
  }

  // Static path — must be declared before `seller-orders/:storeId` below, otherwise
  // that param route would swallow this literal segment as `storeId: 'my'`.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.view')
  @Get('seller-orders/my')
  async getMySellerOrders(@Req() req: any, @Query() query: any) {
    // A staff login is bound to ONE store — never the owning seller's other stores.
    const storeScope = req.user.role === 'staff' ? req.user.storeId : null;
    return this.ordersService.getSellerOrders(actingSellerId(req.user), storeScope, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.view')
  @Get('seller-orders/:storeId')
  async getSellerOrders(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    return this.ordersService.getSellerOrders(actingSellerId(req.user), storeId, query);
  }

  // Static segment — must be declared before `seller-orders/:storeId/:orderId`
  // below, same reasoning as `seller-orders/my` above.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.export')
  @Get('seller-orders/:storeId/export')
  async exportOrdersCsv(
    @Req() req: any,
    @Res() res: Response,
    @Param('storeId') storeId: string,
    @Query() query: any,
  ) {
    const csv = await this.ordersService.exportOrdersCsv(
      actingSellerId(req.user),
      storeId,
      query,
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(csv);
  }

  // A 3-segment path — never collides with the 2-segment `seller-orders/:storeId`
  // above or the 1-segment catch-all `:orderId` below.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.view')
  @Get('seller-orders/:storeId/:orderId')
  async getSellerOrderDetail(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.ordersService.getSellerOrderDetail(actingSellerId(req.user), storeId, orderId);
  }

  // ── Admin-authorized VIEW of a seller-order's detail, for the Clients
  // workspace's Orders tab — read-only, deliberately. The seller-facing
  // route above 403s for an admin caller (`actingSellerId(req.user)`
  // resolves to the admin's own userId, which never matches a store's real
  // sellerId), so this resolves the store's real sellerId server-side
  // instead (OrdersService.resolveStoreSellerId) — same pattern as
  // SellerPlatformSubscriptionsService's admin billing routes. No admin
  // cancel/refund route exists here by design: Solvexo stores are
  // independent (Shopify-style), not a curated marketplace — a seller's
  // own order data is theirs to act on, never admin's to touch on their
  // behalf. (Cancel/refund admin routes were built once, then deliberately
  // removed for exactly this reason.) ─────────────────────────────────────

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin-orders/:storeId/:orderId')
  async adminGetOrderDetail(
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.ordersService.adminGetSellerOrderDetail(storeId, orderId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('cancel/:orderId')
  async cancelOrder(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Body() body: any,
  ) {
    const { userId } = req.user;
    const storeId = resolveBuyerStoreScope(req.user.storeId, body?.storeId);
    return this.ordersService.cancelOrder(userId, orderId, body, storeId);
  }

  // Seller-initiated cancellation (e.g. out-of-stock) — scoped to only the
  // seller's own sellerOrder within a (possibly multi-seller) order.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.cancel')
  @Post('seller-cancel/:storeId/:orderId')
  async cancelOrderAsSeller(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Body() body: any,
  ) {
    return this.ordersService.cancelOrderAsSeller(
      actingSellerId(req.user),
      storeId,
      orderId,
      body,
    );
  }

  // Standalone "Refund $X" — independent of Cancel/Return, no item status
  // changes. See OrdersService.refundOrderAsSeller's own doc comment.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.refund')
  @Post('seller-refund/:storeId/:orderId')
  async refundOrderAsSeller(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Body() body: { amount: number; reason?: string; refundTo?: 'original' | 'store_credit' },
  ) {
    return this.ordersService.refundOrderAsSeller(
      actingSellerId(req.user),
      storeId,
      orderId,
      body,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.return')
  @StaffStorePinned()
  @Get('returns')
  async getSellerReturns(@Req() req: any, @Query() query: any) {
    return this.ordersService.getSellerReturns(actingSellerId(req.user), query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Post('return-request/:orderId')
  async returnRequest(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Body() body: any,
  ) {
    const { userId } = req.user;
    const storeId = resolveBuyerStoreScope(req.user.storeId, body?.storeId);
    return this.ordersService.returnRequest(userId, orderId, body, storeId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.return')
  @Put('return-action/:orderId')
  async returnAction(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Body() body: any,
  ) {
    return this.ordersService.returnAction(
      actingSellerId(req.user),
      orderId,
      body,
      req.ip,
      req.headers['user-agent'],
    );
  }

  // Step 1: JWT se download link lo (10 min valid)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('get-download-link')
  async getDownloadLink(
    @Req() req: any,
    @Query('orderId') orderId: string,
    @Query('productId') productId: string,
    @Query('fileIndex') fileIndex: string,
    @Query('storeId') storeIdQuery: string,
  ) {
    const { userId } = req.user;
    const index = parseInt(fileIndex) || 0;
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.ordersService.getDownloadLink(
      userId,
      orderId,
      productId,
      index,
      storeId,
    );
  }

  // Step 2: yeh URL browser mein paste karo — seedha download (no auth header)
  @Get('download-file')
  async downloadFile(@Res() res: Response, @Query('token') token: string) {
    const { buffer, fileName, mimeType } =
      await this.ordersService.downloadByToken(token);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // stamped PDF via token — browser direct download (no JWT header)
  @Get('stream-pdf-token')
  async streamPdfByToken(@Res() res: Response, @Query('token') token: string) {
    const { buffer, fileName } =
      await this.ordersService.streamStampedPdfByToken(token);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // stamped PDF stream — browser direct download
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('stream-pdf')
  async streamPdf(
    @Req() req: any,
    @Res() res: Response,
    @Query('orderId') orderId: string,
    @Query('productId') productId: string,
    @Query('fileIndex') fileIndex: string,
    @Query('storeId') storeIdQuery: string,
  ) {
    const { userId } = req.user;
    const index = parseInt(fileIndex) || 0;
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);

    const { buffer, fileName } = await this.ordersService.streamStampedPdf(
      userId,
      orderId,
      productId,
      index,
      storeId,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });

    res.end(buffer);
  }

  // Shopify exchange: resolve a pending return as an EXCHANGE — replacement items become a new linked order; only the
  // price difference moves money. See OrderExchangeService's doc comment.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.return')
  @Post('exchange/:storeId/:orderId')
  async createExchange(@Req() req: any, @Param('storeId') storeId: string, @Param('orderId') orderId: string, @Body() dto: CreateExchangeDto) {
    return this.orderExchange.createExchange(actingSellerId(req.user), storeId, orderId, editActor(req), dto);
  }

  // ── Shopify order editing: Edit order, timeline comments, notes, shipping address ──
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.edit')
  @Post('edit/:storeId/:orderId')
  async editOrder(@Req() req: any, @Param('storeId') storeId: string, @Param('orderId') orderId: string, @Body() dto: EditOrderDto) {
    return this.orderEditing.editOrder(actingSellerId(req.user), storeId, orderId, editActor(req), dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.view')
  @Post('timeline/:storeId/:orderId')
  async addOrderComment(@Req() req: any, @Param('storeId') storeId: string, @Param('orderId') orderId: string, @Body() dto: OrderCommentDto) {
    return this.orderEditing.addComment(actingSellerId(req.user), storeId, orderId, editActor(req), dto.message);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.edit')
  @Patch('note/:storeId/:orderId')
  async updateOrderNote(@Req() req: any, @Param('storeId') storeId: string, @Param('orderId') orderId: string, @Body() dto: OrderNoteDto) {
    return this.orderEditing.updateNote(actingSellerId(req.user), storeId, orderId, editActor(req), dto.note);
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.edit')
  @Patch('shipping-address/:storeId/:orderId')
  async updateOrderShippingAddress(@Req() req: any, @Param('storeId') storeId: string, @Param('orderId') orderId: string, @Body() dto: OrderShippingAddressDto) {
    return this.orderEditing.updateShippingAddress(actingSellerId(req.user), storeId, orderId, editActor(req), dto);
  }

  // must be last — catches any GET /:orderId after all static routes
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get(':orderId')
  async getOrderById(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Query('storeId') storeIdQuery: string,
  ) {
    const { userId } = req.user;
    const storeId = resolveBuyerStoreScope(req.user.storeId, storeIdQuery);
    return this.ordersService.getOrderById(userId, orderId, storeId);
  }
}
