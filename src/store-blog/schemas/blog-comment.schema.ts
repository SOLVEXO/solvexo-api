/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BlogCommentDocument = HydratedDocument<BlogComment>;

export const BLOG_COMMENT_STATUSES = ['pending', 'approved', 'spam'] as const;
export type BlogCommentStatus = (typeof BLOG_COMMENT_STATUSES)[number];

// Real comment moderation — every comment starts 'pending' and is never
// shown publicly until a seller approves it (only on a blog with
// `Blog.commentsEnabled: true`, enforced in the service, not here).
@Schema({ timestamps: true })
export class BlogComment {
  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true, index: true })
  blogPostId: string;

  @Prop({ type: String, required: true })
  authorName: string;

  @Prop({ type: String, required: true })
  authorEmail: string;

  @Prop({ type: String, required: true })
  body: string;

  @Prop({ type: String, enum: BLOG_COMMENT_STATUSES, default: 'pending' })
  status: BlogCommentStatus;

  createdAt?: Date;
  updatedAt?: Date;
}

export const BlogCommentSchema = SchemaFactory.createForClass(BlogComment);

BlogCommentSchema.index({ blogPostId: 1, status: 1, createdAt: -1 });
BlogCommentSchema.index({ storeId: 1, status: 1, createdAt: -1 });
