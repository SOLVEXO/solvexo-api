/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { InPersonAddress } from './bookable-service.schema';

export type BookingDocument = Booking & Document;

/** One buyer's appointment against a BookableService — either paid directly (chargeOneTime) or redeemed against a PackagePurchase. */
@Schema({ timestamps: true })
export class Booking {
  @Prop({ type: String, required: true }) serviceId: string;
  // Set only when this booking was redeemed against a package instead of charged directly.
  @Prop({ type: String, default: null }) packagePurchaseId: string | null;

  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) buyerId: string;

  @Prop({ type: Date, required: true }) date: Date;
  @Prop({ type: String, required: true }) startTime: string; // "HH:mm"
  @Prop({ type: String, required: true }) endTime: string;   // "HH:mm"

  @Prop({ type: String, enum: ['in_person', 'virtual', 'customer_address'], required: true })
  locationType: string;

  // Snapshot of the buyer's address — only set for locationType==='customer_address'.
  @Prop({ type: Object, default: null }) serviceAddress: InPersonAddress | null;
  // Seller-provided video-call link — only meaningful for locationType==='virtual'.
  @Prop({ type: String, default: null }) meetingLink: string | null;

  // Snapshot of the service's price at booking time; 0 when redeemed against a package.
  @Prop({ type: Number, required: true }) price: number;
  @Prop({ type: String, default: 'USD' }) currency: string;
  @Prop({ type: String, default: null }) paymentProvider: string | null;
  @Prop({ type: String, default: null }) providerChargeId: string | null;

  @Prop({
    type: String,
    enum: ['pending_payment', 'confirmed', 'completed', 'cancelled_by_buyer', 'cancelled_by_seller', 'no_show'],
    default: 'pending_payment',
  })
  status: string;

  @Prop({ type: String, default: null }) cancellationReason: string | null;
  @Prop({ type: String, default: null }) buyerNote: string | null;

  // Reminder-notification dedupe — set once the "starts in ~24h" reminder fires.
  @Prop({ type: Date, default: null }) reminderSentAt: Date | null;
}

export const BookingSchema = SchemaFactory.createForClass(Booking);

// Prevents double-booking the same buyer into the same slot — same
// "atomic insert-or-fail beats check-then-create" pattern used by
// Subscription's {customerId,planId} unique index.
BookingSchema.index(
  { buyerId: 1, serviceId: 1, date: 1, startTime: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending_payment', 'confirmed'] } } },
);
BookingSchema.index({ storeId: 1, date: 1, status: 1 });
BookingSchema.index({ serviceId: 1, date: 1, status: 1 });
