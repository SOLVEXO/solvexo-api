/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Block, BlockSchema } from '../../common/schemas/block.schema';

export type BlogPostDocument = HydratedDocument<BlogPost>;

export const BLOG_POST_STATUSES = ['draft', 'scheduled', 'published'] as const;
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

  // Which named `Blog` this post belongs to — nullable at the schema level
  // only so a pre-existing post (created before multi-blog support existed)
  // stays readable; `StoreBlogService.ensureDefaultBlog` lazily backfills it
  // to the store's auto-created default blog on first read, same "lazy but
  // persisted" convention as Category/Campaign slug backfills elsewhere.
  @Prop({ type: String, default: null, index: true })
  blogId: string | null;

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

  // Future-dated publish — was previously 100% unsupported (publish() always
  // went live immediately, no field existed to hold a future date). A real
  // 'scheduled' status sits between 'draft' and 'published'; a minute-tick
  // cron (SchedulerService#publishScheduledBlogPosts) flips it to
  // 'published' once due, same pattern as Product's own scheduled-activation
  // job. Cleared back to null once published (by either the cron or a
  // seller re-publishing immediately).
  @Prop({ type: Date, default: null })
  scheduledAt: Date | null;

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
