/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PaymentService } from '../payment/payment.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { toDecryptedPaymentConfig } from './integration-credentials.helper';
import { StoreIntegrationProvider } from './schemas/store-integration.schema';

/**
 * Buyer-facing payment-method resolution for checkout — Phase 2 design doc
 * §C. `storeId` is never trusted from a client-passed param: this whole
 * service resolves it server-side from the buyer's OWN checkout document
 * (`{_id: checkoutId, userId}`, the same ownership lookup every other
 * checkout endpoint in `checkout.service.ts` already uses), never the other
 * way around.
 *
 * Only single-store checkouts get the new per-store gateways. A checkout
 * can legitimately span multiple stores (see `CheckoutItem.storeId` /
 * `payment.service.ts`'s own `checkoutStoreIds` handling) — for those, one
 * payment intent can't cleanly route through N independent per-store
 * gateways, so this deliberately returns no new-gateway methods and leaves
 * them on the existing COD/manual-transfer/platform-Stripe checkout path
 * untouched. That's a real scope boundary, not an oversight — see the
 * accompanying phase report.
 */
@Injectable()
export class CheckoutPaymentMethodsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly registry: PaymentProviderRegistry,
    private readonly paymentService: PaymentService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  private async resolveSingleStoreCheckout(checkoutId: string, userId: string) {
    const checkout = await this.repos.checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
    if (!checkout) throw new NotFoundException('Checkout not found');
    const storeIds = [...new Set((checkout.items ?? []).map((item: any) => item.storeId))];
    return { checkout, storeId: storeIds.length === 1 ? (storeIds[0] as string) : null };
  }

  /** Same-store items only, in that store's own bound currency — see initiatePayment's own comment for why no FX applies here. */
  private storeAmount(checkout: any, storeId: string): number {
    return (checkout.items ?? [])
      .filter((item: any) => item.storeId === storeId)
      .reduce((sum: number, item: any) => sum + item.totalPrice, 0);
  }

  async listPaymentMethods(checkoutId: string, userId: string) {
    const { storeId } = await this.resolveSingleStoreCheckout(checkoutId, userId);
    if (!storeId) return { success: true, data: [] };

    const integrations = await this.repos.storeIntegrationModel.find({
      storeId,
      type: 'payment',
      status: 'connected',
      isEnabledForCheckout: true,
    });

    const methods = integrations
      .filter((integration) => this.registry.isSupported(integration.provider))
      .map((integration) => {
        const provider = this.registry.resolve(integration.provider);
        return { provider: integration.provider, ...provider.getPublicConfig(integration.config ?? {}) };
      });

    return { success: true, data: methods };
  }

  async initiatePayment(checkoutId: string, userId: string, providerKey: string, returnUrl: string, cancelUrl: string) {
    if (!returnUrl || !cancelUrl) {
      throw new BadRequestException('returnUrl and cancelUrl are required');
    }
    const { checkout, storeId } = await this.resolveSingleStoreCheckout(checkoutId, userId);
    if (!storeId) {
      throw new BadRequestException('This checkout spans multiple stores — use the existing checkout payment flow instead.');
    }

    const integration = await this.repos.storeIntegrationModel.findOne({
      storeId,
      type: 'payment',
      provider: providerKey as StoreIntegrationProvider,
      status: 'connected',
      isEnabledForCheckout: true,
    });
    if (!integration || !this.registry.isSupported(integration.provider)) {
      throw new BadRequestException(`"${providerKey}" is not an available payment method for this store`);
    }

    const provider = this.registry.resolve(integration.provider);
    const config = toDecryptedPaymentConfig(integration);
    const amount = this.storeAmount(checkout, storeId);
    const currency = integration.provider === 'stripe' ? 'USD' : 'PKR';

    const session = await provider.initiatePayment(
      { orderId: checkoutId, amount, currency, storeId, returnUrl, cancelUrl },
      config,
    );

    // The linkage record `PaymentService.finalizeGatewayPayment`/
    // `failGatewayPayment` looks up by `providerSessionId` once this
    // gateway's webhook reports an outcome — without this row, a
    // successful Safepay payment would have nowhere to attach a real Order
    // to (see PaymentWebhooksController's own doc comment on why this was
    // previously a no-op). Mirrors `PaymentService.initiatePayment`'s own
    // Stripe transaction-row shape.
    await this.repos.paymentTransactionModel.create({
      userId,
      checkoutId: checkout._id.toString(),
      paymentType: integration.provider,
      amount,
      currency,
      fxSnapshots: (checkout as any).fxSnapshots ?? [],
      paymentScope: 'full',
      status: 'pending',
      providerSessionId: session.sessionId,
    });

    return { success: true, data: session };
  }

  /**
   * Called after the buyer returns from a redirect-based gateway (or a
   * client-confirmed one like Stripe). `sessionId` comes from the client
   * (it's what `initiatePayment` handed back to it), but it is never trusted
   * on its own — this always re-asks the gateway itself what that session's
   * real status and amount are (`provider.verifyPayment`), and cross-checks
   * the confirmed amount against this checkout's own expected total before
   * ever creating an order, mirroring the exact safety net
   * `PaymentService.finalizePaymentIntent` already applies for Stripe. A
   * mismatched or unpaid session never creates an order.
   */
  async confirmPayment(checkoutId: string, userId: string, providerKey: string, sessionId: string) {
    if (!sessionId) throw new BadRequestException('sessionId is required');
    const { checkout, storeId } = await this.resolveSingleStoreCheckout(checkoutId, userId);
    if (!storeId) {
      throw new BadRequestException('This checkout spans multiple stores — use the existing checkout payment flow instead.');
    }

    const integration = await this.repos.storeIntegrationModel.findOne({
      storeId,
      type: 'payment',
      provider: providerKey as StoreIntegrationProvider,
      status: 'connected',
    });
    if (!integration || !this.registry.isSupported(integration.provider)) {
      throw new BadRequestException(`"${providerKey}" is not an available payment method for this store`);
    }

    if (checkout.status === 'completed') {
      const orders = await this.repos.orderModel.find({ checkoutId, isDelete: false });
      return { success: true, data: { status: 'completed', orderIds: orders.map((o: any) => String(o._id)) } };
    }

    const provider = this.registry.resolve(integration.provider);
    const config = toDecryptedPaymentConfig(integration);
    const paymentStatus = await provider.verifyPayment(sessionId, config);

    if (paymentStatus.status !== 'paid') {
      const terminalStatus = paymentStatus.status === 'refunded' ? 'failed' : paymentStatus.status;
      // Keep the PaymentTransaction row in sync however the buyer's app
      // learns of a failure — not just via the webhook — so it never sits
      // stuck at 'pending' forever (financial-reconciliation data must
      // reflect reality regardless of which path noticed first).
      if (terminalStatus === 'failed') {
        await this.paymentService.failGatewayPayment(sessionId, integration.provider, `Gateway reported status: ${paymentStatus.status}`);
      }
      return { success: true, data: { status: terminalStatus, orderIds: [] } };
    }

    const expectedAmount = this.storeAmount(checkout, storeId);
    if (typeof paymentStatus.amount === 'number' && Math.abs(paymentStatus.amount - expectedAmount) > 0.01) {
      await this.activityLogService.log({
        storeId,
        category: 'integrations',
        action: 'integration.payment_amount_mismatch',
        description: `${integration.provider} confirmed ${paymentStatus.amount} ${paymentStatus.currency} but checkout ${checkoutId} expected ${expectedAmount} — order NOT created, needs manual review`,
        actorId: 'system',
        actorRole: 'system',
        isSecurityAlert: true,
        targetId: checkoutId,
        targetType: 'checkout',
      });
      throw new BadRequestException('Payment amount mismatch — this charge requires manual review');
    }

    // Unified onto the same session-keyed finalize path the webhook uses
    // (PaymentWebhooksController) rather than a second, divergent one — see
    // Phase-review fix notes: the buyer-app confirm call fires faster than
    // the webhook in practice, so this MUST be the same method that also
    // completes the PaymentTransaction row, or that row is left orphaned at
    // 'pending' forever whenever this path wins the race (the common case).
    const result = await this.paymentService.finalizeGatewayPayment(sessionId, integration.provider);
    return { success: true, data: { status: 'completed', orderIds: result?.orderIds ?? [] } };
  }
}
