/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SignupFormDocument = HydratedDocument<SignupForm>;

/**
 * A store's email signup popup (Shopify: the Forms app's popup). One per store. It shows on the storefront after the
 * visitor's n-th page view (optionally after a delay and/or when they move to leave on desktop), may leave a small "teaser"
 * tab once closed, and shows a discount code on the success step. Views and submissions are counted for the form's report.
 */
@Schema({ timestamps: true })
export class SignupForm {
  _id: string;

  @Prop({ type: String, required: true, unique: true }) storeId: string;

  @Prop({ type: Boolean, default: false }) enabled: boolean;

  @Prop({ type: String, default: 'Get 10% off your first order', maxlength: 120 }) heading: string;
  @Prop({ type: String, default: 'Join our email list for news, offers and early access.', maxlength: 300 }) body: string;
  @Prop({ type: String, default: 'Subscribe', maxlength: 40 }) buttonLabel: string;
  @Prop({ type: String, default: 'Thanks for subscribing!', maxlength: 120 }) successHeading: string;
  @Prop({ type: String, default: 'You are on the list.', maxlength: 300 }) successMessage: string;

  /** An existing discount code of the store, shown on the success step. Null = none. */
  @Prop({ type: String, default: null }) discountCode: string | null;

  // When it appears: on the 1st / 2nd / 3rd page view, after a delay, and/or when the cursor leaves the page (desktop only).
  @Prop({ type: Number, default: 1, min: 1, max: 3 }) showAfterPageViews: number;
  @Prop({ type: Number, default: 5, min: 0, max: 60 }) delaySeconds: number;
  @Prop({ type: Boolean, default: false }) exitIntent: boolean;

  // A small tab left at the edge of the page once the visitor closes the popup, to open it again.
  @Prop({ type: Boolean, default: true }) teaser: boolean;
  @Prop({ type: String, default: 'Get 10% off', maxlength: 40 }) teaserText: string;

  @Prop({ type: Number, default: 0 }) views: number;
  @Prop({ type: Number, default: 0 }) submissions: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const SignupFormSchema = SchemaFactory.createForClass(SignupForm);
