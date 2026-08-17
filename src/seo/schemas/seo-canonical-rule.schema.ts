/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoCanonicalRuleDocument = SeoCanonicalRule & Document;

/**
 * Canonical-URL override for duplicate-content path patterns (filter/sort/
 * pagination query-string variants). Shared collection between Admin
 * (platform-wide, `storeId: null`) and Seller (store-scoped) — same
 * reasoning as SeoRedirect.
 */
@Schema({ timestamps: true })
export class SeoCanonicalRule {
  @Prop({ type: String, default: null })
  storeId: string | null;

  // Path pattern this rule matches, e.g. "/marketplace/category/:id" — query
  // strings are always stripped by the matcher regardless of this pattern,
  // since duplicate-content here is overwhelmingly a query-param problem.
  @Prop({ type: String, required: true })
  pathPattern: string;

  @Prop({ type: String, required: true })
  canonicalUrl: string;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const SeoCanonicalRuleSchema = SchemaFactory.createForClass(SeoCanonicalRule);
SeoCanonicalRuleSchema.index({ storeId: 1, pathPattern: 1 }, { unique: true });
