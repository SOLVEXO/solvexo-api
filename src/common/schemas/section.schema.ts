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
  @Prop({ type: String, enum: SECTION_TYPES, required: true }) type: SectionType;
  @Prop({ type: Object, default: () => ({}) }) settings: Record<string, any>;
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[];
}

export const SectionSchema = SchemaFactory.createForClass(Section);
