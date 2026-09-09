/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformTrialSettingsDocument = PlatformTrialSettings & Document;

// Singleton collection — exactly one document ever exists, fetched/updated via
// upsert with an empty filter (same convention as `PlatformConfig`). This is
// the ONE, platform-wide "Solvexo Free Trial" policy — deliberately NOT part
// of any `PlatformPlan` document. A store's trial is never "the Pro plan's
// trial" or "the Basic plan's trial" — see `SellerPlatformSubscription.
// platformPlanId`, which stays null for as long as a store is trialing.
@Schema({ timestamps: true })
export class PlatformTrialSettings {
  @Prop({ type: Boolean, default: true })
  enabled: boolean;

  @Prop({ type: Number, default: 3, min: 0 })
  durationDays: number;

  // Whether onboarding's card-save step is presented as required or purely
  // optional — informational only today (onboarding's Payment step is always
  // skippable regardless, per StoreService.createStore's unconditional
  // `selfServeActivation`); reserved for a future pass that actually gates on it.
  @Prop({ type: Boolean, default: false })
  paymentMethodRequired: boolean;

  // Only one rule exists today — a fresh store that has never had a
  // SellerPlatformSubscription row before. Kept as an enum (not a bare
  // boolean) so a second eligibility rule can be added later without another
  // migration.
  @Prop({ type: String, enum: ['new_stores_only'], default: 'new_stores_only' })
  eligibility: string;
}

export const PlatformTrialSettingsSchema = SchemaFactory.createForClass(PlatformTrialSettings);
