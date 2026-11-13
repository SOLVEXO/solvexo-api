/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const EXPERIMENT_STATUSES = ['draft', 'running', 'paused', 'stopped'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export type ExperimentKind = 'section' | 'theme_settings';

/**
 * An A/B test on ONE section's settings (`section`) or on theme settings (`theme_settings`).
 * Variant `a` is always the current look (no changes); variant `b` carries `overrides`: plain settings values only
 * (no code, no HTML structure). Visitors are bucketed by a hash of their random analytics visitor id, so a visitor
 * keeps the same variant, and only visitors who allowed analytics ever enter a test.
 */
@Schema({ timestamps: true, collection: 'experiments' })
export class Experiment {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 80 }) name: string;
  @Prop({ type: String, enum: ['section', 'theme_settings'], required: true }) kind: ExperimentKind;
  @Prop({ type: String, enum: EXPERIMENT_STATUSES, default: 'draft' }) status: ExperimentStatus;
  /** Share of eligible visitors that enter the test (1-100). */
  @Prop({ type: Number, default: 100 }) trafficPercent: number;
  /** Share of the entered visitors that see variant b (1-99). */
  @Prop({ type: Number, default: 50 }) splitB: number;
  /** kind 'section': the section `_id` (string) the overrides are applied to. */
  @Prop({ type: String, default: null }) sectionId: string | null;
  @Prop({ type: String, default: '', maxlength: 80 }) variantBName: string;
  @Prop({ type: Object, default: {} }) overrides: Record<string, string | number | boolean>;
  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) stoppedAt: Date | null;
  /** After the seller picks a winner: 'a' (back to the original for everyone) or 'b' (b is served to everyone). */
  @Prop({ type: String, enum: ['a', 'b', null], default: null }) winner: 'a' | 'b' | null;
  @Prop({ type: Date, default: null }) appliedAt: Date | null;
}
export type ExperimentDocument = Experiment & Document;
export const ExperimentSchema = SchemaFactory.createForClass(Experiment);
ExperimentSchema.index({ storeId: 1, status: 1 });
