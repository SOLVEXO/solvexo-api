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
  /** Draft a reply to every incoming WhatsApp message (a person always sends it). */
  @Prop({ type: Boolean, default: true }) aiWhatsApp: boolean;

  // ── Solvexo's own WhatsApp Business number (Meta Cloud API) ─────────────
  @Prop({ type: String, default: null }) waPhoneNumberId: string | null;
  @Prop({ type: String, default: null }) waWabaId: string | null;
  @Prop({ type: String, default: null }) waDisplayNumber: string | null;
  @Prop({ type: String, default: null }) waVerifiedName: string | null;
  /** Permanent System User token, encrypted (INTEGRATIONS key). Never sent to the browser. */
  @Prop({ type: String, default: null }) waAccessTokenEnc: string | null;
  /** Approved template used to restart a chat after the 24-hour window. */
  @Prop({ type: String, default: null }) waTemplateName: string | null;
  @Prop({ type: String, default: 'en' }) waTemplateLang: string;
  /** The template's body has {{1}} for the person's first name. */
  @Prop({ type: Boolean, default: false }) waTemplateUsesName: boolean;
  /**
   * Approved templates a rep can pick from (max 20), each checked with Meta when saved. When empty, the single
   * template above (saved before lists existed) is used.
   */
  @Prop({
    type: [{ _id: false, key: String, label: String, name: String, lang: String, usesName: Boolean, body: { type: String, default: null } }],
    default: [],
  })
  waTemplates: { key: string; label: string; name: string; lang: string; usesName: boolean; body: string | null }[];
  @Prop({ type: Date, default: null }) waConnectedAt: Date | null;
  @Prop({ type: Date, default: null }) waLastEventAt: Date | null;

  // ── Brevo (marketing email) — see sales-brevo.service.ts ─────────────────
  /** Brevo API key, encrypted (INTEGRATIONS key). Never sent to the browser. */
  @Prop({ type: String, default: null }) brevoApiKeyEnc: string | null;
  @Prop({ type: String, default: null }) brevoAccountEmail: string | null;
  @Prop({ type: Number, default: null }) brevoListId: number | null;
  @Prop({ type: String, default: null }) brevoListName: string | null;
  @Prop({ type: Number, default: null }) brevoFolderId: number | null;
  @Prop({ type: Date, default: null }) brevoConnectedAt: Date | null;
  @Prop({ type: Date, default: null }) brevoLastSyncAt: Date | null;
  @Prop({ type: String, default: null }) brevoLastError: string | null;
  /** Secret path segment of the Brevo webhook URL (32 hex characters), made on the first connect. */
  @Prop({ type: String, default: null }) brevoWebhookSecret: string | null;
}

export const SalesSettingsSchema = SchemaFactory.createForClass(SalesSettings);
