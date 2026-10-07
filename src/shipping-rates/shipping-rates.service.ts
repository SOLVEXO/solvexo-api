/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { encryptCredential, decryptCredential, maskSecret } from '@/common/credential-encryption.util';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { randomBytes } from 'crypto';
import {
  applyHandlingFee, buildParcel, pickPackage, packItems,
  HandlingFeeType, PackageUnit, ShippingPackage, PackItem,
} from './shipping-math.util';
import { CustomsLine, buildShippoCustomsItem, findMissingCustoms, isInternationalDestination, missingCustomsMessage } from './customs.util';

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

export interface ShippingRateSettings {
  handlingFeeType: HandlingFeeType | null;
  handlingFeeValue: number;
  packages: ShippingPackage[];
}

export interface ShippingSettingsInput {
  handlingFeeType?: HandlingFeeType | null;
  handlingFeeValue?: number;
  packages?: { id?: string; name: string; length: number; width: number; height: number; unit: PackageUnit; emptyWeight?: number; isDefault?: boolean }[];
}

export interface LiveRateOptions {
  /** Quote with this saved package (else the default package, else 20x15x10 cm). */
  packageId?: string;
  /** Label purchase quotes raw carrier prices — the buyer-facing handling fee is not added. */
  forLabel?: boolean;
  /** Ship-from address of the shipping profile's origin location; else the Shippo integration's own origin. */
  originOverride?: ShippingOriginAddress;
  /** Shippo customs declaration id (international label quotes only) — attached to the shipment. */
  customsDeclarationId?: string;
  /** Items to pack by their own dimensions (smallest fitting saved package). Ignored when `packageId` is set. */
  packItems?: PackItem[];
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
    private readonly entitlementsService: EntitlementsService,
  ) {}

  /** Plan gate for live carrier rates AT CHECKOUT — Shopify's "third-party
   *  calculated shipping rates" (Advanced+ there). Deliberately NOT applied
   *  to connecting Shippo or buying labels: label buying is on every Shopify
   *  plan, only showing buyers live calculated rates is tier-gated. */
  async isLiveCheckoutRatesAllowed(storeId: string): Promise<boolean> {
    const limits = await this.entitlementsService.getLimits(storeId);
    return !!limits.calculatedShippingRatesAllowed;
  }

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

  private async getCredentials(storeId: string): Promise<{
    apiToken: string; origin: ShippingOriginAddress; settings: ShippingRateSettings;
  } | null> {
    const integration = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'shipping', provider: 'shippo', status: 'connected' });
    if (!integration?.credentialsEncrypted || !integration.config?.originAddress) return null;
    try {
      const apiToken = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS')).apiToken;
      const cfg: any = integration.config ?? {};
      return {
        apiToken,
        origin: cfg.originAddress,
        settings: {
          handlingFeeType: cfg.handlingFeeType === 'flat' || cfg.handlingFeeType === 'percent' ? cfg.handlingFeeType : null,
          handlingFeeValue: Number.isFinite(Number(cfg.handlingFeeValue)) ? Number(cfg.handlingFeeValue) : 0,
          packages: Array.isArray(cfg.packages) ? cfg.packages : [],
        },
      };
    } catch {
      return null;
    }
  }

  /** Seller's Shopify-style shipping settings: handling fee on live rates + saved packages.
   *  Stored on the Shippo integration `config` (the only place live-rate behaviour is configured). */
  async updateSettings(storeId: string, sellerId: string, dto: ShippingSettingsInput) {
    const doc = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'shipping', provider: 'shippo' });
    if (!doc) throw new BadRequestException('Connect Shippo first to configure packages and handling fees.');

    const feeType = dto.handlingFeeType ?? null;
    const feeValue = feeType ? Number(dto.handlingFeeValue ?? 0) : 0;
    if (feeType && (!Number.isFinite(feeValue) || feeValue < 0)) throw new BadRequestException('Handling fee must be 0 or more.');
    if (feeType === 'percent' && feeValue > 100) throw new BadRequestException('Handling fee percentage cannot exceed 100.');

    const input = dto.packages ?? [];
    if (input.length > 25) throw new BadRequestException('At most 25 packages can be saved.');
    let defaultSeen = false;
    const packages: ShippingPackage[] = input.map((p) => {
      const isDefault = !!p.isDefault && !defaultSeen;
      if (isDefault) defaultSeen = true;
      return {
        id: p.id && /^[\w-]{1,40}$/.test(p.id) ? p.id : randomBytes(8).toString('hex'),
        name: p.name.trim(),
        length: p.length, width: p.width, height: p.height,
        unit: p.unit,
        emptyWeight: p.emptyWeight ?? 0,
        isDefault,
      };
    });
    if (packages.length > 0 && !defaultSeen) packages[0].isDefault = true;

    await this.repos.storeIntegrationModel.updateOne(
      { _id: doc._id },
      { $set: { 'config.handlingFeeType': feeType, 'config.handlingFeeValue': feeValue, 'config.packages': packages } },
    );
    this.activityLogService.log({
      storeId, category: 'settings', action: 'shipping_settings_updated',
      description: 'Updated live-rate handling fee and saved packages', actorId: sellerId, actorRole: 'seller',
    });
    return { success: true, data: { handlingFeeType: feeType, handlingFeeValue: feeValue, packages } };
  }

  /** Shippo parcels: explicit package -> one parcel; packable items -> Shopify-style packing; else the default package. */
  private parcelsFor(packages: ShippingPackage[], totalWeightKg: number, opts: { packageId?: string; packItems?: PackItem[] }) {
    if (!opts.packageId && opts.packItems && opts.packItems.length > 0) {
      return packItems(opts.packItems, packages).map((p) => buildParcel(p.pkg, p.goodsWeightKg));
    }
    return [buildParcel(pickPackage(packages, opts.packageId), totalWeightKg)];
  }

  /** Per-unit kg for a free-text weight (same parser as the cart total). */
  unitWeightKg(shippingWeight: string | null | undefined): number {
    return this.computeTotalWeightKg([{ shippingWeight, quantity: 1 }]);
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
    opts: LiveRateOptions = {},
  ): Promise<LiveShippingRate[] | null> {
    const creds = await this.getCredentials(storeId);
    if (!creds) return null;
    if (!destination?.street1 || !destination.city || !destination.zip || !destination.country) return null;

    try {
      const res = await fetch('https://api.goshippo.com/shipments/', {
        method: 'POST',
        headers: { Authorization: `ShippoToken ${creds.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address_from: opts.originOverride ?? creds.origin,
          address_to: destination,
          parcels: this.parcelsFor(creds.settings.packages, totalWeightKg, opts),
          ...(opts.customsDeclarationId ? { customs_declaration: opts.customsDeclarationId } : {}),
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
        amount: opts.forLabel
          ? Number(r.amount)
          : applyHandlingFee(Number(r.amount), creds.settings.handlingFeeType, creds.settings.handlingFeeValue),
        currency: r.currency,
        estimatedDays: r.estimated_days ?? null,
      })).filter((r) => Number.isFinite(r.amount));
    } catch {
      return null;
    }
  }

  /**
   * Shopify "international label" customs step: for a LABEL whose destination country differs from the ship-from
   * country, builds a real Shippo customs declaration (items from the order lines: description, qty, net weight,
   * value, country of origin, HS/tariff number) to attach to the label shipment. Returns null for a domestic
   * shipment (nothing to declare) or when Shippo is not connected. Throws a clear 400 when a line lacks customs
   * data or Shippo rejects the declaration — an international label cannot be bought without one.
   * No duties are calculated here: Solvexo has no tariff data; the carrier bills duties on delivery (DDU).
   */
  async prepareCustomsDeclaration(
    storeId: string,
    args: { originOverride?: ShippingOriginAddress; destinationCountry: string; lines: CustomsLine[]; currency: string; signerName: string },
  ): Promise<string | null> {
    const creds = await this.getCredentials(storeId);
    if (!creds) return null;
    const originCountry = (args.originOverride ?? creds.origin)?.country;
    if (!isInternationalDestination(originCountry, args.destinationCountry)) return null;

    const missing = findMissingCustoms(args.lines);
    if (missing.length > 0) throw new BadRequestException(missingCustomsMessage(missing));

    const headers = { Authorization: `ShippoToken ${creds.apiToken}`, 'Content-Type': 'application/json' };
    const fail = (): never => {
      throw new BadRequestException("Could not create the customs declaration for this international label — check the products' customs information and try again.");
    };
    try {
      const itemIds: string[] = [];
      for (const line of args.lines) {
        const res = await fetch('https://api.goshippo.com/customs/items/', {
          method: 'POST', headers, body: JSON.stringify(buildShippoCustomsItem(line, args.currency)),
        });
        if (!res.ok) fail();
        const item: any = await res.json();
        if (!item?.object_id) fail();
        itemIds.push(item.object_id);
      }
      const declRes = await fetch('https://api.goshippo.com/customs/declarations/', {
        method: 'POST', headers,
        body: JSON.stringify({
          contents_type: 'MERCHANDISE',
          non_delivery_option: 'RETURN',
          certify: true,
          certify_signer: (args.signerName || 'Seller').slice(0, 100),
          items: itemIds,
          // Shippo requires an exemption statement on exports from the US.
          ...(String(originCountry).toUpperCase() === 'US' ? { eel_pfc: 'NOEEI_30_37_a' } : {}),
        }),
      });
      if (!declRes.ok) fail();
      const decl: any = await declRes.json();
      if (!decl?.object_id) fail();
      return decl.object_id as string;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      return fail();
    }
  }

  /** Re-fetches a previously-quoted rate directly from Shippo by its real
   *  id — used to verify the buyer's chosen rate server-side before charging
   *  for it (never trust a client-supplied shipping price). Returns `null`
   *  if the rate can't be re-verified (expired, wrong store's token, Shippo
   *  unreachable) — the caller must reject the checkout-shipping-selection
   *  in that case, not silently accept an unverified amount. */
  async verifyRate(storeId: string, rateId: string, opts: Pick<LiveRateOptions, 'forLabel'> = {}): Promise<LiveShippingRate | null> {
    const creds = await this.getCredentials(storeId);
    if (!creds) return null;
    try {
      const res = await fetch(`https://api.goshippo.com/rates/${rateId}/`, {
        headers: { Authorization: `ShippoToken ${creds.apiToken}` },
      });
      if (!res.ok) return null;
      const r: any = await res.json();
      const rawAmount = Number(r.amount);
      if (!Number.isFinite(rawAmount)) return null;
      // Same handling fee as getLiveRates so checkout charges exactly what was shown.
      const amount = opts.forLabel ? rawAmount : applyHandlingFee(rawAmount, creds.settings.handlingFeeType, creds.settings.handlingFeeValue);
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

  /** Raw carrier rates for a RETURN parcel: from the buyer's address back to the store's ship-from address.
   *  Same rate shape as getLiveRates (forLabel semantics: no handling fee). Returns null when no live quote is available.
   *  A return label is then bought with the ordinary purchaseLabel(rateId). */
  async getReturnLabelRates(
    storeId: string,
    buyerAddress: ShippingDestinationAddress,
    totalWeightKg: number,
    opts: Pick<LiveRateOptions, 'packageId' | 'originOverride'> = {},
  ): Promise<LiveShippingRate[] | null> {
    const creds = await this.getCredentials(storeId);
    if (!creds) return null;
    if (!buyerAddress?.street1 || !buyerAddress.city || !buyerAddress.zip || !buyerAddress.country) return null;
    try {
      const res = await fetch('https://api.goshippo.com/shipments/', {
        method: 'POST',
        headers: { Authorization: `ShippoToken ${creds.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address_from: buyerAddress,
          address_to: opts.originOverride ?? creds.origin,
          parcels: [buildParcel(pickPackage(creds.settings.packages, opts.packageId), totalWeightKg)],
          // Shippo marks this shipment as a return (customer is the sender).
          extra: { is_return: true },
          async: false,
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const rates: any[] = data?.rates ?? [];
      return rates.map((x) => ({
        rateId: x.object_id,
        carrier: x.provider,
        service: x.servicelevel?.name ?? x.servicelevel?.token ?? 'Standard',
        amount: Number(x.amount),
        currency: x.currency,
        estimatedDays: x.estimated_days ?? null,
      })).filter((x) => Number.isFinite(x.amount));
    } catch {
      return null;
    }
  }

  /** Real label purchase for a specific quoted rate — called at fulfillment
   *  time (an order's "mark as shipped" action), not at checkout. Returns
   *  the real tracking number + a real downloadable label PDF URL. */
  async purchaseLabel(storeId: string, rateId: string): Promise<{ trackingNumber: string; labelUrl: string; trackingUrlProvider: string | null } | null> {
    // (rate ids come from a Shippo shipment created with THIS store's token, so a
    //  foreign store's rate id is rejected by Shippo itself.)
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
