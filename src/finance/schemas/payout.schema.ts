import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PayoutDocument = Payout & Document;

@Schema({ timestamps: true })
export class Payout {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: Number, required: true }) amount: number;
  @Prop({ type: String, default: 'USD' }) currency: string;

  @Prop({ type: String, required: true }) payoutMethodId: string;
  // Snapshot of the method at time of payout (in case method is later deleted)
  @Prop({ type: Object, default: null }) payoutMethodSnapshot: {
    type: string;
    bankName: string | null;
    accountLast4: string;
  } | null;

  // 'reversed' is distinct from 'failed': a 'failed' payout never actually
  // moved money (the Stripe transfer call itself errored, or an admin
  // rejected it before sending anything) — a 'reversed' one DID move money
  // (the Stripe transfer to the seller's connected account succeeded) and is
  // being clawed back afterward (a later `transfer.reversed` event, or an
  // admin-initiated reversal for a disputed/fraudulent payout).
  @Prop({
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'reversed'],
    default: 'pending',
  })
  status: string;

  // Distinguishes a seller-tapped "Withdraw" from one the scheduled batch job
  // created on the seller's behalf (see FinanceService.processScheduledPayouts)
  // — both flow through the same admin approve/reject queue, but admins and
  // sellers alike benefit from seeing which is which.
  @Prop({ type: String, enum: ['seller_manual', 'scheduled_auto'], default: 'seller_manual' })
  source: string;

  // 'stripe_connect' = actually automated end-to-end (a real Stripe Transfer
  // moved the money — see FinanceService.runStripeConnectTransfer); 'manual'
  // = every rail Solvexo cannot move money for itself (Pakistani JazzCash/
  // Easypaisa, a plain bank wire, PayPal) — those still go through the admin
  // approve/reject queue exactly as before, since there is no API Solvexo
  // can call to actually send that money. This is what makes
  // `adminApprovePayout`/`adminRejectPayout`/`adminRetryFailedPayout` refuse
  // to act on a payout that already moved automatically.
  @Prop({ type: String, enum: ['stripe_connect', 'manual'], default: 'manual' })
  railType: string;

  // Populated only for railType:'stripe_connect' — the real Stripe object
  // ids behind this payout, so a seller/admin can trace it in the Stripe
  // Dashboard, and so a webhook event can be correlated back to this row.
  @Prop({ type: String, default: null }) stripeTransferId: string | null;
  @Prop({ type: String, default: null }) stripeReversalId: string | null;

  @Prop({ type: Date, default: null }) scheduledAt: Date | null;
  @Prop({ type: Date, default: null }) processedAt: Date | null;
  @Prop({ type: String, default: null }) failureReason: string | null;
  @Prop({ type: String, default: null }) notes: string | null;

  // Reference transaction ID after processing
  @Prop({ type: String, default: null }) transactionId: string | null;
}

export const PayoutSchema = SchemaFactory.createForClass(Payout);
PayoutSchema.index({ storeId: 1, createdAt: -1 });
PayoutSchema.index({ storeId: 1, status: 1 });
PayoutSchema.index({ sellerId: 1 });
