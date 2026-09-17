/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BlogDocument = HydratedDocument<Blog>;

// The "multiple blogs" container (Shopify's own "Blogs" concept) — a store
// can run more than one named blog (News, Recipes, Behind the Scenes…),
// each with its own set of `BlogPost`s. Every store gets one auto-created
// default blog (`StoreBlogService.ensureDefaultBlog`, slug `'blog'`) so the
// pre-existing single-blog storefront route (`/blog`) keeps working exactly
// as before for a store that never creates a second one.
@Schema({ timestamps: true })
export class Blog {
  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  title: string;

  @Prop({ type: String, required: true })
  slug: string;

  // Real comment moderation is opt-in per blog, not per post — matches how
  // a merchant actually thinks about it ("turn comments on for my News
  // blog") rather than a per-article toggle.
  @Prop({ type: Boolean, default: false })
  commentsEnabled: boolean;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const BlogSchema = SchemaFactory.createForClass(Blog);

BlogSchema.index({ storeId: 1, slug: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
