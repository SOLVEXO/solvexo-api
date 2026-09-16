import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  Headers,
  UseGuards,
  UseInterceptors,
  RawBodyRequest,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { actingSellerId } from '../common/acting-seller-id.util';
import { PaymentService } from './payment.service';

@Controller('api/payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // Idempotency-Key protection (previously missing) — a double-tap/retry
  // must never place two separate orders for the same buyer action.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('cod-payment')
  async codPayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentService.codPayment(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('initiate-payment')
  async initiatePayment(@Req() req: any, @Body() body: any) {
    const { userId } = req.user;
    return this.paymentService.initiatePayment(userId, body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('status')
  async getPaymentStatus(
    @Req() req: any,
    @Query('checkoutId') checkoutId: string,
  ) {
    const { userId } = req.user;
    return this.paymentService.getPaymentStatus(userId, checkoutId);
  }

  // Seller-facing "Needs Attention" signal — real open-dispute count backed
  // by real Stripe dispute-status tracking (see PaymentService.getOpenDisputeCount).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('disputes/:storeId/open-count')
  async getOpenDisputeCount(@Req() req: any, @Param('storeId') storeId: string) {
    const count = await this.paymentService.getOpenDisputeCount(storeId, req.user.userId);
    return { success: true, data: { count } };
  }

  // Real disputes list/detail view — closes the audit's disclosed gap
  // ("only an open-count is shown; no detail/evidence UI").
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.disputes_manage')
  @Get('disputes/:storeId')
  async listDisputes(@Req() req: any, @Param('storeId') storeId: string, @Query('status') status?: string) {
    const disputes = await this.paymentService.listDisputes(storeId, actingSellerId(req.user), status);
    return { success: true, data: disputes };
  }

  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'admin', 'staff')
  @RequirePermission('orders.disputes_manage')
  @Post('disputes/:storeId/:disputeId/evidence')
  async submitDisputeEvidence(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('disputeId') disputeId: string,
    @Body() body: { productDescription?: string; customerCommunication?: string; shippingDocumentation?: string; uncategorizedText?: string },
  ) {
    return this.paymentService.submitDisputeEvidence(storeId, actingSellerId(req.user), disputeId, body);
  }

  // Mirrors Shopify Home's "Review high-risk orders" order task — real
  // Stripe Radar fraud-risk signal, see PaymentService.getHighRiskOrderCount.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('risk-orders/:storeId/open-count')
  async getHighRiskOrderCount(@Req() req: any, @Param('storeId') storeId: string) {
    const count = await this.paymentService.getHighRiskOrderCount(storeId, req.user.userId);
    return { success: true, data: { count } };
  }

  // Real "Capture Payment" action for a manual-capture store's authorized
  // order — mirrors Shopify's own order-page "Capture Payment" button.
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.capture_payment')
  @Post('orders/:orderId/capture')
  async captureOrderPayment(@Req() req: any, @Param('orderId') orderId: string, @Body() body: { amountToCapture?: number }) {
    const data = await this.paymentService.captureOrderPayment(actingSellerId(req.user), orderId, body?.amountToCapture);
    return { success: true, data };
  }

  // Real count of orders still awaiting capture, for the store dashboard's
  // "Needs Attention" card.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('orders/:storeId/awaiting-capture-count')
  async getAwaitingCaptureCount(@Req() req: any, @Param('storeId') storeId: string) {
    const count = await this.paymentService.getAwaitingCaptureCount(storeId, req.user.userId);
    return { success: true, data: { count } };
  }

  // Stripe calls this directly — no bearer token, trust is the HMAC
  // signature verified in the service via the raw request body.
  @Post('stripe-webhook')
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException(
        'Raw request body unavailable — check rawBody bootstrap config',
      );
    }
    return this.paymentService.stripeWebhook(req.rawBody, signature);
  }
}
