/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { makeAppendOnly } from '../pos/schemas/pos-immutable.util';

/**
 * G2.2 — business verification (KYB) for the payment aggregator model: a store may take digital payments only after Solvexo verified the
 * business and the provider confirmed a sub-merchant for it. Settlement goes straight to the store's own bank account; Solvexo never
 * holds customer funds, so the IBAN here is for onboarding / reconciliation only.
 *
 * This is deliberately separate from the marketplace "Leads" verification (`Store.verification`): approving a payment KYB must not
 * publish a store on the marketplace, and the two reviews have different requirements (IBAN, CNIC/NTN) and different reviewers' permissions.
 */
export const KYB_STATUSES = ['draft', 'submitted', 'verified', 'rejected'] as const;
export type KybStatus = (typeof KYB_STATUSES)[number];
/**
 *   draft ──submit──▶ submitted ──approve──▶ verified ──reject (revoke)──▶ rejected
 *     ▲                    └────reject────────────────────────────────────▶ rejected
 *     └──────────── owner edits a rejected application (reopens as draft) ───────┘
 */
export const KYB_TRANSITIONS: Record<KybStatus, KybStatus[]> = {
  draft: ['submitted'],
  submitted: ['verified', 'rejected'],
  verified: ['rejected'],
  rejected: ['draft'],
};
export function assertKybTransition(from: KybStatus, to: KybStatus): void {
  if (!KYB_TRANSITIONS[from]?.includes(to)) throw new Error(`Invalid KYB transition: ${from} -> ${to}`);
}

export const KYB_BUSINESS_TYPES = ['sole_proprietor', 'partnership', 'company'] as const;
export type KybBusinessType = (typeof KYB_BUSINESS_TYPES)[number];
export const KYB_DOCUMENT_TYPES = ['owner_cnic', 'business_registration', 'tax_registration', 'bank_proof', 'address_proof'] as const;
export type KybDocumentType = (typeof KYB_DOCUMENT_TYPES)[number];

@Schema({ _id: true })
export class KybDocument {
  @Prop({ enum: KYB_DOCUMENT_TYPES, required: true }) type: string;
  /** Private Cloudinary asset — never a public URL; viewed only through a short-lived signed URL, every view audited. */
  @Prop({ required: true }) publicId: string;
  @Prop({ type: String, default: 'raw' }) resourceType: string;
  @Prop({ required: true }) fileName: string;
  @Prop({ type: String, default: null }) mimeType: string | null;
  @Prop({ type: Number, default: 0 }) fileSize: number;
  @Prop({ type: Date, default: () => new Date() }) uploadedAt: Date;
  @Prop({ type: String, default: null }) uploadedBy: string | null;
}
export const KybDocumentSchema = SchemaFactory.createForClass(KybDocument);

@Schema({ _id: false })
export class KybHistoryEntry {
  /** 'draft_saved' | 'document_uploaded' | 'document_removed' | 'submitted' | 'approved' | 'rejected' | 'reopened' | 'sub_merchant_set' */
  @Prop({ required: true }) action: string;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: null }) actorId: string | null;
  @Prop({ type: String, enum: ['owner', 'admin', 'system'], default: 'owner' }) actorRole: string;
  @Prop({ type: Date, default: () => new Date() }) at: Date;
}
export const KybHistoryEntrySchema = SchemaFactory.createForClass(KybHistoryEntry);

@Schema({ _id: false })
export class KybContact {
  @Prop({ type: String, default: null }) name: string | null;
  @Prop({ type: String, default: null }) designation: string | null;
  @Prop({ type: String, default: null }) email: string | null;
  @Prop({ type: String, default: null }) phone: string | null;
}
export const KybContactSchema = SchemaFactory.createForClass(KybContact);

@Schema({ _id: false })
export class KybSubMerchant {
  @Prop({ type: String, default: null }) ref: string | null;
  @Prop({ type: String, default: null }) providerKey: string | null;
  @Prop({ type: Date, default: null }) setAt: Date | null;
  @Prop({ type: String, default: null }) setBy: string | null;
}
export const KybSubMerchantSchema = SchemaFactory.createForClass(KybSubMerchant);

export type StoreKybDocument = StoreKyb & Document;

@Schema({ timestamps: true, collection: 'store_kybs' })
export class StoreKyb {
  @Prop({ required: true, unique: true }) storeId: string;
  @Prop({ required: true }) sellerId: string;
  @Prop({ type: String, enum: KYB_STATUSES, default: 'draft' }) status: string;

  @Prop({ type: String, enum: KYB_BUSINESS_TYPES, default: null }) businessType: string | null;
  @Prop({ type: String, default: null }) legalBusinessName: string | null;
  @Prop({ type: String, default: null }) businessAddress: string | null;
  @Prop({ type: KybContactSchema, default: () => ({}) }) contact: KybContact;
  @Prop({ type: String, default: null }) bankName: string | null;

  // ── sensitive: stored ONLY as `kyb:v<N>:…` ciphertext (see kyb-field-crypto.ts); `...Last4` are for masked display without decrypting ──
  @Prop({ type: String, default: null }) cnicEnc: string | null;
  @Prop({ type: String, default: null }) cnicLast4: string | null;
  @Prop({ type: String, default: null }) ntnEnc: string | null;
  @Prop({ type: String, default: null }) ntnLast4: string | null;
  @Prop({ type: String, default: null }) ibanEnc: string | null;
  @Prop({ type: String, default: null }) ibanLast4: string | null;
  @Prop({ type: String, default: null }) accountTitleEnc: string | null;

  @Prop({ type: [KybDocumentSchema], default: [] }) documents: KybDocument[];
  @Prop({ type: [KybHistoryEntrySchema], default: [] }) history: KybHistoryEntry[];

  @Prop({ type: Date, default: null }) submittedAt: Date | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
  @Prop({ type: String, default: null }) reviewedBy: string | null;
  @Prop({ type: String, default: null }) rejectionReason: string | null;
  @Prop({ type: KybSubMerchantSchema, default: () => ({}) }) subMerchant: KybSubMerchant;

  /** Retention: set by the (disabled-by-default) purge job after documents and sensitive fields were deleted. */
  @Prop({ type: Date, default: null }) purgedAt: Date | null;
}
export const StoreKybSchema = SchemaFactory.createForClass(StoreKyb);
StoreKybSchema.index({ status: 1, submittedAt: -1 });
StoreKybSchema.index({ 'subMerchant.ref': 1 }, { sparse: true });

export type KybAuditEventDocument = KybAuditEvent & Document;

/** Append-only. EVERY submission change, document view/download, decrypted read, sub-merchant change, setting change and purge is one row. */
@Schema({ timestamps: { createdAt: 'at', updatedAt: false }, collection: 'kyb_audit_events' })
export class KybAuditEvent {
  @Prop({ required: true }) storeId: string;
  @Prop({ enum: ['owner', 'admin', 'system'], required: true }) actorType: string;
  @Prop({ type: String, default: null }) actorId: string | null;
  @Prop({ required: true }) action: string;
  @Prop({ type: String, default: null }) targetType: string | null;
  @Prop({ type: String, default: null }) targetId: string | null;
  /** Never contains plaintext sensitive values — only ids, types, statuses and counts. */
  @Prop({ type: Object, default: null }) meta: Record<string, unknown> | null;
  @Prop({ type: String, default: null }) ip: string | null;
  @Prop({ type: String, default: null }) userAgent: string | null;
}
export const KybAuditEventSchema = SchemaFactory.createForClass(KybAuditEvent);
KybAuditEventSchema.index({ storeId: 1, at: -1 });
KybAuditEventSchema.index({ action: 1, at: -1 });
makeAppendOnly(KybAuditEventSchema);

export type KybSettingsDocument = KybSettings & Document;

/** Singleton. `afterClosureDays: null` = NO deletion at all (default, until the owner provides the legal retention period). */
@Schema({ timestamps: true, collection: 'kyb_settings' })
export class KybSettings {
  @Prop({ required: true, unique: true, default: 'singleton' }) key: string;
  @Prop({ type: Number, default: null }) afterClosureDays: number | null;
  @Prop({ type: Boolean, default: false }) purgeEnabled: boolean;
  @Prop({ type: String, default: null }) updatedBy: string | null;
}
export const KybSettingsSchema = SchemaFactory.createForClass(KybSettings);
