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
  // Generic, reusable additions (Theme Ecosystem Phase 3) — cover the
  // category-specific asks (lookbook/ingredients/menu/team/location/stats)
  // without a bespoke section per category. See section-settings.validator.ts
  // for each one's settings/block shape.
  'feature_list',
  'spec_table',
  'menu_list',
  'team_grid',
  'location_info',
  'stats_counter',
  'gallery_grid',
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

  // Hide-without-delete — SectionRenderer.tsx skips anything with
  // enabled:false on the public storefront while the builder still shows it
  // (greyed, with a re-enable control) so a seller never loses content by
  // hiding it.
  @Prop({ type: Boolean, default: true }) enabled: boolean;
}

export const SectionSchema = SchemaFactory.createForClass(Section);
