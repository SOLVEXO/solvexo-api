import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RecentSearchDocument = RecentSearch & Document;

/** One search term a buyer has run — upserted per (user, query), so repeating
 *  a search bumps it to the top instead of duplicating it. */
@Schema({ timestamps: true })
export class RecentSearch {
  @Prop({ type: String, required: true })
  userId!: string;

  // Which store this search happened in — a per-store buyer account only
  // ever has one value here, but the legacy cross-store "apex" account can
  // rack up history from several stores, and one single-store app build
  // must only ever show/clear its own.
  @Prop({ type: String, default: null })
  storeId!: string | null;

  /** Normalized (trimmed, lowercased) — what dedup keys on. */
  @Prop({ type: String, required: true })
  query!: string;

  /** As the user typed it (minus outer whitespace) — what the app displays. */
  @Prop({ type: String, required: true })
  displayQuery!: string;

  @Prop({ type: Number, default: 1 })
  count!: number;
}

export const RecentSearchSchema = SchemaFactory.createForClass(RecentSearch);
RecentSearchSchema.index({ userId: 1, storeId: 1, query: 1 }, { unique: true });
RecentSearchSchema.index({ userId: 1, storeId: 1, updatedAt: -1 });
