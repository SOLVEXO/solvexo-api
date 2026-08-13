/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Block, BlockSchema } from '../../common/schemas/block.schema';

export type BlogPostDocument = HydratedDocument<BlogPost>;

export const BLOG_POST_STATUSES = ['draft', 'published'] as const;
export type BlogPostStatus = (typeof BLOG_POST_STATUSES)[number];

// A seller's storefront blog post — body content reuses the same generic
// `Block` shape as rich-text sections (paragraph/heading/image/quote/list/
// divider), not raw HTML, for the same reason: no WYSIWYG-HTML XSS surface
// on a page with zero platform chrome. Gated by the `storefrontBlog` feature
// flag on writes only (reads stay ungated), same convention as `storeBuilder`.
@Schema({ timestamps: true })
export class BlogPost {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  title: string;

  @Prop({ type: String, required: true })
  slug: string;

  @Prop({ type: String, default: null })
  coverImage: string | null;

  @Prop({ type: String, default: '' })
  excerpt: string;

  @Prop({ type: [BlockSchema], default: [] })
  content: Block[];

  @Prop({ type: String, enum: BLOG_POST_STATUSES, default: 'draft' })
  status: BlogPostStatus;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const BlogPostSchema = SchemaFactory.createForClass(BlogPost);

BlogPostSchema.index({ storeId: 1, slug: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
BlogPostSchema.index({ storeId: 1, status: 1, publishedAt: -1 });
