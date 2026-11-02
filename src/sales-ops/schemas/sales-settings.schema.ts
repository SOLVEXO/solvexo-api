/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesSettingsDocument = SalesSettings & Document;

/** Sales Ops settings: one document, key 'default'. */
@Schema({ timestamps: true, collection: 'sales_settings' })
export class SalesSettings {
  @Prop({ type: String, required: true, unique: true, default: 'default' })
  key: string;
  /** Give new leads that arrive on their own (forms, messages, stalled sign-ups) to these reps in turn. */
  @Prop({ type: Boolean, default: false }) autoAssign: boolean;
  @Prop({ type: [String], default: [] }) assigneeIds: string[];
  /** Round-robin position; only ever incremented. */
  @Prop({ type: Number, default: 0 }) cursor: number;

  // ── AI sales agent (see sales-agent.service.ts) ──────────────────────────
  /** Master switch: nothing below runs while this is off. */
  @Prop({ type: Boolean, default: false }) aiEnabled: boolean;
  /** Email a personalised first reply to new demo requests / Contact Us leads, automatically. */
  @Prop({ type: Boolean, default: true }) aiFirstReply: boolean;
  /** Live chat on solvexo.store. */
  @Prop({ type: Boolean, default: true }) aiChat: boolean;
  @Prop({ type: String, default: 'Sana' }) aiAgentName: string;
  @Prop({ type: String, default: null }) aiGreeting: string | null;
  /** What the AI may tell people about Solvexo. It must not say anything that isn't here or in the live plans. */
  @Prop({ type: String, default: null }) aiKnowledge: string | null;
  /** Extra rules from the team, e.g. "Never mention competitors". */
  @Prop({ type: String, default: null }) aiRules: string | null;
  @Prop({ type: String, default: null }) aiSignOff: string | null;
  /** Where replies to the AI's emails go (else the lead owner's email). */
  @Prop({ type: String, default: null }) aiReplyTo: string | null;
  /** Most new chats per day (Pakistan time); a guard on cost and abuse. */
  @Prop({ type: Number, default: 300 }) aiChatDailyLimit: number;
}

export const SalesSettingsSchema = SchemaFactory.createForClass(SalesSettings);
