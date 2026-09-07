/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreAppRequestDocument = HydratedDocument<StoreAppRequest>;

// A store's white-label app is a genuinely separate, per-platform build —
// Google Play and Apple App Store have their own review pipelines and
// timelines (Apple's is typically slower), so each platform tracked here
// moves through this lifecycle independently rather than sharing one flat
// status. 'not_requested' is the default for whichever platform the seller
// didn't ask for.
export const STORE_APP_PLATFORM_STATUSES = [
  'not_requested', 'pending', 'in_review', 'building', 'submitted', 'published', 'rejected',
] as const;
export type StoreAppPlatformStatus = (typeof STORE_APP_PLATFORM_STATUSES)[number];

// A status is "resolved" (no admin action pending) once it's reached a
// terminal state — used by the service to decide whether a store may submit
// a new request.
export const STORE_APP_RESOLVED_STATUSES: StoreAppPlatformStatus[] = ['not_requested', 'published', 'rejected'];

// Each platform build is its own paid product — a seller can buy Android now
// and iOS later (or never). `requested` only ever flips to true once the
// platform's own PaymentIntent is confirmed server-side (see
// StoreAppRequestsService.confirmPlatformPayment); it's never a "free ask".
export const STORE_APP_PLATFORM_PAYMENT_STATUSES = ['unpaid', 'pending', 'paid'] as const;
export type StoreAppPlatformPaymentStatus = (typeof STORE_APP_PLATFORM_PAYMENT_STATUSES)[number];

@Schema({ _id: false })
export class StoreAppStatusHistoryEntry {
  @Prop({ type: String, enum: STORE_APP_PLATFORM_STATUSES, required: true })
  status: StoreAppPlatformStatus;

  @Prop({ type: Date, required: true })
  changedAt: Date;
}
export const StoreAppStatusHistoryEntrySchema = SchemaFactory.createForClass(StoreAppStatusHistoryEntry);

@Schema({ _id: false })
export class StoreAppPlatformState {
  @Prop({ type: Boolean, default: false })
  requested: boolean;

  @Prop({ type: String, enum: STORE_APP_PLATFORM_STATUSES, default: 'not_requested' })
  status: StoreAppPlatformStatus;

  // Real, recorded timestamp for every status this platform has actually
  // passed through — one entry per transition (see
  // StoreAppRequestsService.confirmPlatformPayment/updatePlatformStatus,
  // the only two places `status` is ever set). Reset to just the 'pending'
  // entry each time a platform is re-requested after a rejection, so a
  // second cycle's timeline doesn't get mixed in with the first's. Powers
  // the seller-facing "reached on <date>" timestamp per stage — never
  // estimated/fabricated client-side.
  @Prop({ type: [StoreAppStatusHistoryEntrySchema], default: [] })
  statusHistory: StoreAppStatusHistoryEntry[];

  // The live Play Store / App Store listing link, set by admin once published.
  @Prop({ type: String, default: null })
  storeUrl: string | null;

  @Prop({ type: String, default: null })
  rejectionReason: string | null;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;

  @Prop({ type: String, enum: STORE_APP_PLATFORM_PAYMENT_STATUSES, default: 'unpaid' })
  paymentStatus: StoreAppPlatformPaymentStatus;

  @Prop({ type: String, default: null })
  stripePaymentIntentId: string | null;
}
export const StoreAppPlatformStateSchema = SchemaFactory.createForClass(StoreAppPlatformState);

// A seller's request for their own white-label, branded store app — distinct
// from Solvexo's own single POS app (a Google Play paid listing shown as a
// QR code — see StoreService.getPosAppInfo — with no request/build/Stripe
// flow at all). Admin builds + publishes each platform manually here (see
// AdminStoreAppRequestsController), updating `android`/`ios` independently
// as each platform's review resolves.
@Schema({ timestamps: true })
export class StoreAppRequest {
  _id: string;

  // Both indexed — storeId so admin can always see exactly which store a
  // request belongs to (and a seller can look up their own store's request),
  // sellerId so a seller's requests can be found even if a store record is
  // ever removed.
  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true, index: true })
  sellerId: string;

  @Prop({ required: true, trim: true })
  appName: string;

  @Prop({ required: true })
  shortDescription: string;

  @Prop({ required: true })
  fullDescription: string;

  // Google Play spec: PNG/JPEG, ≤1MB, exactly 512×512 — enforced in the
  // service against Cloudinary's own reported upload dimensions. Optional —
  // a seller can submit without one and add it later.
  @Prop({ type: String, default: null })
  iconUrl: string | null;
  @Prop({ default: '' })
  iconPublicId: string;

  // Google Play spec: PNG/JPEG, ≤15MB, exactly 1024×500. Optional, same as iconUrl above.
  @Prop({ type: String, default: null })
  featureGraphicUrl: string | null;
  @Prop({ default: '' })
  featureGraphicPublicId: string;

  @Prop({ type: StoreAppPlatformStateSchema, default: () => ({}) })
  android: StoreAppPlatformState;

  @Prop({ type: StoreAppPlatformStateSchema, default: () => ({}) })
  ios: StoreAppPlatformState;

  // Internal admin-only working notes (e.g. "icon resolution off, asked
  // seller to re-upload") — never shown to the seller, unlike the
  // per-platform `rejectionReason` above.
  @Prop({ type: String, default: null })
  adminNotes: string | null;

  @Prop({ type: String, default: null })
  reviewedBy: string | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreAppRequestSchema = SchemaFactory.createForClass(StoreAppRequest);

StoreAppRequestSchema.index({ storeId: 1, createdAt: -1 });
StoreAppRequestSchema.index({ sellerId: 1, createdAt: -1 });

StoreAppRequestSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};
