/* eslint-disable prettier/prettier */
import { BadRequestException, Controller, Get, Headers, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
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
    // PayFast's IPN is a GET: its parameters are the query string, which is what its validation_hash covers.
    const rawBody: Buffer | undefined =
      req.method === 'GET' ? Buffer.from(String(req.originalUrl ?? '').split('?')[1] ?? '') : req.rawBody;
    if (!rawBody) {
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
      event = await providerImpl.handleWebhook(rawBody, headers, config);
    } catch (err: any) {
      // Signature mismatch, malformed payload, etc. — a client (gateway)
      // error, never a 500, and never echo internal details back out.
      throw new BadRequestException(`Webhook rejected: ${err?.message ?? 'verification failed'}`);
    }

    // Non-terminal state: acknowledge so the gateway stops retrying, but do
    // not record it for dedup (the same tracker will later send its terminal
    // event) and do not finalize anything.
    if (event.type === 'payment_pending') {
      return { received: true, ignored: 'pending' };
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
    try {
      if (event.type === 'payment_succeeded') {
        // Never trust the (signed) event body alone for money: re-ask the
        // gateway for the session's real state + amount, and cross-check it
        // against the amount we charged at initiate and against THIS store
        // (a seller could otherwise sign an event with their OWN secret for
        // another store's session id).
        // Gateways whose signed callback already carries the proof (JazzCash signs amount+status; no usable
        // inquiry for PayFast) are trusted through the verified event itself — see PaymentProvider.callbackIsAuthoritative.
        const verified = providerImpl.callbackIsAuthoritative
          ? event.status
          : await providerImpl.verifyPayment(event.sessionId, config);
        if (verified.status !== 'paid') {
          throw new BadRequestException('Gateway does not confirm this payment as paid');
        }
        await this.paymentService.assertGatewayPaymentMatches({
          providerSessionId: event.sessionId,
          paymentType: integration.provider,
          storeId: integration.storeId,
          paidAmount: verified.amount,
          paidCurrency: verified.currency,
        });
        await this.paymentService.finalizeGatewayPayment(event.sessionId, integration.provider);
      } else if (event.type === 'payment_failed') {
        await this.paymentService.failGatewayPayment(event.sessionId, integration.provider, JSON.stringify(event.status?.raw ?? {}).slice(0, 300));
      }
    } catch (err) {
      // Processing failed AFTER the event was recorded — un-record it so the
      // gateway's retry is processed instead of being dropped as a duplicate.
      await this.webhookEvents.forget(provider, event.externalEventId).catch(() => undefined);
      throw err;
    }

    return { received: true };
  }

  /** PayFast-style IPN delivered as a GET (parameters in the query string). */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(':provider/:webhookToken')
  handleGet(
    @Param('provider') provider: string,
    @Param('webhookToken') webhookToken: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ) {
    return this.handle(provider, webhookToken, req, headers);
  }

  /**
   * Browser return of a gateway that POSTs its signed result to us instead of a storefront page (JazzCash
   * `pp_ReturnURL`). The result is processed exactly like a webhook (same verification, dedup, finalize), then
   * the buyer is sent on to the storefront return page stored when the payment started. That page then asks
   * `/confirm` for the real outcome — nothing about this redirect is proof of payment.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':provider/:webhookToken/return')
  async handleReturn(
    @Param('provider') provider: string,
    @Param('webhookToken') webhookToken: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
    @Res() res: Response,
  ) {
    const repos = this.databaseService.repositories;
    const integration = await repos.storeIntegrationModel.findOne({ provider, webhookToken, type: 'payment' });
    if (!integration) throw new NotFoundException();

    let sessionId: string | undefined;
    try {
      const fields = new URLSearchParams(req.rawBody?.toString('utf8') ?? '');
      sessionId = fields.get('pp_TxnRefNo') ?? fields.get('basket_id') ?? undefined;
      await this.handle(provider, webhookToken, req, headers);
    } catch {
      // Verification/processing problems are never shown on this hop — the storefront return page asks /confirm.
    }
    const txn = sessionId
      ? await repos.paymentTransactionModel
          .findOne({ providerSessionId: sessionId, paymentType: provider, isDelete: false })
          .select('returnUrl')
          .lean()
      : null;
    const target = String((txn as any)?.returnUrl ?? '');
    if (!/^https?:\/\//i.test(target)) {
      return res.status(400).send('Payment result received. You can close this page and return to the store.');
    }
    return res.redirect(303, target);
  }
}
