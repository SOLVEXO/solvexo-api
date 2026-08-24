/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Block, BlockSchema } from './block.schema';

export const SECTION_TYPES = [
  'hero',
  'rich_text',
  'featured_products',
  'product_catalog',
  'image_with_text',
  'testimonials',
  'faq',
  'video',
  // Presentational/merchandising only — see the Store Builder implementation
  // plan's "Architectural Boundary" note: no section type ever represents
  // cart/checkout/account/orders/messaging/payments, which stay on their own
  // fixed routes outside this system entirely.
  'featured_category_grid',
  'trust_badges',
  'newsletter',
  // Contextual — never placed via the general Pages/Home "Add Section"
  // picker (no `collectionId`/`heading` in its settings, unlike
  // `product_catalog`): it always renders whichever collection the visitor
  // is currently browsing. Exists only inside a store's singleton Collection
  // Template (see `collection-template/`), pre-seeded there and nowhere else.
  'collection_product_grid',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/**
 * One entry in a `StorePage.sections` array — array index IS the display order
 * (no stored `order` field): the whole page is authored/saved as one atomic
 * unit from the builder, so a reorder is a whole-array rewrite, never a
 * per-document partial update. See `section-settings.validator.ts` for the
 * per-type `settings`/`blocks` shape each `type` actually accepts.
 */
@Schema({ timestamps: false })
export class Section {
  // Stable identity comes from Mongoose's own auto-generated subdocument
  // `_id` (same reasoning as Block — see block.schema.ts) — no separate
  // custom `id` field, nothing to backfill.
  @Prop({ type: String, enum: SECTION_TYPES, required: true }) type: SectionType;
  @Prop({ type: Object, default: () => ({}) }) settings: Record<string, any>;
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[];

  // Bumped whenever a section `type`'s settings shape changes in a
  // backward-incompatible way (see `section-settings.types.ts`) — lets a
  // future migration tell "old shape, needs backfill" apart from "already
  // current" without guessing from the data itself. 1 for every section that
  // exists today; nothing currently reads this yet (no migration exists
  // yet), it's the foundation for one.
  @Prop({ type: Number, default: 1 }) schemaVersion: number;

  // Hide-without-delete — SectionRenderer.tsx skips anything with
  // enabled:false on the public storefront while the builder still shows it
  // (greyed, with a re-enable control) so a seller never loses content by
  // hiding it.
  @Prop({ type: Boolean, default: true }) enabled: boolean;
}

export const SectionSchema = SchemaFactory.createForClass(Section);
