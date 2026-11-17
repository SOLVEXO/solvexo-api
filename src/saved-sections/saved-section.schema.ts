import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { Block, BlockSchema } from '../common/schemas/block.schema';
import { SECTION_TYPES, SectionType } from '../common/schemas/section.schema';

/**
 * One reusable section of a store's library ("global section"): built once, placed on many pages as a `saved_section`
 * reference. Changing the entry changes every page that uses it. Content only: where it sits, whether it is hidden
 * and its lock belong to the page that references it.
 */
@Schema({ timestamps: true, collection: 'savedsections' })
export class SavedSection {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true, maxlength: 60 }) name: string;
  /** Lower-cased name: two entries of one store cannot share a name. */
  @Prop({ type: String, required: true }) nameKey: string;
  @Prop({ type: String, enum: SECTION_TYPES, required: true }) type: SectionType;
  @Prop({ type: Object, default: () => ({}) }) settings: Record<string, any>;
  @Prop({ type: [BlockSchema], default: [] }) blocks: Block[];
  @Prop({ type: String, default: null }) colorSchemeId: string | null;
}

export type SavedSectionDocument = SavedSection & Document;
export const SavedSectionSchema = SchemaFactory.createForClass(SavedSection);
SavedSectionSchema.index({ storeId: 1, nameKey: 1 }, { unique: true });
