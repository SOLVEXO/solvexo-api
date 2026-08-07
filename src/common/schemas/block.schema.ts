/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * Generic `{ type, settings }` content unit — reused everywhere a seller composes
 * their own storefront content: header nav links, footer columns/social links,
 * blocks nested inside a page Section (hero slides, testimonials, FAQ items,
 * rich-text paragraphs/headings/images), and blog post body content. One shape,
 * many contexts — `type` is deliberately a plain string (not schema-level
 * enum-locked) since the set of valid types differs by parent context; each
 * write path validates it against the right allow-list via
 * `common/store-content/section-settings.validator.ts` instead.
 */
@Schema({ timestamps: false })
export class Block {
  @Prop({ type: String, required: true }) type: string;
  @Prop({ type: Object, default: () => ({}) }) settings: Record<string, any>;
}

export const BlockSchema = SchemaFactory.createForClass(Block);
