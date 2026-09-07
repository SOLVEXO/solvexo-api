/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Headers, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { RawBodyRequest } from '@nestjs/common';
import { DatabaseService } from '../../database/databaseservice';
import { PaymentProviderRegistry } from '../payment-provider.registry';
import { IntegrationWebhookEventService } from '../integration-webhook-event.service';
import { toDecryptedPaymentConfig } from '../integration-credentials.helper';
import { PaymentService } from '../../payment/payment.service';

/**
 * Inbound gateway webhooks for the Pakistani payment providers (Safepay,
 * and JazzCash/Easypaisa/PayFast once added) — Stripe deliberately excluded,
 * see `StripePaymentProvider`'s class doc for why it stays on the existing
 * platform-wide webhook endpoint instead.
 *
 * Store attribution is via the opaque `webhookToken` in the URL, NOT
 * anything in the payload — an unknown token means nothing is routed here
 * at all (404 before any signature check even runs). The provider's own
 * signature is still verified against that exact store's stored secret
 * before the payload is trusted, so a replay against the wrong store's URL
 * fails at the lookup, and a replay against the right store's URL fails
 * idempotency instead of reprocessing. See Phase 2 design doc §D.
 */
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly registry: PaymentProviderRegistry,
    private readonly webhookEvents: IntegrationWebhookEventService,
    private readonly paymentService: PaymentService,
  ) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':provider/:webhookToken')
  async handle(
    @Param('provider') provider: string,
    @Param('webhookToken') webhookToken: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException('Raw request body unavailable — check rawBody bootstrap config');
    }

    const integration = await this.databaseService.repositories.storeIntegrationModel.findOne({
      provider,
      webhookToken,
      type: 'payment',
    });
    if (!integration) {
      // Unknown token: nothing to route to, and nothing about the payload
      // is trusted enough to say more than that — don't distinguish "wrong
      // provider" from "wrong token" from "disabled integration".
      throw new NotFoundException();
    }

    if (!this.registry.isSupported(integration.provider)) {
      throw new BadRequestException('Unsupported provider');
    }
    const providerImpl = this.registry.resolve(integration.provider);
    const config = toDecryptedPaymentConfig(integration);

    let event;
    try {
      event = await providerImpl.handleWebhook(req.rawBody, headers, config);
    } catch (err: any) {
      // Signature mismatch, malformed payload, etc. — a client (gateway)
      // error, never a 500, and never echo internal details back out.
      throw new BadRequestException(`Webhook rejected: ${err?.message ?? 'verification failed'}`);
    }

    const isNew = await this.webhookEvents.recordOnce(provider, event.externalEventId, integration.storeId);
    if (!isNew) {
      return { received: true, duplicate: true };
    }

    // Turns this event into a real Order (payment_succeeded) or leaves the
    // checkout open for a retry (payment_failed) — see
    // `PaymentService.finalizeGatewayPayment`/`failGatewayPayment`'s own doc
    // comments. Refund events aren't wired to anything yet (no seller-ledger
    // reversal path exists for a Connect-less generic gateway today) —
    // deliberately left as dedup-only, same as before, rather than silently
    // pretending to handle a case nothing downstream can act on.
    if (event.type === 'payment_succeeded') {
      await this.paymentService.finalizeGatewayPayment(event.sessionId, integration.provider);
    } else if (event.type === 'payment_failed') {
      await this.paymentService.failGatewayPayment(event.sessionId, integration.provider, JSON.stringify(event.status?.raw ?? {}).slice(0, 300));
    }

    return { received: true };
  }
}
