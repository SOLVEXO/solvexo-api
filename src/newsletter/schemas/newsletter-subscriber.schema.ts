import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NewsletterSubscriberDocument =
  HydratedDocument<NewsletterSubscriber>;

/** Where a subscriber's consent came from — kept on the row as the audit
 *  trail a real consent record needs (GDPR/CAN-SPAM: who opted in, how, when). */
export const NEWSLETTER_SOURCES = [
  'platform_footer', // Solvexo's own marketing site (merchant-facing list)
  'store_footer', // a store's themed footer form
  'store_section', // a store's "Newsletter" homepage section
  'checkout', // "Email me with news and offers" at checkout
  'seller', // set by the seller on the customer's behalf
  'import', // seller CSV import (seller attests to having consent)
  'footer', // legacy rows written before `source` was split up
] as const;
export type NewsletterSource = (typeof NEWSLETTER_SOURCES)[number];

/**
 * One email's marketing consent for ONE list. `storeId: null` is Solvexo's own
 * platform list (people signing up on solvexo's public site); any other value
 * is that store's own subscriber list — the Shopify model, where a buyer who
 * subscribes on a merchant's storefront becomes that merchant's subscriber,
 * never the platform's. The same email can therefore have one row per store.
 *
 * This row is the source of truth for "may this store send marketing email
 * to this address" — EmailCampaignsService only ever sends to `isActive`
 * rows, and StoreCustomerMeta.marketingOptIn is kept in sync as a mirror.
 */
@Schema({ timestamps: true })
export class NewsletterSubscriber {
  _id: string;

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ required: true, trim: true, lowercase: true })
  email: string;

  // Linked account when one is known (logged-in signup, checkout, seller
  // opt-in) — informational; consent itself is keyed on the email.
  @Prop({ type: String, default: null })
  userId: string | null;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ required: true })
  unsubscribeToken: string;

  @Prop({ type: String, default: 'platform_footer' })
  source: string;

  @Prop({ type: Date, default: null })
  consentAt: Date | null;

  // Double opt-in: signed up but hasn't clicked the confirmation link yet.
  // Such a row is `isActive: false` (never emailed by campaigns) and is NOT an
  // unsubscribe — confirming flips it active.
  @Prop({ default: false })
  pendingConfirmation: boolean;

  @Prop({ type: String, default: null })
  confirmToken: string | null;

  @Prop()
  unsubscribedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const NewsletterSubscriberSchema =
  SchemaFactory.createForClass(NewsletterSubscriber);
NewsletterSubscriberSchema.index({ storeId: 1, email: 1 }, { unique: true });
NewsletterSubscriberSchema.index({ storeId: 1, isActive: 1 });
NewsletterSubscriberSchema.index({ unsubscribeToken: 1 });
NewsletterSubscriberSchema.index({ confirmToken: 1 }, { sparse: true });

NewsletterSubscriberSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  delete obj.unsubscribeToken;
  delete obj.confirmToken;
  return obj;
};
