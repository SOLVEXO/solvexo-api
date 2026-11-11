/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformTaxRuleDocument = PlatformTaxRule & Document;

/**
 * What the tax treatment of a supply is. Phase 1 never writes these: the engine reads them if they exist, and otherwise only sees
 * the legacy rates of Admin → Settings → Tax (never verified). A rule becomes `verified` only by a person (Phase 4).
 */
@Schema({ timestamps: true, collection: 'platform_tax_rules' })
export class PlatformTaxRule {
  @Prop({ type: String, required: true }) entityKey: string;
  /** Customer country (ISO alpha-2) the rule covers. */
  @Prop({ type: String, required: true }) country: string;
  @Prop({ type: String, default: 'saas_subscription' }) supplyType: string;
  @Prop({ type: String, enum: ['taxable', 'zero_rated', 'exempt', 'out_of_scope', 'unknown'], default: 'unknown' }) treatment: string;
  @Prop({ type: Number, default: null }) ratePercent: number | null;
  @Prop({
    type: { _id: false, state: { type: String, enum: ['unverified', 'legacy_confirmed', 'verified'], default: 'unverified' }, source: { type: String, default: null }, verifiedBy: { type: String, default: null }, verifiedAt: { type: Date, default: null } },
    default: () => ({ state: 'unverified' }),
  })
  verification: { state: 'unverified' | 'legacy_confirmed' | 'verified'; source: string | null; verifiedBy: string | null; verifiedAt: Date | null };
}

export const PlatformTaxRuleSchema = SchemaFactory.createForClass(PlatformTaxRule);
PlatformTaxRuleSchema.index({ entityKey: 1, country: 1, 'verification.state': 1 });
