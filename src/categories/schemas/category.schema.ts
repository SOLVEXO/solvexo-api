/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CategoryDocument = Category & Document;

@Schema({ timestamps: true })
export class Category {

  @Prop({ required: true })
  name: string;


@Prop({ type: String, default: null })
parentId: string | null;

@Prop({ type: String, default: null })
image: string;

@Prop({ type: String, default: null })
description: string | null;


  @Prop({ default: 0 })
  sortOrder: number;


  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status: string;

  @Prop({ default: false })
  isDelete: boolean;

}

export const CategorySchema = SchemaFactory.createForClass(Category);

// indexes
CategorySchema.index({ name: 1 });
CategorySchema.index({ parentId: 1 });