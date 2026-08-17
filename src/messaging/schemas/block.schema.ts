/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BlockDocument = Block & Document;

@Schema({ timestamps: true })
export class Block {
  @Prop({ type: String, required: true }) blockerId: string;
  @Prop({ type: String, enum: ['user', 'seller'], required: true }) blockerRole: string;

  @Prop({ type: String, required: true }) targetId: string;
  @Prop({ type: String, enum: ['user', 'seller'], required: true }) targetRole: string;

  @Prop({ type: String, default: null }) reason: string | null;
}

export const BlockSchema = SchemaFactory.createForClass(Block);

BlockSchema.index({ blockerId: 1, targetId: 1 }, { unique: true });
BlockSchema.index({ targetId: 1 });
