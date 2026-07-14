/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AiGenerationDocument = AiGeneration & Document;

export const AI_TOOL_TYPES = [
  'listing_writer',
  'price_optimizer',
  'worksheet_builder',
  'seo_booster',
  'email_campaigns',
  'image_enhancer',
] as const;
export type AiToolType = (typeof AI_TOOL_TYPES)[number];

/**
 * One row per generation attempt — "Regenerate" always creates a NEW row
 * (linked via `sessionId` + `regeneratedFromId`), never overwrites, so sellers
 * can browse prior generations. For the Image Enhancer this row doubles as the
 * async job record: the endpoint returns `_id` as the `jobId` and the client
 * polls until `status` leaves 'processing'.
 */
@Schema({ timestamps: true })
export class AiGeneration {
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) storeId: string;

  @Prop({ type: String, enum: AI_TOOL_TYPES, required: true })
  toolType: AiToolType;

  // 'processing' only occurs for async tools (image_enhancer); text tools go
  // straight to succeeded/failed within the request.
  @Prop({ type: String, enum: ['processing', 'succeeded', 'failed'], default: 'processing' })
  status: string;

  @Prop({ type: Object, default: {} }) inputPayload: Record<string, any>;
  @Prop({ type: Object, default: null }) outputPayload: Record<string, any> | null;

  @Prop({ type: String, default: null }) errorMessage: string | null;

  // 'claude' | 'mock' | 'stub' (+ the concrete model id for observability)
  @Prop({ type: String, default: null }) providerUsed: string | null;
  @Prop({ type: String, default: null }) modelUsed: string | null;

  @Prop({ type: Number, default: 0 }) creditsCharged: number;

  // Groups a chain of regenerations for the same task/product.
  @Prop({ type: String, required: true }) sessionId: string;
  @Prop({ type: String, default: null }) regeneratedFromId: string | null;

  // Optional product the generation was made for / applied to.
  @Prop({ type: String, default: null }) productId: string | null;

  // "Use This" — seller accepted the output (optionally written to the product).
  @Prop({ type: Boolean, default: false }) accepted: boolean;
  @Prop({ type: Date, default: null }) acceptedAt: Date | null;
  @Prop({ type: Boolean, default: false }) appliedToProduct: boolean;
}

export const AiGenerationSchema = SchemaFactory.createForClass(AiGeneration);
AiGenerationSchema.index({ storeId: 1, createdAt: -1 });
AiGenerationSchema.index({ storeId: 1, toolType: 1, createdAt: -1 });
AiGenerationSchema.index({ sessionId: 1 });
