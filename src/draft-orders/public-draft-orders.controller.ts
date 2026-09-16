/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DraftOrdersService } from './draft-orders.service';

/** Public, unauthenticated "Pay Invoice" surface — token-secured (never the
 *  raw draft order id), reachable from the email link `sendInvoice()`
 *  sends. See DraftOrdersService's invoice methods for the real Stripe/
 *  finalization logic. */
@Controller('api/public/draft-orders/invoice')
export class PublicDraftOrdersController {
  constructor(private readonly draftOrdersService: DraftOrdersService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  async getInvoice(@Param('token') token: string) {
    const data = await this.draftOrdersService.getPublicInvoice(token);
    return { success: true, data };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token/create-payment-intent')
  async createPaymentIntent(@Param('token') token: string) {
    const data = await this.draftOrdersService.createInvoicePaymentIntent(token);
    return { success: true, data };
  }
}
