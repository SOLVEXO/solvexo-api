/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { SeoMeta, SeoMetaSchema } from '../../seo/schemas/seo-meta.schema';

export type CategoryDocument = Category & Document;

@Schema({ timestamps: true })
export class Category {

  @Prop({ required: true })
  name: string;

  // URL-safe handle for the public marketplace path (/marketplace/:slug).
  // Generated once at creation (see CategoriesService.addCategory) — there
  // is no rename/update-category endpoint today, so this never changes.
  // Uniqueness is enforced by the compound {storeId, slug} index below, not
  // here — a bare `unique: true` used to mean two unrelated sellers' own
  // private categories (storeId set) collided with EACH OTHER globally, and
  // a soft-deleted category's slug stayed permanently squatted forever
  // (found as a real bug during the Catalog audit). The compound index
  // still enforces real global uniqueness among the admin-curated
  // storeId:null tree, since every one of those rows shares the same
  // storeId value — no special-casing needed for that case.
  @Prop({ type: String, sparse: true })
  slug: string;

@Prop({ type: String, default: null })
parentId: string | null;

// null = legacy/global/admin-curated taxonomy (unchanged — still what
// Marketplace browse, admin curation, and SEO/sitemap read). A real value
// makes this category privately owned by that one store — created freely
// by the seller from their own store's Categories page, never visible to
// or reusable by any other store. See CategoriesService for the scoping.
@Prop({ type: String, default: null })
storeId: string | null;

@Prop({ type: String, default: null })
image: string;

@Prop({ type: String, default: null })
description: string | null;


  @Prop({ default: 0 })
  sortOrder: number;


  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status: string;

  @Prop({ default: false })
  isDelete: boolean;

  // Who created this category — admin (main categories) or a seller
  // (optional subcategories). Lets a seller's own subcategories be told
  // apart from the admin-curated taxonomy.
  @Prop({ type: String, default: null })
  createdBy: string | null;

  @Prop({ type: String, enum: ['admin', 'seller'], default: null })
  createdByRole: string | null;

  // Admin-managed SEO override for this category's marketplace page. See
  // seo/schemas/seo-meta.schema.ts — root categories are admin-only anyway
  // (CategoriesService.addCategory), so this is edited exclusively via
  // admin/seo/categories/:id, never by sellers.
  @Prop({ type: SeoMetaSchema, default: () => ({}) })
  seo: SeoMeta;

}

export const CategorySchema = SchemaFactory.createForClass(Category);

// indexes
CategorySchema.index({ name: 1 });
CategorySchema.index({ parentId: 1 });
CategorySchema.index({ createdBy: 1 });
CategorySchema.index({ storeId: 1 });
// Real per-scope uniqueness — replaces the old bare `slug: { unique: true }`
// field-level index (see that field's own doc comment). Partial-filtered on
// isDelete so a deleted category never permanently squats its slug.
CategorySchema.index({ storeId: 1, slug: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
// A genuinely separate, previously-undocumented bug found alongside the
// slug one during the Catalog audit: the real live database carried a bare
// global-unique index on `name` alone (no `unique: true` anywhere in this
// schema file to explain it — a stale leftover the app-level duplicate-name
// check in CategoriesService, itself already correctly scoped to
// {storeId, parentId, name}, had been silently overridden by). This compound
// index matches that same real, intended scope instead of enforcing a
// platform-wide unique name.
CategorySchema.index(
  { storeId: 1, parentId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDelete: false } },
);