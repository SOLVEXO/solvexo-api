/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AnnouncementDocument = Announcement & Document;

@Schema({ timestamps: true })
export class Announcement {
  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  message: string;

  @Prop({ type: String, enum: ['all', 'sellers', 'buyers'], default: 'all' })
  audience: string;

  @Prop({ type: String, enum: ['draft', 'published', 'scheduled'], default: 'draft' })
  status: string;

  @Prop({ type: Date, default: null })
  scheduledAt: Date | null;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;

  @Prop({ type: String, default: null })
  createdBy: string | null;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const AnnouncementSchema = SchemaFactory.createForClass(Announcement);

AnnouncementSchema.index({ status: 1, createdAt: -1 });
AnnouncementSchema.index({ audience: 1 });
