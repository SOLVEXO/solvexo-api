/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { COMPLIANCE_ORDER } from '../../tax-core/compliance.types';

export type PlatformTaxComplianceDocument = PlatformTaxCompliance & Document;

/**
 * How far one of SOLVEXO'S OWN tax registrations has been taken towards live e-invoicing. Platform only: a seller's compliance never
 * goes in this collection. Nothing here moves by itself except DOWNWARDS (see PlatformComplianceService.reconcile).
 */
@Schema({ timestamps: true, collection: 'platform_tax_compliance' })
export class PlatformTaxCompliance {
  @Prop({ type: String, required: true }) subjectType: string; // 'registration'
  /** `<entityKey>:<country>:<authority>` e.g. solvexo-platform:PK:PK_FBR */
  @Prop({ type: String, required: true }) subjectId: string;
  @Prop({ type: String, required: true }) entityKey: string;
  @Prop({ type: String, required: true }) country: string;
  @Prop({ type: String, required: true }) authority: string;
  @Prop({ type: String, enum: COMPLIANCE_ORDER, default: 'unsupported' }) state: string;
  /** What the state was reached WITH. If any of it changes later, the state falls back (registration, rules, adapter, token). */
  @Prop({ type: { _id: false, registrationNumber: { type: String, default: null }, rulePackHash: { type: String, default: null }, adapterVersion: { type: String, default: null }, tokenFingerprint: { type: String, default: null } }, default: () => ({}) })
  snapshot: { registrationNumber: string | null; rulePackHash: string | null; adapterVersion: string | null; tokenFingerprint: string | null };
  @Prop({ type: [{ _id: false, from: String, to: String, at: Date, by: String, byName: { type: String, default: null }, source: { type: String, default: null }, accountantName: { type: String, default: null }, note: { type: String, default: null }, auto: { type: Boolean, default: false } }], default: [] })
  history: Array<{ from: string; to: string; at: Date; by: string; byName: string | null; source: string | null; accountantName: string | null; note: string | null; auto: boolean }>;
  @Prop({ type: Date, default: null }) liveApprovedAt: Date | null;
  @Prop({ type: String, default: null }) liveApprovedBy: string | null;
}

export const PlatformTaxComplianceSchema = SchemaFactory.createForClass(PlatformTaxCompliance);
PlatformTaxComplianceSchema.index({ subjectType: 1, subjectId: 1 }, { unique: true });
