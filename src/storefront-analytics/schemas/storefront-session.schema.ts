/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * One online-store visit (Shopify "session"): a visitor's activity on one store until 30 minutes of inactivity
 * or local midnight, after which the storefront starts a new session id. Feeds Sessions, Conversion rate, the
 * conversion funnel (sessions -> added to cart -> reached checkout -> converted) and Live View.
 *
 * Written by `StorefrontAnalyticsService`: page views come from the storefront beacon (store resolved and checked
 * server-side; an unknown/locked store id is ignored), while `addedToCart`/`reachedCheckout`/`converted` are set
 * by the SERVER when the real cart/checkout/order write happens (`markStorefrontSession`) — a client can't fake a
 * conversion. Only recorded after the visitor's analytics consent where the store shows a cookie banner. No IP is
 * stored. Counts exist from this feature's launch forward only (no backfill).
 */
@Schema({ timestamps: true })
export class StorefrontSession {
  @Prop({ type: String, required: true })
  storeId: string;

  /** Client-generated random id (one per visit). */
  @Prop({ type: String, required: true })
  sessionId: string;

  /** Client-generated random id kept across visits (returning vs new visitors). */
  @Prop({ type: String, required: true })
  visitorId: string;

  @Prop({ type: Date, required: true })
  startedAt: Date;

  @Prop({ type: Date, required: true })
  lastSeenAt: Date;

  @Prop({ type: Number, default: 0 })
  pageViews: number;

  /** Path of the first page of the visit (no query string). */
  @Prop({ type: String, default: null })
  landingPath: string | null;

  /** Last path seen — powers Live View's "pages being viewed". */
  @Prop({ type: String, default: null })
  currentPath: string | null;

  @Prop({ type: String, default: null })
  referrerHost: string | null;

  /** direct | search | social | email | paid | referral (Shopify's traffic types). */
  @Prop({ type: String, default: 'direct' })
  trafficSource: string;

  @Prop({ type: String, default: null }) utmSource: string | null;
  @Prop({ type: String, default: null }) utmMedium: string | null;
  @Prop({ type: String, default: null }) utmCampaign: string | null;

  /** desktop | mobile | tablet */
  @Prop({ type: String, default: 'desktop' })
  deviceType: string;

  /** ISO-3166 alpha-2 from the CDN geo header, else derived from the browser time zone; null when unknown. */
  @Prop({ type: String, default: null })
  country: string | null;

  @Prop({ type: Boolean, default: false })
  returningVisitor: boolean;

  @Prop({ type: Boolean, default: false })
  addedToCart: boolean;

  @Prop({ type: Boolean, default: false })
  reachedCheckout: boolean;

  @Prop({ type: Boolean, default: false })
  converted: boolean;

  @Prop({ type: [String], default: [] })
  orderIds: string[];

  @Prop({ type: String, default: null })
  userId: string | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type StorefrontSessionDocument = StorefrontSession & Document;
export const StorefrontSessionSchema = SchemaFactory.createForClass(StorefrontSession);

StorefrontSessionSchema.index({ storeId: 1, sessionId: 1 }, { unique: true });
StorefrontSessionSchema.index({ storeId: 1, startedAt: -1 });
StorefrontSessionSchema.index({ storeId: 1, lastSeenAt: -1 });
StorefrontSessionSchema.index({ storeId: 1, visitorId: 1, startedAt: -1 });
// Reports go back at most 2 years (MAX_RANGE_DAYS) — older raw sessions are dropped automatically.
StorefrontSessionSchema.index({ startedAt: 1 }, { expireAfterSeconds: 732 * 24 * 60 * 60 });
