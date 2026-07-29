/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformConfigDocument = PlatformConfig & Document;

@Schema({ _id: false })
export class FeatureFlags {
  @Prop({ type: Boolean, default: true }) aiStudio: boolean;
  @Prop({ type: Boolean, default: true }) marketplace: boolean;
  @Prop({ type: Boolean, default: true }) digitalUploads: boolean;
  @Prop({ type: Boolean, default: false }) affiliateProgram: boolean;
  @Prop({ type: Boolean, default: false }) giftCards: boolean;
  @Prop({ type: Boolean, default: true }) posMode: boolean;
  @Prop({ type: Boolean, default: true }) storeBuilder: boolean;
  @Prop({ type: Boolean, default: false }) bulkProductImport: boolean;
}
export const FeatureFlagsSchema = SchemaFactory.createForClass(FeatureFlags);

@Schema({ _id: false })
export class AiConfig {
  @Prop({ type: Number, default: 1000 }) monthlyCreditLimit: number;
  @Prop({ type: String, default: 'claude-sonnet-5' }) aiModel: string;
}
export const AiConfigSchema = SchemaFactory.createForClass(AiConfig);

@Schema({ _id: false })
export class PayoutConfig {
  // Minimum available-balance amount required to gate both an on-demand
  // "Withdraw" action and the scheduled auto-payout batch — kept per
  // currency since Pakistan (manual bank/JazzCash/Easypaisa transfer) and
  // international (Stripe) sellers hold separate balances (see
  // SellerBalance.currency) with very different order-of-magnitude minimums.
  @Prop({ type: Number, default: 5 }) minPayoutUSD: number;
  @Prop({ type: Number, default: 1500 }) minPayoutPKR: number;
}
export const PayoutConfigSchema = SchemaFactory.createForClass(PayoutConfig);

// The Pakistan "pay into the platform's own bank account, upload proof"
// track (see manual-payments module) — buyer-visible company account details
// plus the USD→PKR rate used to convert an order's USD-priced total into the
// PKR amount the buyer actually transfers. Admin-managed so it can be updated
// without a deploy; `enabled: false` hides the option from checkout entirely.
@Schema({ _id: false })
export class ManualPaymentConfig {
  @Prop({ type: Boolean, default: false }) enabled: boolean;

  @Prop({ type: String, default: null }) bankName: string | null;
  @Prop({ type: String, default: null }) accountTitle: string | null;
  @Prop({ type: String, default: null }) accountNumber: string | null;
  @Prop({ type: String, default: null }) iban: string | null;
  @Prop({ type: String, default: null }) jazzcashNumber: string | null;
  @Prop({ type: String, default: null }) easypaisaNumber: string | null;
  @Prop({ type: String, default: null }) instructions: string | null;

  // How many PKR one USD converts to — applied to a checkout's USD total at
  // the moment the buyer commits to this payment method (not live-fetched
  // from a market-rate API, since there's no automated FX integration here;
  // an admin updates this periodically). See PaymentService.manualBankTransferPayment.
  @Prop({ type: Number, default: 278 }) usdToPkrRate: number;
}
export const ManualPaymentConfigSchema = SchemaFactory.createForClass(ManualPaymentConfig);

@Schema({ _id: false })
export class EmailConfig {
  @Prop({ type: String, default: 'Solvexo' }) fromName: string;
  @Prop({ type: String, default: null }) fromEmail: string | null;
  @Prop({ type: String, default: null }) replyToEmail: string | null;
  @Prop({ type: String, default: 'SendGrid' }) provider: string;
}
export const EmailConfigSchema = SchemaFactory.createForClass(EmailConfig);

// Singleton collection — exactly one document ever exists, fetched/updated via
// upsert with an empty filter (see AdminConfigService), same convention used
// for other platform-wide single-doc settings in this codebase.
@Schema({ timestamps: true })
export class PlatformConfig {
  @Prop({ type: Boolean, default: false })
  maintenanceMode: boolean;

  @Prop({ type: FeatureFlagsSchema, default: () => ({}) })
  featureFlags: FeatureFlags;

  @Prop({ type: AiConfigSchema, default: () => ({}) })
  aiConfig: AiConfig;

  @Prop({ type: EmailConfigSchema, default: () => ({}) })
  emailConfig: EmailConfig;

  @Prop({ type: PayoutConfigSchema, default: () => ({}) })
  payoutConfig: PayoutConfig;

  @Prop({ type: ManualPaymentConfigSchema, default: () => ({}) })
  manualPaymentConfig: ManualPaymentConfig;
}

export const PlatformConfigSchema = SchemaFactory.createForClass(PlatformConfig);
