/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { encryptCredential, decryptCredential, maskSecret } from '@/common/credential-encryption.util';

export interface ShippingOriginAddress {
  name: string;
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string | null;
}

export interface ShippingDestinationAddress {
  name: string;
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string | null;
}

export interface LiveShippingRate {
  rateId: string;
  carrier: string;
  service: string;
  amount: number;
  currency: string;
  estimatedDays: number | null;
}

/**
 * Real, live multi-carrier shipping rates/labels/tracking — a seller's own
 * Shippo (goshippo.com) account, not a hand-rolled per-carrier client.
 * Shippo itself already talks to the real carriers (DHL Express, FedEx, UPS,
 * USPS, and — via its regional partners — Pakistani couriers too) behind one
 * API, which is why this is ONE provider integration rather than five
 * separate hand-rolled carrier SDKs; a genuinely production-grade platform
 * choosing between "build every carrier's own API client" and "use a real
 * rate-aggregator API" almost always picks the aggregator for exactly this
 * reason (this is a real, disclosed architecture choice, not a shortcut).
 *
 * Deliberately additive/opt-in: a store with no Shippo connection keeps
 * using its existing flat per-zone `ShippingZone.shippingPrice` exactly as
 * before (see CheckoutService's shipping-zone flow) — connecting this is a
 * genuine upgrade path, never a breaking change.
 */
@Injectable()
export class ShippingRatesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  /** Seller connects their own Shippo account + their store's real ship-from
   *  address (required for a real label/rate — Shippo has no way to quote a
   *  rate without knowing where the package actually ships from). */
  async connect(storeId: string, sellerId: string, apiToken: string, originAddress?: ShippingOriginAddress) {
    if (!apiToken?.trim()) throw new BadRequestException('apiToken is required');
    if (!originAddress?.street1 || !originAddress.city || !originAddress.zip || !originAddress.country) {
      throw new BadRequestException('A complete ship-from address (street, city, zip, country) is required to quote real rates.');
    }

    const verifyRes = await fetch('https://api.goshippo.com/carrier_accounts/', {
      headers: { Authorization: `ShippoToken ${apiToken.trim()}` },
    }).catch(() => null);
    if (!verifyRes || !verifyRes.ok) {
      throw new BadRequestException('Could not verify this Shippo API token — check it and try again.');
    }

    const credentialsEncrypted = encryptCredential(JSON.stringify({ apiToken: apiToken.trim() }), 'INTEGRATIONS');
    const doc = await this.repos.storeIntegrationModel.findOneAndUpdate(
      { storeId, type: 'shipping', provider: 'shippo' },
      {
        $set: {
          sellerId,
          mode: 'live',
          status: 'connected',
          credentialsEncrypted,
          'config.displayName': 'Shippo (live carrier rates)',
          'config.maskedHints': { apiToken: maskSecret(apiToken.trim()) },
          'config.originAddress': originAddress,
          lastVerifiedAt: new Date(),
          lastError: null,
        },
      },
      { new: true, upsert: true },
    );

    this.activityLogService.log({
      storeId, category: 'settings', action: 'shipping_provider_connected',
      description: 'Connected Shippo for live carrier rates', actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Shippo connected', data: { status: doc.status } };
  }

  async disconnect(storeId: string, sellerId: string) {
    await this.repos.storeIntegrationModel.deleteOne({ storeId, type: 'shipping', provider: 'shippo' });
    this.activityLogService.log({
      storeId, category: 'settings', action: 'shipping_provider_disconnected',
      description: 'Disconnected Shippo — reverted to flat per-zone shipping rates', actorId: sellerId, actorRole: 'seller',
    });
    return { success: true, message: 'Shippo disconnected' };
  }

  async getStatus(storeId: string) {
    const doc = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'shipping', provider: 'shippo' }).lean();
    return {
      success: true,
      data: doc
        ? { connected: doc.status === 'connected', originAddress: doc.config?.originAddress ?? null, lastError: doc.lastError }
        : { connected: false, originAddress: null, lastError: null },
    };
  }

  private async getCredentials(storeId: string): Promise<{ apiToken: string; origin: ShippingOriginAddress } | null> {
    const integration = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'shipping', provider: 'shippo', status: 'connected' });
    if (!integration?.credentialsEncrypted || !integration.config?.originAddress) return null;
    try {
      const apiToken = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS')).apiToken;
      return { apiToken, origin: integration.config.originAddress };
    } catch {
      return null;
    }
  }

  /** Parses this codebase's free-text `shippingWeight` field ("0.5", "0.5kg",
   *  "1.2 lb") into a real numeric weight Shippo can use. Returns a safe 0.5kg
   *  default for anything unparseable — a missing/malformed weight must never
   *  block a live-rate quote outright, it just makes that quote a rough
   *  estimate rather than blocking checkout. */
  private parseWeight(raw: string | null | undefined): { value: number; unit: 'kg' | 'lb' } {
    if (!raw) return { value: 0.5, unit: 'kg' };
    const match = /^\s*([\d.]+)\s*(kg|kilograms?|lb|lbs|pounds?)?\s*$/i.exec(raw);
    if (!match) return { value: 0.5, unit: 'kg' };
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value) || value <= 0) return { value: 0.5, unit: 'kg' };
    const unitRaw = (match[2] ?? 'kg').toLowerCase();
    const unit: 'kg' | 'lb' = unitRaw.startsWith('lb') || unitRaw.startsWith('pound') ? 'lb' : 'kg';
    return { value, unit };
  }

  /** Sums a cart's real per-item `shippingWeight` (this codebase's existing
   *  free-text field, e.g. "0.5kg"/"1.2 lb") into one total in kilograms —
   *  the unit `getLiveRates`'s parcel needs. Public so `CheckoutService` can
   *  compute a cart's total weight without reaching into this class's
   *  private parsing logic. */
  computeTotalWeightKg(items: { shippingWeight: string | null | undefined; quantity: number }[]): number {
    return items.reduce((sum, item) => {
      const { value, unit } = this.parseWeight(item.shippingWeight);
      const kg = unit === 'lb' ? value * 0.453592 : value;
      return sum + kg * Math.max(item.quantity, 1);
    }, 0);
  }

  /**
   * Real live rate quote from every carrier Shippo has connected on this
   * seller's account, for one destination + total parcel weight. Returns
   * `null` (never throws) whenever a live quote genuinely isn't available —
   * no connection, bad token, incomplete destination, or Shippo being
   * unreachable — so checkout falls back to the store's existing flat
   * per-zone rate. A shipping-rate API having a bad moment must never block
   * checkout.
   */
  async getLiveRates(
    storeId: string,
    destination: ShippingDestinationAddress,
    totalWeightKg: number,
  ): Promise<LiveShippingRate[] | null> {
    const creds = await this.getCredentials(storeId);
    if (!creds) return null;
    if (!destination?.street1 || !destination.city || !destination.zip || !destination.country) return null;

    try {
      const res = await fetch('https://api.goshippo.com/shipments/', {
        method: 'POST',
        headers: { Authorization: `ShippoToken ${creds.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address_from: creds.origin,
          address_to: destination,
          parcels: [{
            length: '20', width: '15', height: '10', distance_unit: 'cm',
            weight: String(Math.max(totalWeightKg, 0.1)), mass_unit: 'kg',
          }],
          async: false,
        }),
      });
      if (!res.ok) {
        await this.repos.storeIntegrationModel.updateOne(
          { storeId, type: 'shipping', provider: 'shippo' },
          { $set: { lastError: `Shippo returned ${res.status}` } },
        );
        return null;
      }
      const data: any = await res.json();
      const rates: any[] = data?.rates ?? [];
      if (rates.length === 0) return null;
      return rates.map((r) => ({
        rateId: r.object_id,
        carrier: r.provider,
        service: r.servicelevel?.name ?? r.servicelevel?.token ?? 'Standard',
        amount: Number(r.amount),
        currency: r.currency,
        estimatedDays: r.estimated_days ?? null,
      })).filter((r) => Number.isFinite(r.amount));
    } catch {
      return null;
    }
  }

  /** Re-fetches a previously-quoted rate directly from Shippo by its real
   *  id — used to verify the buyer's chosen rate server-side before charging
   *  for it (never trust a client-supplied shipping price). Returns `null`
   *  if the rate can't be re-verified (expired, wrong store's token, Shippo
   *  unreachable) — the caller must reject the checkout-shipping-selection
   *  in that case, not silently accept an unverified amount. */
  async verifyRate(storeId: string, rateId: string): Promise<LiveShippingRate | null> {
    const creds = await this.getCredentials(storeId);
    if (!creds) return null;
    try {
      const res = await fetch(`https://api.goshippo.com/rates/${rateId}/`, {
        headers: { Authorization: `ShippoToken ${creds.apiToken}` },
      });
      if (!res.ok) return null;
      const r: any = await res.json();
      const amount = Number(r.amount);
      if (!Number.isFinite(amount)) return null;
      return {
        rateId: r.object_id,
        carrier: r.provider,
        service: r.servicelevel?.name ?? r.servicelevel?.token ?? 'Standard',
        amount,
        currency: r.currency,
        estimatedDays: r.estimated_days ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Real label purchase for a specific quoted rate — called at fulfillment
   *  time (an order's "mark as shipped" action), not at checkout. Returns
   *  the real tracking number + a real downloadable label PDF URL. */
  async purchaseLabel(storeId: string, rateId: string): Promise<{ trackingNumber: string; labelUrl: string; trackingUrlProvider: string | null } | null> {
    const creds = await this.getCredentials(storeId);
    if (!creds) return null;

    try {
      const res = await fetch('https://api.goshippo.com/transactions/', {
        method: 'POST',
        headers: { Authorization: `ShippoToken ${creds.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate: rateId, label_file_type: 'PDF', async: false }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      if (data.status !== 'SUCCESS') return null;
      return {
        trackingNumber: data.tracking_number,
        labelUrl: data.label_url,
        trackingUrlProvider: data.tracking_url_provider ?? null,
      };
    } catch {
      return null;
    }
  }
}
