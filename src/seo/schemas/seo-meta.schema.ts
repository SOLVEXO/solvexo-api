/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * Shared embedded SEO-meta sub-document — identical shape reused on
 * `Product.seo`, `Category.seo`, and `Store.seo` (and, once those modules
 * exist, would apply the same way to Collections/Blog). Embedded directly on
 * the owning entity (not a side collection) deliberately: Product/Category/
 * Store pages are the highest-traffic public read path in the app, and an
 * embedded field costs zero extra queries to render meta tags, vs. a join
 * against a separate `SeoMeta` collection on every storefront page view.
 *
 * `SeoResolutionService` (seo/services/seo-resolution.service.ts) is what
 * actually reads this — walking entity → category → store → global-template
 * fallback — so most entities never need every field filled in here.
 */
@Schema({ _id: false })
export class SeoMeta {
  @Prop({ type: String, default: null }) metaTitle: string | null;
  @Prop({ type: String, default: null }) metaDescription: string | null;
  @Prop({ type: String, default: null }) ogImage: string | null;
  @Prop({ type: String, default: null }) ogTitle: string | null;
  @Prop({ type: String, default: null }) ogDescription: string | null;
  @Prop({ type: String, enum: ['summary', 'summary_large_image'], default: 'summary_large_image' })
  twitterCard: string;
  @Prop({ type: String, default: null }) canonicalUrlOverride: string | null;
  @Prop({ type: Boolean, default: false }) noindex: boolean;
  @Prop({ type: [String], default: [] }) keywords: string[];
  // True if the current values came from SeoAiService rather than a manual
  // edit — surfaced in the seller UI as an "AI-generated, review me" badge.
  // Flips back to false the moment a human edits any field above.
  @Prop({ type: Boolean, default: false }) aiGenerated: boolean;
  @Prop({ type: Date, default: null }) updatedAt: Date | null;
}

export const SeoMetaSchema = SchemaFactory.createForClass(SeoMeta);
