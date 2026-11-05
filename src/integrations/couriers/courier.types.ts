/* eslint-disable prettier/prettier */
import type { StoreIntegrationMode } from '../schemas/store-integration.schema';

/** Keep in sync with STORE_INTEGRATION_PROVIDERS (schemas/store-integration.schema.ts). */
export const COURIER_KEYS = ['postex', 'leopards', 'tcs', 'trax', 'mnp', 'blueex', 'callcourier', 'swyft', 'daewoo_fastex'] as const;
export type CourierKey = (typeof COURIER_KEYS)[number];

export function isCourierKey(v: unknown): v is CourierKey {
  return typeof v === 'string' && (COURIER_KEYS as readonly string[]).includes(v);
}

/** One normalized lifecycle shared by every courier; each courier's raw statuses map onto it in that courier's mapping file. */
export const COURIER_STATUSES = ['booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'returned', 'cancelled', 'failed'] as const;
export type CourierStatus = (typeof COURIER_STATUSES)[number];

/** Forward ordering of the delivery lifecycle (used to ignore out-of-order / stale events). */
const RANK: Record<CourierStatus, number> = {
  booked: 0, picked_up: 1, in_transit: 2, failed: 3, out_for_delivery: 4, delivered: 5, returned: 5, cancelled: 5,
};

export function isTerminalCourierStatus(s: CourierStatus): boolean {
  return s === 'delivered' || s === 'returned' || s === 'cancelled';
}

/**
 * Whether an incoming status may replace the current one. Terminal states never change; `returned` (RTO) and
 * `cancelled` may arrive from any non-terminal state; otherwise only forward (or same-rank) moves apply.
 * `failed` = a delivery attempt failed — informational, the parcel is still live, so most things may follow it.
 */
export function canAdvanceCourierStatus(current: CourierStatus | null | undefined, next: CourierStatus): boolean {
  if (!current) return true;
  if (isTerminalCourierStatus(current)) return false;
  if (next === 'returned' || next === 'cancelled') return true;
  if (current === 'failed') return next !== 'booked' && next !== 'picked_up';
  return RANK[next] >= RANK[current];
}

export interface CourierCredentials { [field: string]: string }

/** Decrypted per-store connection handed to every provider call. Never logged, never returned by an API. */
export interface CourierContext {
  credentials: CourierCredentials;
  mode: StoreIntegrationMode;
  config: Record<string, any>;
}

export interface CourierCity { id?: string; name: string }

export interface CourierParty {
  name: string;
  phone: string;
  email?: string;
  address: string;
  city: string;
  /** Courier-specific city id when the courier needs one (resolved via listCities). */
  cityId?: string;
  /** Courier-side registered pickup address code (PostEx merchant address etc.). */
  addressCode?: string;
}

export interface BookShipmentInput {
  /** Our own unique reference (order number + shipment) — also the courier-side order ref / idempotency anchor. */
  referenceNumber: string;
  consignee: CourierParty;
  pickup: CourierParty;
  returnAddress?: CourierParty;
  weightKg: number;
  pieces: number;
  /** Amount the courier must collect from the buyer. 0 when the order is already paid. Store currency. */
  codAmount: number;
  currency: string;
  description: string;
  remarks?: string;
  declaredValue?: number;
}

export interface BookedShipment {
  trackingNumber: string;
  /** Courier's own id for the booking when it differs from the tracking number. */
  courierReference?: string;
  trackingUrl?: string | null;
  labelUrl?: string | null;
}

export interface CourierTrackingEvent {
  status: CourierStatus;
  rawStatus: string;
  description?: string;
  location?: string;
  occurredAt: Date;
}

export interface CourierTrackResult {
  trackingNumber: string;
  /** Latest normalized status. */
  status: CourierStatus;
  rawStatus: string;
  events: CourierTrackingEvent[];
  /** Read-only COD/remittance info when the courier's tracking response carries it. */
  cod?: CourierCodStatus | null;
}

/** READ-ONLY display data — nothing in Solvexo moves, holds or settles money from it. */
export interface CourierCodStatus {
  amount?: number | null;
  /** Courier's own wording, e.g. "Collected", "Settled". */
  status?: string | null;
  collectedAt?: Date | null;
  settledAt?: Date | null;
}

export interface CourierDocument {
  /** URL the courier serves the PDF from… */
  url?: string;
  /** …or the PDF bytes themselves. */
  pdf?: Buffer;
}

export interface CourierCapabilities {
  /** One call books many parcels (otherwise bulk = sequential single bookings). */
  bulkBooking: boolean;
  /** Max tracking numbers per trackShipments call (1 = one at a time). */
  trackBatchSize: number;
  /** Max tracking numbers per airway-bill call. */
  airwayBillBatchSize: number;
  airwayBill: boolean;
  loadSheet: boolean;
  cityList: boolean;
  cancel: boolean;
  codStatus: boolean;
  /** Courier documents a signed push webhook (see docs/courier-module.md). */
  pushWebhook: boolean;
}

export interface CourierProvider {
  readonly providerKey: CourierKey;
  readonly capabilities: CourierCapabilities;
  testConnection(ctx: CourierContext): Promise<{ ok: boolean; message: string }>;
  listCities(ctx: CourierContext): Promise<CourierCity[]>;
  /** Resolves a free-text city to a serviceable one, or throws CourierError('city_not_serviceable'). */
  validateCity(ctx: CourierContext, city: string): Promise<CourierCity>;
  bookShipment(ctx: CourierContext, input: BookShipmentInput): Promise<BookedShipment>;
  /** Only when capabilities.bulkBooking. Per-item result; a single bad parcel never throws. */
  bookShipments?(ctx: CourierContext, inputs: BookShipmentInput[]): Promise<Array<{ referenceNumber: string; shipment?: BookedShipment; error?: string }>>;
  trackShipments(ctx: CourierContext, trackingNumbers: string[]): Promise<CourierTrackResult[]>;
  cancelShipment(ctx: CourierContext, trackingNumber: string): Promise<void>;
  getAirwayBill(ctx: CourierContext, trackingNumbers: string[]): Promise<CourierDocument>;
  getLoadSheet?(ctx: CourierContext, trackingNumbers: string[]): Promise<CourierDocument>;
}

export type CourierErrorCode =
  | 'auth' | 'validation' | 'timeout' | 'network' | 'malformed' | 'city_not_serviceable'
  | 'unsupported' | 'not_found' | 'circuit_open' | 'unverified' | 'upstream';

/** Error whose `message` is always safe to show a seller (no credentials, no raw courier payloads). */
export class CourierError extends Error {
  constructor(public readonly code: CourierErrorCode, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'CourierError';
  }
}
