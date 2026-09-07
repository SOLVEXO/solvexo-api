/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { encryptCredential, decryptCredential, maskSecret } from '@/common/credential-encryption.util';

/**
 * Real, live, per-country tax calculation — a seller's own TaxJar account
 * (https://www.taxjar.com), not a hand-rolled rate table. TaxJar itself
 * maintains the real, current US state/local sales-tax rules (nexus,
 * category exemptions, etc.) and real EU/UK/Canada/Australia VAT/GST rates —
 * Solvexo just calls their API with the real order + destination address.
 *
 * Deliberately additive/opt-in, never a required step: a store with no
 * TaxJar connection keeps using its existing flat `Store.taxRate` percentage
 * exactly as before (see CheckoutService.createCheckout's tax block) — this
 * is a genuine upgrade path, not a breaking change to every store overnight.
 *
 * Only one real provider (TaxJar) is wired. Avalara is a legitimate
 * alternative for a larger seller, but its AvaTax API needs a company/
 * "company code" concept TaxJar doesn't, which would need its own request
 * shape — left as a disclosed, separate follow-up rather than half-built
 * here (`STORE_INTEGRATION_PROVIDERS` already reserves room for it once a
 * seller actually asks for it).
 */
@Injectable()
export class TaxService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  /** Seller connects their own TaxJar account — POST .../integrations/tax/connect */
  async connect(storeId: string, sellerId: string, apiToken: string) {
    if (!apiToken?.trim()) throw new BadRequestException('apiToken is required');

    // Verify the token actually works before saving it — a wrong/expired
    // token would otherwise silently fail open (falls back to the flat rate)
    // on every real checkout with no visible error until a seller notices
    // their tax line looks wrong.
    const verifyRes = await fetch('https://api.taxjar.com/v2/categories', {
      headers: { Authorization: `Bearer ${apiToken.trim()}` },
    }).catch(() => null);
    if (!verifyRes || !verifyRes.ok) {
      throw new BadRequestException('Could not verify this TaxJar API token — check it and try again.');
    }

    const credentialsEncrypted = encryptCredential(JSON.stringify({ apiToken: apiToken.trim() }), 'INTEGRATIONS');
    const doc = await this.repos.storeIntegrationModel.findOneAndUpdate(
      { storeId, type: 'tax', provider: 'taxjar' },
      {
        $set: {
          sellerId,
          mode: 'live',
          status: 'connected',
          credentialsEncrypted,
          'config.displayName': 'TaxJar',
          'config.maskedHints': { apiToken: maskSecret(apiToken.trim()) },
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      },
      { new: true, upsert: true },
    );

    this.activityLogService.log({
      storeId, category: 'settings', action: 'tax_provider_connected',
      description: 'Connected TaxJar for live tax calculation', actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'TaxJar connected', data: { status: doc.status } };
  }

  async disconnect(storeId: string, sellerId: string) {
    await this.repos.storeIntegrationModel.deleteOne({ storeId, type: 'tax', provider: 'taxjar' });
    this.activityLogService.log({
      storeId, category: 'settings', action: 'tax_provider_disconnected',
      description: 'Disconnected TaxJar — reverted to the flat store tax rate', actorId: sellerId, actorRole: 'seller',
    });
    return { success: true, message: 'TaxJar disconnected' };
  }

  async getStatus(storeId: string) {
    const doc = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'tax', provider: 'taxjar' }).lean();
    return {
      success: true,
      data: doc
        ? { connected: doc.status === 'connected', maskedHints: doc.config?.maskedHints ?? {}, lastError: doc.lastError }
        : { connected: false, maskedHints: {}, lastError: null },
    };
  }

  /**
   * Real live tax quote for one store's line items in one checkout, via that
   * store's own connected TaxJar account. Returns `null` (not a thrown
   * error) whenever live calculation genuinely isn't available — no
   * connection, no destination country, a bad/expired token, or TaxJar being
   * unreachable — so the caller can fall back to the flat rate. Checkout
   * must never hard-fail because a third-party tax API had a bad moment.
   */
  async calculateLiveTax(
    storeId: string,
    params: { amount: number; shipping: number; toCountry: string | null; toState?: string | null; toZip?: string | null; toCity?: string | null },
  ): Promise<{ taxAmount: number; rate: number } | null> {
    if (!params.toCountry) return null;

    const integration = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'tax', provider: 'taxjar', status: 'connected' });
    if (!integration?.credentialsEncrypted) return null;

    const store = await this.repos.storeModel.findById(storeId).select('country').lean();

    let apiToken: string;
    try {
      apiToken = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS')).apiToken;
    } catch {
      return null;
    }

    try {
      const res = await fetch('https://api.taxjar.com/v2/taxes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: params.amount,
          shipping: params.shipping,
          from_country: (store as any)?.country ?? undefined,
          to_country: params.toCountry,
          to_state: params.toState ?? undefined,
          to_zip: params.toZip ?? undefined,
          to_city: params.toCity ?? undefined,
        }),
      });
      if (!res.ok) {
        await this.repos.storeIntegrationModel.updateOne(
          { storeId, type: 'tax', provider: 'taxjar' },
          { $set: { lastError: `TaxJar returned ${res.status}` } },
        );
        return null;
      }
      const data: any = await res.json();
      const taxAmount = Number(data?.tax?.amount_to_collect ?? 0);
      const rate = Number(data?.tax?.rate ?? 0);
      if (!Number.isFinite(taxAmount)) return null;
      return { taxAmount, rate };
    } catch {
      return null;
    }
  }
}
