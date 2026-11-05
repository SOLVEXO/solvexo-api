/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../../database/databaseservice';
import { EntitlementsService } from '../../platform-plans/entitlements.service';
import { decryptCredential } from '../../common/credential-encryption.util';
import { COURIER_CATALOG, courierCatalogEntry, enabledCourierProviders, isCourierEnabled } from './courier-catalog';
import { CourierProviderRegistry } from './courier-provider.registry';
import {
  BookedShipment, BookShipmentInput, CourierContext, CourierDocument, CourierError, CourierKey, CourierParty, CourierProvider,
  CourierStatus, CourierTrackResult, isCourierKey,
} from './courier.types';
import { CourierBookingDocument } from './schemas/courier-booking.schema';

export interface CourierConnection {
  provider: CourierProvider;
  ctx: CourierContext;
  key: CourierKey;
  mode: 'sandbox' | 'live';
}

export interface CourierSettingsInput {
  defaultProvider?: string | null;
  defaultWeightKg?: number;
  pickup?: Partial<CourierParty> | null;
  returnAddress?: Partial<CourierParty> | null;
}

const DEFAULT_WEIGHT_KG = 0.5;

/** Courier errors become 400s with the (already redacted) safe message — never a stack, never a credential. */
export function courierErrorToHttp(err: unknown): never {
  if (err instanceof CourierError) {
    if (err.code === 'circuit_open' || err.code === 'timeout' || err.code === 'network' || err.code === 'upstream') {
      throw new ConflictException(err.message);
    }
    throw new BadRequestException(err.message);
  }
  throw err;
}

function cleanParty(raw: any, label: string, required: boolean): CourierParty | null {
  if (raw == null || (typeof raw === 'object' && Object.values(raw).every((v) => !v))) {
    if (required) throw new BadRequestException(`${label} is required`);
    return null;
  }
  const str = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const party: CourierParty = {
    name: str(raw.name, 80), phone: str(raw.phone, 20), address: str(raw.address, 250), city: str(raw.city, 60),
  };
  if (!party.name || !party.phone || !party.address || !party.city) {
    throw new BadRequestException(`${label} needs a name, phone, address and city`);
  }
  if (!/^[+\d][\d\s-]{6,19}$/.test(party.phone)) throw new BadRequestException(`${label} phone number looks invalid`);
  const email = str(raw.email, 120);
  if (email) party.email = email;
  const code = str(raw.addressCode, 40);
  if (code) party.addressCode = code;
  return party;
}

@Injectable()
export class CourierService {
  private readonly logger = new Logger(CourierService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly registry: CourierProviderRegistry,
    private readonly entitlements: EntitlementsService,
  ) {}

  private get repos() { return this.databaseService.repositories; }

  // ── Connection / enablement ───────────────────────────────────────────────────────────────────────────────────

  /** Plan gate. Off by default (label-style actions are on every plan, like Shopify labels); flip with COURIER_REQUIRES_PLAN_FEATURE=true. */
  async assertBookingAllowed(storeId: string) {
    if (process.env.COURIER_REQUIRES_PLAN_FEATURE === 'true') {
      await this.entitlements.assertFeatureAllowed(storeId, 'calculatedShippingRatesAllowed', 'Courier booking');
    }
  }

  /**
   * The ONE place credentials are decrypted for a courier call. Refuses unless: the courier is in
   * COURIER_ENABLED_PROVIDERS, the seller connected it (status 'connected'), and — for live mode — a successful test ran.
   */
  async resolveConnection(storeId: string, providerKey: string): Promise<CourierConnection> {
    if (!isCourierKey(providerKey) || !this.registry.isSupported(providerKey)) throw new BadRequestException('Unknown courier');
    if (!isCourierEnabled(providerKey)) throw new BadRequestException(`${COURIER_CATALOG[providerKey].label} is not enabled on this platform yet`);
    const integration: any = await this.repos.storeIntegrationModel.findOne({ storeId, type: 'courier', provider: providerKey });
    if (!integration || integration.status !== 'connected' || !integration.credentialsEncrypted) {
      throw new BadRequestException(`${COURIER_CATALOG[providerKey].label} is not connected for this store`);
    }
    if (integration.mode === 'live' && !integration.lastVerifiedAt) {
      throw new BadRequestException(`Run a successful connection test for ${COURIER_CATALOG[providerKey].label} before booking in live mode`);
    }
    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS'));
    } catch {
      throw new BadRequestException('Stored courier credentials could not be read — reconnect the courier');
    }
    return { provider: this.registry.resolve(providerKey), key: providerKey, mode: integration.mode, ctx: { credentials, mode: integration.mode, config: integration.config ?? {} } };
  }

  /** Couriers this store can actually book with right now (enabled + connected + valid). Safe fields only. */
  async listBookableProviders(storeId: string) {
    const enabled = enabledCourierProviders();
    if (enabled.length === 0) return [];
    const rows: any[] = await this.repos.storeIntegrationModel.find({ storeId, type: 'courier', provider: { $in: enabled }, status: 'connected' }).lean();
    return rows
      .filter((r) => r.credentialsEncrypted && (r.mode !== 'live' || r.lastVerifiedAt))
      .map((r) => {
        const impl = this.registry.resolve(r.provider);
        return { provider: r.provider as CourierKey, label: COURIER_CATALOG[r.provider as CourierKey].label, mode: r.mode, capabilities: impl.capabilities };
      });
  }

  // ── Store courier settings ────────────────────────────────────────────────────────────────────────────────────

  async getSettings(storeId: string) {
    const store: any = await this.repos.storeModel.findOne({ _id: storeId, isDelete: false }).select('courierSettings').lean();
    if (!store) throw new NotFoundException('Store not found');
    const s = store.courierSettings ?? {};
    return {
      defaultProvider: s.defaultProvider ?? null,
      defaultWeightKg: s.defaultWeightKg ?? DEFAULT_WEIGHT_KG,
      pickup: s.pickup ?? null,
      returnAddress: s.returnAddress ?? null,
    };
  }

  async saveSettings(storeId: string, input: CourierSettingsInput) {
    const defaultProvider = input.defaultProvider ?? null;
    if (defaultProvider !== null && !courierCatalogEntry(defaultProvider)) throw new BadRequestException('Unknown default courier');
    const weight = input.defaultWeightKg ?? DEFAULT_WEIGHT_KG;
    if (!(typeof weight === 'number') || !(weight >= 0.01 && weight <= 100)) throw new BadRequestException('Default weight must be between 0.01 and 100 kg');
    const pickup = cleanParty(input.pickup, 'Pickup address', false);
    const returnAddress = cleanParty(input.returnAddress, 'Return address', false);
    const res = await this.repos.storeModel.updateOne({ _id: storeId, isDelete: false }, { $set: { courierSettings: { defaultProvider, defaultWeightKg: weight, pickup, returnAddress } } });
    if (!res.matchedCount) throw new NotFoundException('Store not found');
    return this.getSettings(storeId);
  }

  // ── Booking records ───────────────────────────────────────────────────────────────────────────────────────────

  /** Atomically claims the (order, store, lineKey) slot. `created:false` => an active booking already exists. */
  async claim(data: {
    storeId: string; sellerId: string; orderId: string; provider: CourierKey; mode: 'sandbox' | 'live'; lineKey: string;
    items: { itemId: string; quantity: number }[]; referenceNumber: string; weightKg: number; pieces: number; codAmount: number; currency: string;
  }): Promise<{ booking: CourierBookingDocument; created: boolean }> {
    try {
      const booking = await this.repos.courierBookingModel.create({ ...data, bookingStatus: 'pending', isActive: true });
      return { booking, created: true };
    } catch (err: any) {
      if (err?.code === 11000) {
        const existing = await this.repos.courierBookingModel.findOne({ orderId: data.orderId, storeId: data.storeId, lineKey: data.lineKey, isActive: true });
        if (existing) return { booking: existing, created: false };
      }
      throw err;
    }
  }

  async countForOrder(storeId: string, orderId: string): Promise<number> {
    return this.repos.courierBookingModel.countDocuments({ storeId, orderId });
  }

  /** COD already handed to couriers for this order's other live bookings (store currency) — for the final-shipment remainder. */
  async codAlreadyAssigned(storeId: string, orderId: string, excludeId?: string): Promise<number> {
    const rows: any[] = await this.repos.courierBookingModel
      .find({ storeId, orderId, isActive: true, bookingStatus: { $in: ['booked', 'fulfil_failed'] }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
      .select('codAmount').lean();
    return rows.reduce((s, r) => s + (r.codAmount ?? 0), 0);
  }

  /** Resolves city (when the courier has a list) then books. Never auto-retried. */
  async bookAtCourier(conn: CourierConnection, input: BookShipmentInput): Promise<BookedShipment> {
    try {
      if (conn.provider.capabilities.cityList) {
        const city = await conn.provider.validateCity(conn.ctx, input.consignee.city);
        input = { ...input, consignee: { ...input.consignee, city: city.name, cityId: city.id } };
        if (input.pickup.city) {
          try {
            const p = await conn.provider.validateCity(conn.ctx, input.pickup.city);
            input = { ...input, pickup: { ...input.pickup, city: p.name, cityId: p.id } };
          } catch (e) {
            if (e instanceof CourierError && e.code === 'city_not_serviceable') throw new CourierError('city_not_serviceable', `Your pickup city "${input.pickup.city}" is not served by ${COURIER_CATALOG[conn.key].label} — fix it in Courier settings.`);
            throw e;
          }
        }
      }
      return await conn.provider.bookShipment(conn.ctx, input);
    } catch (err) {
      return courierErrorToHttp(err);
    }
  }

  async markBooked(id: string, b: BookedShipment, base: { trackingUrl?: string | null }) {
    return this.repos.courierBookingModel.findOneAndUpdate(
      { _id: id, bookingStatus: 'pending' },
      { $set: { bookingStatus: 'booked', trackingNumber: b.trackingNumber, courierReference: b.courierReference ?? null, labelUrl: b.labelUrl ?? null, trackingUrl: b.trackingUrl ?? base.trackingUrl ?? null, courierStatus: 'booked', rawStatus: 'booked', error: null } },
      { new: true },
    );
  }

  async markFailed(id: string, message: string) {
    await this.repos.courierBookingModel.updateOne({ _id: id }, { $set: { bookingStatus: 'failed', isActive: false, error: message.slice(0, 300) } });
  }

  async markFulfilFailed(id: string, message: string) {
    await this.repos.courierBookingModel.updateOne({ _id: id }, { $set: { bookingStatus: 'fulfil_failed', error: message.slice(0, 300) } });
  }

  async markFulfilled(id: string, shipmentId: string | null) {
    await this.repos.courierBookingModel.updateOne({ _id: id }, { $set: { bookingStatus: 'booked', shipmentId, error: null } });
  }

  async findOwned(storeId: string, bookingId: string): Promise<CourierBookingDocument> {
    const b = await this.repos.courierBookingModel.findOne({ _id: bookingId, storeId });
    if (!b) throw new NotFoundException('Courier booking not found');
    return b;
  }

  async listForOrder(storeId: string, orderId: string) {
    const rows: any[] = await this.repos.courierBookingModel.find({ storeId, orderId }).sort({ createdAt: 1 }).lean();
    return rows.map((r) => this.toSellerView(r));
  }

  /** Seller-facing view. Contains no credentials by construction (they are never stored on a booking). */
  toSellerView(r: any) {
    return {
      id: String(r._id), orderId: r.orderId, provider: r.provider, providerLabel: COURIER_CATALOG[r.provider as CourierKey]?.label ?? r.provider,
      mode: r.mode, bookingStatus: r.bookingStatus, isActive: r.isActive, referenceNumber: r.referenceNumber,
      trackingNumber: r.trackingNumber, trackingUrl: r.trackingUrl, hasLabel: !!r.trackingNumber && r.bookingStatus !== 'cancelled',
      shipmentId: r.shipmentId, items: r.items, weightKg: r.weightKg, pieces: r.pieces, codAmount: r.codAmount, currency: r.currency,
      courierStatus: r.courierStatus, rawStatus: r.rawStatus, rto: r.rto, rtoAt: r.rtoAt, cod: r.cod ?? null,
      events: (r.events ?? []).map((e: any) => ({ status: e.status, rawStatus: e.rawStatus, description: e.description, location: e.location, occurredAt: e.occurredAt })),
      lastSyncedAt: r.lastSyncedAt, lastSyncError: r.lastSyncError, error: r.error, cancelledAt: r.cancelledAt, createdAt: r.createdAt,
    };
  }

  async cancelAtCourier(conn: CourierConnection, trackingNumber: string) {
    try {
      await conn.provider.cancelShipment(conn.ctx, trackingNumber);
    } catch (err) {
      courierErrorToHttp(err);
    }
  }

  async markCancelled(id: string) {
    await this.repos.courierBookingModel.updateOne({ _id: id }, { $set: { bookingStatus: 'cancelled', isActive: false, courierStatus: 'cancelled', cancelledAt: new Date() } });
  }

  // ── Airway bill / load sheet (batched per the courier's own limits; one courier per request) ──────────────────

  async getDocuments(storeId: string, bookingIds: string[], kind: 'airway_bill' | 'load_sheet'): Promise<{ provider: CourierKey; documents: CourierDocument[] }> {
    if (bookingIds.length === 0) throw new BadRequestException('Select at least one booking');
    if (bookingIds.length > 100) throw new BadRequestException('At most 100 bookings at a time');
    const rows: any[] = await this.repos.courierBookingModel.find({ _id: { $in: bookingIds }, storeId, bookingStatus: { $in: ['booked', 'fulfil_failed'] } }).lean();
    if (rows.length === 0) throw new NotFoundException('No matching active bookings');
    const providers = [...new Set(rows.map((r) => r.provider as CourierKey))];
    if (providers.length > 1) throw new BadRequestException('Select bookings from one courier at a time');
    const conn = await this.resolveConnection(storeId, providers[0]);
    const caps = conn.provider.capabilities;
    if (kind === 'airway_bill' && !caps.airwayBill) throw new BadRequestException(`${COURIER_CATALOG[conn.key].label} does not provide airway bills from here`);
    if (kind === 'load_sheet' && (!caps.loadSheet || !conn.provider.getLoadSheet)) throw new BadRequestException(`${COURIER_CATALOG[conn.key].label} does not provide a load sheet`);
    const numbers = rows.map((r) => r.trackingNumber as string).filter(Boolean);
    const size = kind === 'airway_bill' ? Math.max(1, caps.airwayBillBatchSize) : numbers.length;
    const documents: CourierDocument[] = [];
    try {
      for (let i = 0; i < numbers.length; i += size) {
        const chunk = numbers.slice(i, i + size);
        documents.push(kind === 'airway_bill' ? await conn.provider.getAirwayBill(conn.ctx, chunk) : await conn.provider.getLoadSheet!(conn.ctx, chunk));
      }
    } catch (err) {
      courierErrorToHttp(err);
    }
    return { provider: conn.key, documents };
  }

  // ── Tracking-event helpers (used by the sync job, Phase 4) ────────────────────────────────────────────────────

  static eventHash(status: CourierStatus, rawStatus: string, at: Date): string {
    return createHash('sha1').update(`${status}|${rawStatus}|${at.toISOString()}`).digest('hex').slice(0, 20);
  }

  async trackAtCourier(conn: CourierConnection, trackingNumbers: string[]): Promise<CourierTrackResult[]> {
    return conn.provider.trackShipments(conn.ctx, trackingNumbers);
  }
}
