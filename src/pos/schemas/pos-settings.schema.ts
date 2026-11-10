/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosSettingsDocument = PosSettings & Document;

@Schema({ timestamps: true })
export class PosSettings {
  @Prop({ required: true, unique: true })
  storeId: string;

  @Prop({ type: Number, default: 0, min: 0, max: 1 })
  taxRate: number;

  // Idle minutes before the till locks to the PIN screen (owner-set; the cart and the offline queue are kept).
  @Prop({ type: Number, default: 5, min: 1, max: 240 })
  autoLockMinutes: number;             // e.g. 0.05 = 5% — applied to subtotal if sale.tax not provided

  @Prop({ type: String, default: null })
  receiptHeader: string | null;

  @Prop({ type: String, default: null })
  receiptFooter: string | null;

  @Prop({ type: String, default: null })
  businessName: string | null;

  @Prop({ type: String, default: null })
  businessAddress: string | null;

  @Prop({ type: String, default: null })
  currencySymbol: string | null;   // legacy free text — the app now derives the symbol from the store's currency code

  // Printed on receipts when set (VAT / GST / NTN number).
  @Prop({ type: String, default: null })
  businessTaxId: string | null;

  // Bumped (and the previous values kept in PosSettingsVersion) whenever something that changes how a sale is priced
  // changes — currently the tax rate. Sale requests carry the version they were priced with. See PosService.pricingFor.
  @Prop({ type: Number, default: 1 })
  settingsVersion: number;

  // G2.4: a cashier may add a custom item whose line total is at most this (minor units); above it — or ALWAYS when null — a manager must approve
  @Prop({ type: Number, default: null, min: 0 })
  customItemApprovalAboveMinor: number | null;

  // ── G2.5: documents + return policy ──
  /** per-store gap-free counters (incremented INSIDE the sale / return transaction, so a rolled-back document leaves no hole) */
  @Prop({ type: Number, default: 0 }) invoiceCounter: number;
  @Prop({ type: Number, default: 0 }) creditNoteCounter: number;
  /** G3.4: per-store purchase-order and goods-receipt numbers (incremented inside the creating transaction — no holes) */
  @Prop({ type: Number, default: 0 }) poCounter: number;
  @Prop({ type: Number, default: 0 }) receiptCounter: number;
  /** G3.5: per-store expense numbers */
  @Prop({ type: Number, default: 0 }) expenseCounter: number;
  /** may a cashier process a return at all? (false = every return needs a manager, the behaviour before G2.5) */
  @Prop({ type: Boolean, default: false }) cashierReturnsEnabled: boolean;
  /** G3.0 (D6): per-store overrides of the approval limits (money in the store currency's MINOR units, counts as numbers); a key not present uses the documented default — see pos-permissions.config.ts */
  @Prop({ type: Object, default: {} }) approvalLimits: Record<string, number>;
  /** G4.2: the owner's per-store changes to the permission matrix (only what differs from the defaults) and its version (bumped on every change) */
  @Prop({ type: Object, default: {} }) permissionOverrides: Record<string, any>;
  @Prop({ type: Number, default: 0 }) permissionsVersion: number;
  /** a return above this amount (minor units) needs a manager; null = no amount limit */
  @Prop({ type: Number, default: null, min: 0 }) returnApprovalAboveMinor: number | null;
  /** a return later than this many days after the sale needs a manager; null = no day limit */
  @Prop({ type: Number, default: null, min: 0 }) returnApprovalAfterDays: number | null;

  // ── G2.6: store tax profile (as registered with the tax authority) — optional now, required later when fiscal integration is enabled ──
  @Prop({ type: String, default: null }) taxNtn: string | null;
  @Prop({ type: String, default: null }) taxStrn: string | null;
  @Prop({ type: String, default: null }) taxLegalName: string | null;
  @Prop({ type: String, default: null }) taxRegisteredAddress: string | null;
  @Prop({ type: String, enum: ['standard', 'exempt'], default: 'standard' }) defaultTaxCategory: string;

  @Prop({ type: Number, default: 0 })
  saleCounter: number;         // atomically incremented to mint saleNumber ("POS-00001") per store
}

export const PosSettingsSchema = SchemaFactory.createForClass(PosSettings);

PosSettingsSchema.index({ storeId: 1 }, { unique: true });
