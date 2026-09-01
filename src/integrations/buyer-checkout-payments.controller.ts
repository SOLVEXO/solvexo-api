/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { CheckoutPaymentMethodsService } from './checkout-payment-methods.service';

/**
 * Buyer-facing payment-method listing + initiation for the NEW per-store
 * gateways (Safepay et al, Stripe-via-Connect). Keyed by `:checkoutId`, not
 * `:storeId` — see `CheckoutPaymentMethodsService`'s class doc for why that
 * follows this codebase's existing checkout-endpoint convention and is the
 * safer read of "don't trust a client-passed storeId".
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@Controller('api/checkout/:checkoutId/payment-methods')
export class BuyerCheckoutPaymentsController {
  constructor(private readonly service: CheckoutPaymentMethodsService) {}

  @Get()
  list(@Param('checkoutId') checkoutId: string, @Req() req: any) {
    return this.service.listPaymentMethods(checkoutId, req.user.userId);
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post(':provider/initiate')
  initiate(
    @Param('checkoutId') checkoutId: string,
    @Param('provider') provider: string,
    @Body() body: { returnUrl: string; cancelUrl: string },
    @Req() req: any,
  ) {
    return this.service.initiatePayment(checkoutId, req.user.userId, provider, body?.returnUrl, body?.cancelUrl);
  }
}
