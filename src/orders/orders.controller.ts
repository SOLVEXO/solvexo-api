// import { Controller, Get, Put, Param, Req, UseGuards } from '@nestjs/common';
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
// import { RolesGuard } from '../auth/guards/roles.guard';
// import { OrdersService } from './orders.service';

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
  Param,
  Query,
  Body,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { OrdersService } from './orders.service';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { actingSellerId } from '../common/acting-seller-id.util';

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller', 'admin')
  @Put('mark-paid/:orderId')
  async markPaid(@Param('orderId') orderId: string) {
    return this.ordersService.markPaid(orderId);
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

  /** Real one-click "mark as shipped" via a live-purchased carrier label —
   *  see OrdersService.purchaseShippingLabel's own doc comment. */
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.buy_shipping_label')
  @Put('purchase-shipping-label')
  async purchaseShippingLabel(@Req() req: any, @Body() body: { orderId: string; storeId: string }) {
    return this.ordersService.purchaseShippingLabel(actingSellerId(req.user), body.orderId, body.storeId, req.ip, req.headers['user-agent']);
  }

  // Static path — must be declared before `seller-orders/:storeId` below, otherwise
  // that param route would swallow this literal segment as `storeId: 'my'`.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.view')
  @Get('seller-orders/my')
  async getMySellerOrders(@Req() req: any, @Query() query: any) {
    return this.ordersService.getSellerOrders(actingSellerId(req.user), null, query);
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
    @Body() body: { amount: number; reason?: string },
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
