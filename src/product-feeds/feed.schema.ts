/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'product_feed_configs' })
export class ProductFeedConfig {
  @Prop({ required: true, unique: true }) storeId: string;
  /** Secret part of the public feed URLs. Regenerating it switches the old URLs off. */
  @Prop({ required: true }) token: string;
  @Prop({ default: false }) enabled: boolean;
  /** Extra currencies the seller offers (the feed converts with the platform rates). */
  @Prop({ type: [String], default: [] }) currencies: string[];
  @Prop({ type: Date, default: null }) lastFetchedAt: Date | null;
  @Prop({ default: 0 }) fetchCount: number;
}
export type ProductFeedConfigDocument = HydratedDocument<ProductFeedConfig>;
export const ProductFeedConfigSchema = SchemaFactory.createForClass(ProductFeedConfig);
