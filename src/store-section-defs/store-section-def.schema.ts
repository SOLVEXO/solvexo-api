import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** One seller-built section ("Section builder"). See `store-section-def.util.ts` for the layout language. */
@Schema({ timestamps: true, collection: 'storesectiondefs' })
export class StoreSectionDef {
  @Prop({ type: String, required: true }) storeId: string;
  /** `my.<slug>`: what a page's `theme_section` points at. Never changes after creation. */
  @Prop({ type: String, required: true }) key: string;
  @Prop({ type: String, required: true, maxlength: 60 }) name: string;
  @Prop({ type: String, required: true }) nameKey: string;
  @Prop({ type: String, default: '', maxlength: 200 }) description: string;
  @Prop({ type: String, default: null }) color: string | null;
  /** The checked, normalised layout tree. */
  @Prop({ type: Object, required: true }) layout: Record<string, any>;
  /** Derived from the layout at save time (what the editor form is built from). */
  @Prop({ type: [Object], default: [] }) fields: Record<string, any>[];
  @Prop({ type: Object, default: null }) block: Record<string, any> | null;
  @Prop({ type: Object, default: () => ({}) }) defaults: Record<string, any>;
  @Prop({ type: Number, default: 0 }) initialBlocks: number;
}

export type StoreSectionDefDocument = StoreSectionDef & Document;
export const StoreSectionDefSchema = SchemaFactory.createForClass(StoreSectionDef);
StoreSectionDefSchema.index({ storeId: 1, key: 1 }, { unique: true });
StoreSectionDefSchema.index({ storeId: 1, nameKey: 1 }, { unique: true });
