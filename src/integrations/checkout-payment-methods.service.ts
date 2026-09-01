/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
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

    // Same-store items only, summed in that store's own bound currency —
    // never the buyer's separate checkout-currency preference, and never
    // converted. Matches the platform's PKR-in-Pakistan/USD-elsewhere rule:
    // one store, one currency, no FX involved in this path at all.
    const amount = (checkout.items ?? [])
      .filter((item: any) => item.storeId === storeId)
      .reduce((sum: number, item: any) => sum + item.totalPrice, 0);
    const currency = integration.provider === 'stripe' ? 'USD' : 'PKR';

    const session = await provider.initiatePayment(
      { orderId: checkoutId, amount, currency, storeId, returnUrl, cancelUrl },
      config,
    );

    return { success: true, data: session };
  }
}
