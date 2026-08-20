/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Section, SectionSchema } from '../../common/schemas/section.schema';

export type StorePageDocument = HydratedDocument<StorePage>;

export const STORE_PAGE_TYPES = ['home', 'custom'] as const;
export type StorePageType = (typeof STORE_PAGE_TYPES)[number];

export const STORE_PAGE_STATUSES = ['draft', 'published'] as const;
export type StorePageStatus = (typeof STORE_PAGE_STATUSES)[number];

// Brought to parity with the shared `SeoMeta` shape (`Product.seo`/
// `Category.seo`) — previously just `{metaTitle, metaDesc}`, the only
// non-symmetric SEO shape in the app. `metaDesc` is kept, additive, as a
// deprecated read-fallback for one release (see `store-pages.service.ts`'s
// resolution helper) — new writes should target `metaDescription`.
@Schema({ _id: false })
export class StorePageSeo {
  @Prop({ type: String, default: null }) metaTitle: string | null;
  /** @deprecated superseded by `metaDescription` — kept as a read-fallback only. */
  @Prop({ type: String, default: null }) metaDesc: string | null;
  @Prop({ type: String, default: null }) metaDescription: string | null;
  @Prop({ type: String, default: null }) ogImage: string | null;
  @Prop({ type: String, default: null }) ogTitle: string | null;
  @Prop({ type: String, default: null }) ogDescription: string | null;
  @Prop({ type: String, enum: ['summary', 'summary_large_image'], default: 'summary_large_image' })
  twitterCard: string;
  @Prop({ type: String, default: null }) canonicalUrlOverride: string | null;
  @Prop({ type: Boolean, default: false }) noindex: boolean;
  @Prop({ type: [String], default: [] }) keywords: string[];
}
export const StorePageSeoSchema = SchemaFactory.createForClass(StorePageSeo);

// A seller-composed page (the storefront home page, or an arbitrary custom
// page like "About Us"). Exactly one `type:'home'` doc exists per store, with
// a fixed empty-string slug, served at the bare `/:slug` route. Custom pages
// get a seller-chosen slug and are always served under `/:slug/pages/:slug`
// — that prefix is what keeps a custom page's slug from ever colliding with
// the separate `/:slug/blog` route, so no reserved-word list is needed here.
@Schema({ timestamps: true })
export class StorePage {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ type: String, enum: STORE_PAGE_TYPES, required: true })
  type: StorePageType;

  @Prop({ type: String, required: true })
  slug: string;

  @Prop({ type: String, required: true })
  title: string;

  // Embedded, array index = display order — the whole page is authored and
  // saved as one atomic unit from the builder, so a reorder is a single
  // `$set` of the whole array, not a per-document `order` field to reindex.
  @Prop({ type: [SectionSchema], default: [] })
  sections: Section[];

  @Prop({ type: StorePageSeoSchema, default: () => ({}) })
  seo: StorePageSeo;

  @Prop({ type: String, enum: STORE_PAGE_STATUSES, default: 'draft' })
  status: StorePageStatus;

  @Prop({ type: Boolean, default: false })
  showInNav: boolean;

  @Prop({ type: Boolean, default: false })
  showInFooter: boolean;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StorePageSchema = SchemaFactory.createForClass(StorePage);

StorePageSchema.index({ storeId: 1, slug: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
StorePageSchema.index({ storeId: 1, type: 1 });
