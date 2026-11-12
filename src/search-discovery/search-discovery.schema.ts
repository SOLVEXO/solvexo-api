/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'search_configs' })
export class SearchConfig {
  @Prop({ required: true, unique: true }) storeId: string;
  /** Groups of words that mean the same thing for this store (e.g. sofa / couch / settee). */
  @Prop({ type: [{ _id: false, terms: [String] }], default: [] }) synonyms: { terms: string[] }[];
  /** For an exact query, these products come first. */
  @Prop({ type: [{ _id: false, query: String, productIds: [String] }], default: [] }) pinned: { query: string; productIds: string[] }[];
  @Prop({ type: [{ _id: false, key: String, enabled: Boolean }], default: [] }) filters: { key: string; enabled: boolean }[];
}
export type SearchConfigDocument = HydratedDocument<SearchConfig>;
export const SearchConfigSchema = SchemaFactory.createForClass(SearchConfig);

/** One row per store + searched phrase that found nothing. */
@Schema({ timestamps: false, collection: 'search_misses' })
export class SearchMiss {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) query: string;
  @Prop({ default: 0 }) count: number;
  @Prop({ type: Date, default: Date.now }) lastAt: Date;
}
export type SearchMissDocument = HydratedDocument<SearchMiss>;
export const SearchMissSchema = SchemaFactory.createForClass(SearchMiss);
SearchMissSchema.index({ storeId: 1, query: 1 }, { unique: true });
SearchMissSchema.index({ lastAt: 1 }, { expireAfterSeconds: 90 * 86_400 });
