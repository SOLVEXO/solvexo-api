/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Section, SectionSchema } from '../../common/schemas/section.schema';

export type CollectionTemplateDocument = HydratedDocument<CollectionTemplate>;

export const COLLECTION_TEMPLATE_STATUSES = ['draft', 'published'] as const;
export type CollectionTemplateStatus = (typeof COLLECTION_TEMPLATE_STATUSES)[number];

// Same draft/live split as `StorePageDraft` (store-pages/schemas/store-page.schema.ts)
// and `StoreThemeDraft` — every `updateSections` call lands here first; only
// `publish()` copies `draft.sections` into the live `sections` field below.
@Schema({ _id: false })
export class CollectionTemplateDraft {
  @Prop({ type: [SectionSchema], default: [] })
  sections: Section[];
}
export const CollectionTemplateDraftSchema = SchemaFactory.createForClass(CollectionTemplateDraft);

// Same real-snapshot version-history mechanism as StoreTheme/StorePage, via
// the shared ContentVersioningService — not a separately hand-rolled copy.
@Schema({ _id: true, timestamps: false })
export class CollectionTemplateVersion {
  @Prop({ type: [SectionSchema], default: [] })
  sections: Section[];

  @Prop({ type: Date, required: true })
  publishedAt: Date;
}
export const CollectionTemplateVersionSchema = SchemaFactory.createForClass(CollectionTemplateVersion);

export const RESOURCE_TEMPLATE_TYPES = ['collection', 'product', 'page'] as const;
export type ResourceTemplateType = (typeof RESOURCE_TEMPLATE_TYPES)[number];

/**
 * A section-editable ALTERNATE TEMPLATE for a resource type (Collection or
 * Product — Page already has its own per-page `StorePage.sections`, so
 * `'page'` here only ever holds re-usable *starter* templates a seller can
 * assign a new custom page from, see `store-pages` for the assignment side).
 * One store can have several named templates per `resourceType` — e.g.
 * `collection.default` + `collection.sale`, `product.default` +
 * `product.minimal` — the exact Shopify-class "alternate templates"
 * capability. `{storeId, resourceType, templateKey}` is the unique key
 * (was `storeId` alone, back when a store could only ever have one shared
 * Collection layout) — every pre-existing document is backfilled to
 * `resourceType: 'collection', templateKey: 'default'`, so nothing about
 * today's single-collection-layout behavior changes for a store that never
 * creates a second template.
 *
 * `Product.templateKey`/`Collection.templateKey` (new fields on those
 * schemas) name which of a store's own templates a given resource renders
 * through; `StorefrontProductPage`/`CategoryBrowsePage`/`CollectionDetailPage`
 * resolve surrounding sections here, with commerce-critical UI (gallery,
 * variant/qty/add-to-cart, the grid's own product data) staying fixed —
 * never section/block-configurable, per the architectural boundary the rest
 * of this storefront-content system already follows.
 */
@Schema({ timestamps: true })
export class CollectionTemplate {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ type: String, enum: RESOURCE_TEMPLATE_TYPES, default: 'collection', index: true })
  resourceType: ResourceTemplateType;

  @Prop({ type: String, default: 'default' })
  templateKey: string;

  // Merchant-facing label ("Default", "Sale Collection", "Minimal Product")
  // shown in the template picker — distinct from `templateKey`, which is the
  // stable identifier resources reference and never changes once assigned.
  @Prop({ type: String, default: 'Default' })
  name: string;

  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

  // LIVE/PUBLISHED copy — read by the public storefront. Sellers edit
  // `draft.sections`; only `publish()` copies it here.
  @Prop({ type: [SectionSchema], default: [] })
  sections: Section[];

  // Defaults to a copy of the live `sections` at read time for any template
  // that predates this field (see `CollectionTemplateService`'s backfill).
  @Prop({ type: CollectionTemplateDraftSchema, default: () => ({}) })
  draft: CollectionTemplateDraft;

  @Prop({ type: Date, default: null })
  lastPublishedAt: Date | null;

  @Prop({ type: [CollectionTemplateVersionSchema], default: [] })
  versions: CollectionTemplateVersion[];

  @Prop({ type: String, enum: COLLECTION_TEMPLATE_STATUSES, default: 'draft' })
  status: CollectionTemplateStatus;

  createdAt?: Date;
  updatedAt?: Date;
}

export const CollectionTemplateSchema = SchemaFactory.createForClass(CollectionTemplate);

// Replaces the old single-field unique index on `storeId` — see the class
// comment above and `scripts/migrate-installed-themes.ts`'s sibling
// migration note (a real deployment needs the old index dropped once; run
// the equivalent one-off backfill for this collection before relying on
// multiple templates per store).
CollectionTemplateSchema.index({ storeId: 1, resourceType: 1, templateKey: 1 }, { unique: true });
