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

/**
 * Exactly one document per store — the section-editable layout every
 * `/collections/:slugOrId` browse page on that store's storefront renders
 * through, generalizing the same Section/Block system Home/Pages already
 * use to Collection pages (previously a hardcoded static grid, see
 * `CollectionDetailPage.tsx`). Unlike `StorePage`, there is no `slug`/`type`
 * discriminator — `storeId` alone is the unique key, since a store only ever
 * has one Collection template (every named collection shares it).
 */
@Schema({ timestamps: true })
export class CollectionTemplate {
  _id: string;

  @Prop({ required: true, unique: true, index: true })
  storeId: string;

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
