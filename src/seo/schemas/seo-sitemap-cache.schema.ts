/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoSitemapCacheDocument = SeoSitemapCache & Document;

export const SITEMAP_URL_LIMIT_PER_CHUNK = 45_000; // sitemap protocol caps at 50k/50MB — leaving headroom

// 'pages' means admin-authored `SeoLandingPage`s — seller storefront content
// (custom `StorePage`s and `BlogPost`s) gets its own type deliberately, not
// conflated with that admin-only meaning.
export const SITEMAP_TYPES = ['products', 'stores', 'categories', 'pages', 'storefront_content'] as const;
export type SitemapType = (typeof SITEMAP_TYPES)[number];

/**
 * Chunked sitemap XML cache — chunked from day one (see architecture plan
 * Refinement #7) so the design scales past the sitemap protocol's 50,000-
 * URL/50MB-per-file cap without a later rewrite. `storeId: null` = the
 * platform-wide sitemap (categories/pages, and stores); per-store product
 * sitemaps are keyed by `storeId` so a store's own catalog can be
 * regenerated independently of the rest of the marketplace.
 */
@Schema({ timestamps: true })
export class SeoSitemapCache {
  @Prop({ type: String, enum: SITEMAP_TYPES, required: true })
  type: SitemapType;

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: Number, required: true, default: 0 })
  chunkIndex: number;

  @Prop({ type: String, required: true })
  xml: string;

  @Prop({ type: Number, default: 0 })
  urlCount: number;

  @Prop({ type: Date, default: null })
  generatedAt: Date | null;
}

export const SeoSitemapCacheSchema = SchemaFactory.createForClass(SeoSitemapCache);
SeoSitemapCacheSchema.index({ type: 1, storeId: 1, chunkIndex: 1 }, { unique: true });
