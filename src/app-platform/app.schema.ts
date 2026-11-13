/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** An app in Solvexo's registry. Registered and approved by a Solvexo admin; a store owner installs it with a consent screen. */
@Schema({ timestamps: true, collection: 'appdefinitions' })
export class AppDefinition {
  @Prop({ type: String, required: true, trim: true, maxlength: 80 }) name: string;
  @Prop({ type: String, required: true, unique: true }) slug: string;
  @Prop({ type: String, default: '', maxlength: 500 }) description: string;
  @Prop({ type: String, default: '', maxlength: 120 }) developerName: string;
  @Prop({ type: String, default: '', maxlength: 160 }) developerEmail: string;
  /** Public identifier used in the install URL. */
  @Prop({ type: String, required: true, unique: true }) clientId: string;
  /** SHA-256 of the client secret (shown once). */
  @Prop({ type: String, required: true, select: false }) clientSecretHash: string;
  @Prop({ type: String, default: '' }) clientSecretHint: string;
  /** AES-GCM copy of the secret that signs the iframe session tokens (shown once, the app verifies with it). */
  @Prop({ type: String, required: true, select: false }) sessionSecretEnc: string;
  /** Exact https addresses the install flow may redirect to (the authorization code goes there). */
  @Prop({ type: [String], default: [] }) redirectUrls: string[];
  @Prop({ type: [String], default: [] }) requestedScopes: string[];
  /** The app's own webhook target (https): one signed subscription per install for these events. */
  @Prop({ type: String, default: null }) webhookUrl: string | null;
  @Prop({ type: [String], default: [] }) webhookEvents: string[];
  @Prop({ type: String, default: null }) uninstallWebhookUrl: string | null;
  /** Page shown inside the seller dashboard (sandboxed iframe, session-token handshake). */
  @Prop({ type: String, default: null }) embedUrl: string | null;
  @Prop({ type: String, default: '', maxlength: 60 }) embedTitle: string;
  @Prop({ type: String, enum: ['draft', 'approved', 'suspended'], default: 'draft' }) status: 'draft' | 'approved' | 'suspended';
  @Prop({ type: Date, default: null }) approvedAt: Date | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
}
export type AppDefinitionDocument = AppDefinition & Document;
export const AppDefinitionSchema = SchemaFactory.createForClass(AppDefinition);

/** One app installed on one store. The access token and webhook subscription it owns carry `appInstallId` and die with it. */
@Schema({ timestamps: true, collection: 'appinstalls' })
export class AppInstall {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) appId: string;
  @Prop({ type: String, enum: ['installed', 'uninstalled'], default: 'installed' }) status: 'installed' | 'uninstalled';
  @Prop({ type: [String], default: [] }) grantedScopes: string[];
  @Prop({ type: String, default: '' }) installedBy: string;
  @Prop({ type: Date, default: () => new Date() }) installedAt: Date;
  @Prop({ type: Date, default: null }) uninstalledAt: Date | null;
  @Prop({ type: String, default: null }) uninstalledBy: string | null;
}
export type AppInstallDocument = AppInstall & Document;
export const AppInstallSchema = SchemaFactory.createForClass(AppInstall);
AppInstallSchema.index({ storeId: 1, appId: 1 }, { unique: true, partialFilterExpression: { status: 'installed' } });
AppInstallSchema.index({ storeId: 1, status: 1 });

/** Single-use authorization code (only its hash is stored), bound to store, app, redirect address and scopes. */
@Schema({ timestamps: true, collection: 'appauthcodes' })
export class AppAuthCode {
  @Prop({ type: String, required: true, unique: true }) codeHash: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) appId: string;
  @Prop({ type: String, required: true }) redirectUri: string;
  @Prop({ type: [String], default: [] }) scopes: string[];
  @Prop({ type: String, default: '' }) grantedBy: string;
  @Prop({ type: Boolean, default: false }) used: boolean;
  @Prop({ type: Date, required: true }) expiresAt: Date;
}
export type AppAuthCodeDocument = AppAuthCode & Document;
export const AppAuthCodeSchema = SchemaFactory.createForClass(AppAuthCode);
AppAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
