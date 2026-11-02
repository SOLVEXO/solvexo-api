/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesChatSessionDocument = SalesChatSession & Document;

/** One visitor conversation with the AI sales agent on solvexo.store. `token` is the visitor's secret handle. */
@Schema({ timestamps: true, collection: 'sales_chat_sessions' })
export class SalesChatSession {
  @Prop({ type: String, required: true, unique: true }) token: string;
  @Prop({
    type: [
      {
        role: { type: String, enum: ['visitor', 'agent'] },
        text: String,
        at: Date,
      },
    ],
    default: [],
  })
  messages: { role: 'visitor' | 'agent'; text: string; at: Date }[];
  /** What the visitor told the agent about themselves (merged turn by turn). */
  @Prop({ type: Object, default: {} }) details: Record<string, string>;
  @Prop({ type: String, default: null }) summary: string | null;
  @Prop({ type: String, default: null }) language: string | null;
  @Prop({ type: String, default: null, index: true }) leadId: string | null;
  @Prop({ type: String, enum: ['open', 'handed_over'], default: 'open' })
  status: string;
  @Prop({ type: String, default: null }) page: string | null;
  @Prop({ type: Object, default: null }) utm: Record<
    string,
    string | null
  > | null;
  @Prop({ type: String, default: null }) partnerCode: string | null;
}

export const SalesChatSessionSchema =
  SchemaFactory.createForClass(SalesChatSession);
SalesChatSessionSchema.index({ createdAt: -1 });
