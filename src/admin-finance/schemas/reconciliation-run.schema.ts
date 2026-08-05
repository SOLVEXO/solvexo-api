import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReconciliationRunDocument = ReconciliationRun & Document;

@Schema({ _id: false })
export class ReconciliationCurrencyResult {
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Number, default: 0 }) buyerCollected: number;
  @Prop({ type: Number, default: 0 }) orderCount: number;
  @Prop({ type: Number, default: 0 }) ledgerNet: number;
  @Prop({ type: Number, default: 0 }) fees: number;
  @Prop({ type: Number, default: 0 }) refunds: number;
  @Prop({ type: Number, default: 0 }) expectedFromLedger: number;
  @Prop({ type: Number, default: 0 }) drift: number;
  @Prop({ type: Boolean, default: false }) hasDiscrepancy: boolean;
}
export const ReconciliationCurrencyResultSchema = SchemaFactory.createForClass(ReconciliationCurrencyResult);

/**
 * A persisted snapshot of one `AdminFinanceService#getReconciliation` run —
 * previously that method was read-only/on-demand only (nothing was ever
 * recorded), so there was no way to see reconciliation history or know that
 * a past run ever found a discrepancy unless someone was actively looking
 * at the dashboard at that exact moment. The daily scheduled job
 * (`SchedulerService#runReconciliation`) writes one of these every day.
 */
@Schema({ timestamps: true })
export class ReconciliationRun {
  @Prop({ type: Date, required: true }) runAt: Date;
  @Prop({ type: [ReconciliationCurrencyResultSchema], default: [] }) results: ReconciliationCurrencyResult[];
  @Prop({ type: Boolean, default: false }) hasAnyDiscrepancy: boolean;
}
export const ReconciliationRunSchema = SchemaFactory.createForClass(ReconciliationRun);
ReconciliationRunSchema.index({ runAt: -1 });
