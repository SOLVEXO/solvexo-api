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
  // Metaobjects — lists real entries of a seller-defined custom content type
  // (see `metaobjects/`), e.g. every "Team Member" entry. Genuinely dynamic:
  // `settings.metaobjectType` is the only thing stored, resolved against the
  // store's own live entries at render time, never baked-in content.
  'metaobject_list',
  // Contextual — never placed via the general Pages/Home "Add Section"
  // picker (no `collectionId`/`heading` in its settings, unlike
  // `product_catalog`): it always renders whichever collection the visitor
  // is currently browsing. Exists only inside a store's singleton Collection
  // Template (see `collection-template/`), pre-seeded there and nowhere else.
  'collection_product_grid',
  // Theme-exclusive sections (frontend `sectionSchemaRegistry`'s
  // `exclusiveToTheme`) — only ever offered in their owning theme's Section
  // Library, but validated identically to every other section type here
  // since `settings`/`blocks` still arrive as untrusted network JSON
  // regardless of which theme's UI offered them.
  'editorial_lookbook',
  'farm_story',
  'drop_countdown',
  'craft_process',
  'tech_specs_compare',
  'soft_gallery',
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

  // Real per-section color override — references one of the store's own
  // saved `ColorScheme`s (store-theme.schema.ts) by `id`. Null (the
  // pre-existing-section-safe default) means "use the theme's own colors,
  // unchanged" — byte-identical rendering to before this field existed.
  // When set, the theme's `SectionRenderer` resolves the scheme and passes
  // its {bg, text, primary} colors into that one section's render function
  // instead of the theme-wide defaults — e.g. a seller can make one Hero
  // section dark while the rest of the page stays light. Deliberately
  // stored as a plain string reference (not embedded/denormalized) so
  // renaming or deleting the scheme is a single source of truth; a section
  // whose referenced scheme no longer exists silently falls back to the
  // theme's own colors (see the frontend resolver), never a crash.
  @Prop({ type: String, default: null }) colorSchemeId: string | null;
}

export const SectionSchema = SchemaFactory.createForClass(Section);
