/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const API_KEY_SCOPES = ['sales:read', 'inventory:read', 'accounting:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type PosApiKeyDocument = HydratedDocument<PosApiKey>;
/**
 * G5.7 — a store's read-only API key. The secret is shown ONCE at creation; only its SHA-256 is kept. `prefix` (public, 12 chars) finds the row.
 * A key is never edited except to record that it was revoked (`revokedAt` / `revokedBy`) and when it was last used — creation, revocation and EVERY use
 * are rows in the append-only audit log.
 */
@Schema({ timestamps: true })
export class PosApiKey {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true, unique: true }) prefix: string;
  @Prop({ type: String, required: true }) secretHash: string;
  @Prop({ type: [String], required: true }) scopes: ApiKeyScope[];
  @Prop({ type: Date, required: true }) expiresAt: Date;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ type: String, default: null }) revokedBy: string | null;
  @Prop({ type: String, default: null }) createdBy: string | null;
  @Prop({ type: Date, default: null }) lastUsedAt: Date | null;
}
export const PosApiKeySchema = SchemaFactory.createForClass(PosApiKey);
PosApiKeySchema.index({ storeId: 1, createdAt: -1 });

export type PosApiKeyWindowDocument = HydratedDocument<PosApiKeyWindow>;
/** G5.7 — per-key, per-minute request counter (rate limit shared by every API instance); rows expire on their own. */
@Schema({ timestamps: false })
export class PosApiKeyWindow {
  @Prop({ type: String, required: true }) keyId: string;
  @Prop({ type: Number, required: true }) window: number; // epoch minute
  @Prop({ type: Number, default: 0 }) count: number;
  @Prop({ type: Date, required: true }) expireAt: Date;
}
export const PosApiKeyWindowSchema = SchemaFactory.createForClass(PosApiKeyWindow);
PosApiKeyWindowSchema.index({ keyId: 1, window: 1 }, { unique: true });
PosApiKeyWindowSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
