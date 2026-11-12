/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { COURIER_KEYS, COURIER_STATUSES, CourierKey, CourierStatus } from '../courier.types';

export type CourierBookingDocument = CourierBooking & Document;

export const COURIER_BOOKING_STATUSES = ['pending', 'booked', 'fulfil_failed', 'cancelled', 'failed'] as const;
export type CourierBookingStatus = (typeof COURIER_BOOKING_STATUSES)[number];

@Schema({ _id: false })
export class CourierBookingEvent {
  @Prop({ type: String, enum: COURIER_STATUSES, required: true }) status: CourierStatus;
  @Prop({ type: String, default: '' }) rawStatus: string;
  @Prop({ type: String, default: null }) description: string | null;
  @Prop({ type: String, default: null }) location: string | null;
  @Prop({ type: Date, required: true }) occurredAt: Date;
  /** status|rawStatus|occurredAt — dedupes repeated sync/webhook deliveries of the same event. */
  @Prop({ type: String, required: true }) hash: string;
}
const CourierBookingEventSchema = SchemaFactory.createForClass(CourierBookingEvent);

/**
 * One row per courier booking of (order, seller sub-order, set of lines). Holds the courier-side state (tracking,
 * normalized status, events, RTO flag, READ-ONLY COD info) next to — never instead of — the order's own shipment.
 * No money field here is ever read by the ledger/balance/payout code: COD is display-only.
 */
@Schema({ timestamps: true })
export class CourierBooking {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) orderId: string;
  @Prop({ type: String, enum: COURIER_KEYS, required: true }) provider: CourierKey;
  @Prop({ type: String, enum: ['sandbox', 'live'], default: 'sandbox' }) mode: 'sandbox' | 'live';

  /** 'all' for a whole-order booking, else the sorted "itemId:qty|…" of a partial shipment — the idempotency anchor. */
  @Prop({ type: String, required: true }) lineKey: string;
  @Prop({ type: [{ _id: false, itemId: String, quantity: Number }], default: [] }) items: { itemId: string; quantity: number }[];
  @Prop({ type: String, required: true }) referenceNumber: string;

  @Prop({ type: String, enum: COURIER_BOOKING_STATUSES, default: 'pending' }) bookingStatus: CourierBookingStatus;
  /** true while this booking occupies its (order, store, lineKey) slot; flips false on cancel/failure so a re-book is possible. */
  @Prop({ type: Boolean, default: true }) isActive: boolean;

  @Prop({ type: String, default: null }) trackingNumber: string | null;
  @Prop({ type: String, default: null }) courierReference: string | null;
  @Prop({ type: String, default: null }) trackingUrl: string | null;
  @Prop({ type: String, default: null }) labelUrl: string | null;
  /** Id of the order Shipment this booking became (null until the fulfil step succeeds). */
  @Prop({ type: String, default: null }) shipmentId: string | null;

  @Prop({ type: Number, default: 0 }) weightKg: number;
  @Prop({ type: Number, default: 1 }) pieces: number;
  /** Amount the courier was told to collect (store currency). 0 = already paid. Display only. */
  @Prop({ type: Number, default: 0 }) codAmount: number;
  @Prop({ type: String, default: null }) currency: string | null;

  @Prop({ type: String, enum: COURIER_STATUSES, default: null }) courierStatus: CourierStatus | null;
  @Prop({ type: String, default: null }) rawStatus: string | null;
  @Prop({ type: [CourierBookingEventSchema], default: [] }) events: CourierBookingEvent[];

  /** Return-to-origin flag — seller-visible only. Never changes stock, refunds or money. */
  @Prop({ type: Boolean, default: false }) rto: boolean;
  @Prop({ type: Date, default: null }) rtoAt: Date | null;

  /** READ-ONLY courier-reported COD/remittance info. */
  @Prop({ type: Object, default: null }) cod: { amount?: number | null; status?: string | null; collectedAt?: Date | null; settledAt?: Date | null } | null;

  @Prop({ type: Date, default: null }) lastSyncedAt: Date | null;
  @Prop({ type: Number, default: 0 }) syncFailures: number;
  @Prop({ type: String, default: null }) lastSyncError: string | null;
  /** Set exactly once when the courier's DELIVERED has been applied through the order's delivered path. */
  @Prop({ type: Date, default: null }) deliveredAppliedAt: Date | null;
  @Prop({ type: Date, default: null }) rtoNotifiedAt: Date | null;

  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ type: Date, default: null }) cancelledAt: Date | null;
}

export const CourierBookingSchema = SchemaFactory.createForClass(CourierBooking);
CourierBookingSchema.index({ orderId: 1, storeId: 1, lineKey: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
CourierBookingSchema.index({ provider: 1, trackingNumber: 1 });
CourierBookingSchema.index({ storeId: 1, createdAt: -1 });
// Tracking-sync scan: live bookings that are not yet terminal, oldest-synced first.
CourierBookingSchema.index({ isActive: 1, bookingStatus: 1, lastSyncedAt: 1 });
