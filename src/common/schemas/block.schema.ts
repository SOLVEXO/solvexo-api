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
 *
 * Stable per-item identity for drag-reorder/duplicate/hide-without-delete
 * comes from Mongoose's own auto-generated subdocument `_id` (every element
 * of a `[BlockSchema]` array already gets a real ObjectId `_id` by default —
 * confirmed already relied on as the React key in `SectionRenderer.tsx` and
 * typed as `Block._id?: string` on the frontend) — no separate custom `id`
 * field needed, and every existing block already has one, so there is
 * nothing to backfill for identity.
 */
@Schema({ timestamps: false })
export class Block {
  @Prop({ type: String, required: true }) type: string;
  @Prop({ type: Object, default: () => ({}) }) settings: Record<string, any>;

  // Lets a seller hide a block without losing its content (distinct from
  // actually removing it from the array, which is the real "delete") — see
  // SectionRenderer.tsx, which treats a missing/undefined value the same as
  // `true` so no migration is needed for pre-existing blocks.
  @Prop({ type: Boolean, default: true }) enabled: boolean;
}

export const BlockSchema = SchemaFactory.createForClass(Block);
