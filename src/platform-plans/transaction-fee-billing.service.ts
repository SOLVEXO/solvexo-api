/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { round } from '../common/number.util';

/** Stripe can't charge less than $0.50 — smaller totals roll into the next month's bill. */
export const MIN_BILLABLE_USD = 0.5;

const PENDING = 'pending_invoice';

/**
 * Collects the "third-party transaction fee" the way Shopify does: on the
 * merchant's regular platform bill, never out of a sales balance.
 *
 * `FinanceService.recordSale` leaves each owed fee on its ledger row
 * (`Transaction{type:'fee'}.metadata.billing.status = 'pending_invoice'`). On
 * the 1st of every month `billAccruedFees` totals each store's pending fees
 * (converted to USD), creates ONE Stripe invoice against the seller's saved
 * platform-billing customer, and records a `TransactionFeeBill` so the seller
 * and the admin can see exactly what was charged. A total under $0.50, or a
 * seller with no billing customer yet, simply carries over to the next run.
 */
@Injectable()
export class TransactionFeeBillingService {
  private readonly logger = new Logger(TransactionFeeBillingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly exchangeRate: ExchangeRateService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get txModel() { return this.db.repositories.transactionModel; }
  private get billModel() { return this.db.repositories.transactionFeeBillModel; }

  private periodKey(d: Date) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  private startOfMonthUTC(d: Date) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
  private nextMonthStartUTC(d: Date) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }

  private pendingMatch(storeId: string, before?: Date) {
    return {
      storeId, type: 'fee', 'metadata.billing.status': PENDING,
      ...(before ? { createdAt: { $lt: before } } : {}),
    };
  }

  private async groupPending(match: Record<string, any>) {
    const rows: Array<{ _id: string; amount: number; count: number }> = await this.txModel.aggregate([
      { $match: match },
      { $group: { _id: '$currency', amount: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
    ]);
    return rows.map((r) => ({ currency: r._id || 'USD', amount: round(r.amount), saleCount: r.count }));
  }

  /** Converts per-currency fee totals to USD; throws if any currency has no usable FX rate. */
  private async toUSD(rows: Array<{ currency: string; amount: number; saleCount: number }>) {
    const out: Array<{ currency: string; amount: number; amountUSD: number; saleCount: number }> = [];
    for (const r of rows) {
      const amountUSD = r.currency === 'USD' ? r.amount : round(await this.exchangeRate.convert(r.amount, r.currency, 'USD'));
      out.push({ ...r, amountUSD });
    }
    return out;
  }

  /** What a store has accrued so far that hasn't been billed yet, plus its recent bills — the seller-facing view. */
  async getOverview(storeId: string, now = new Date()) {
    const accruedRows = await this.groupPending(this.pendingMatch(storeId));
    let breakdown: Awaited<ReturnType<TransactionFeeBillingService['toUSD']>> | null = null;
    try { breakdown = await this.toUSD(accruedRows); } catch { /* FX unavailable — show native amounts only */ }
    const bills = await this.billModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).limit(12).lean();
    return {
      accrued: {
        byCurrency: accruedRows,
        estimatedUSD: breakdown ? round(breakdown.reduce((s, r) => s + r.amountUSD, 0)) : null,
        saleCount: accruedRows.reduce((s, r) => s + r.saleCount, 0),
        nextBillingDate: this.nextMonthStartUTC(now),
        minimumBillableUSD: MIN_BILLABLE_USD,
      },
      bills,
    };
  }

  /** Billing run — safe to call repeatedly (each store+month is billed once). */
  async billAccruedFees(now = new Date()) {
    const cutoff = this.startOfMonthUTC(now);
    const periodKey = this.periodKey(new Date(cutoff.getTime() - 1));
    const storeIds: string[] = await this.txModel.distinct('storeId', {
      type: 'fee', 'metadata.billing.status': PENDING, createdAt: { $lt: cutoff },
    });

    const result = { stores: storeIds.length, billed: 0, carried: 0, skipped: 0, failed: 0 };
    for (const storeId of storeIds) {
      try {
        const outcome = await this.billStore(storeId, cutoff, periodKey);
        if (outcome === 'billed') result.billed++;
        else if (outcome === 'carried') result.carried++;
        else if (outcome === 'failed') result.failed++;
        else result.skipped++;
      } catch (err: any) {
        result.failed++;
        this.logger.error(`Transaction-fee billing crashed for store ${storeId}: ${err?.message}`);
      }
    }
    return result;
  }

  private async billStore(storeId: string, cutoff: Date, periodKey: string): Promise<'billed' | 'carried' | 'skipped' | 'failed'> {
    const existing = await this.billModel.findOne({ storeId, periodKey });
    if (existing && ['invoiced', 'paid', 'payment_failed'].includes(existing.status)) return 'skipped'; // already billed this month

    const rows = await this.groupPending(this.pendingMatch(storeId, cutoff));
    if (rows.length === 0) return 'skipped';

    let breakdown;
    try {
      breakdown = await this.toUSD(rows);
    } catch (err: any) {
      this.logger.warn(`Transaction-fee billing for store ${storeId} skipped — no FX rate (${err?.message})`);
      return 'skipped';
    }
    const amountUSD = round(breakdown.reduce((s, r) => s + r.amountUSD, 0));
    if (amountUSD < MIN_BILLABLE_USD) return 'carried';

    const store: any = await this.db.repositories.storeModel.findById(storeId).select('sellerId name').lean();
    if (!store?.sellerId) return 'skipped';
    const seller: any = await this.db.repositories.sellerModel.findById(store.sellerId).select('stripeCustomerId').lean();
    if (!seller?.stripeCustomerId) {
      this.activityLogService.log({
        storeId, category: 'finance', action: 'transaction_fee_billing_skipped',
        description: `Transaction fees of $${amountUSD.toFixed(2)} for ${periodKey} could not be billed — the seller has no billing payment method on file yet; they will be included once one is added.`,
        actorRole: 'system', targetId: storeId, targetType: 'store',
      });
      return 'skipped';
    }
    const stripe = this.gateway.stripeClient;
    if (!stripe) return 'skipped';

    const saleCount = breakdown.reduce((s, r) => s + r.saleCount, 0);
    const bill: any = await this.billModel.findOneAndUpdate(
      { storeId, periodKey },
      { $set: { sellerId: store.sellerId, amountUSD, saleCount, breakdown, status: 'creating', failureReason: null } },
      { upsert: true, new: true },
    );
    const billId = String(bill._id);

    // Claim exactly the fee rows this bill covers, so a concurrent/rerun can't bill them twice.
    const pending: any[] = await this.txModel.find(this.pendingMatch(storeId, cutoff)).select('_id').lean();
    const txIds = pending.map((t) => t._id);
    await this.txModel.updateMany(
      { _id: { $in: txIds }, 'metadata.billing.status': PENDING },
      { $set: { 'metadata.billing.status': 'invoiced', 'metadata.billing.billId': billId } },
    );

    const cents = Math.round(amountUSD * 100);
    const description = `Transaction fees — ${periodKey} (${saleCount} sale${saleCount === 1 ? '' : 's'} via third-party payment gateways)`;
    try {
      await stripe.invoiceItems.create(
        { customer: seller.stripeCustomerId, amount: cents, currency: 'usd', description, metadata: { purpose: 'transaction_fees', billId, storeId } },
        { idempotencyKey: `txfee-item-${billId}-${cents}` },
      );
      let invoice: any = await stripe.invoices.create(
        {
          customer: seller.stripeCustomerId, collection_method: 'charge_automatically', auto_advance: false,
          pending_invoice_items_behavior: 'include', description,
          metadata: { purpose: 'transaction_fees', billId, storeId },
        },
        { idempotencyKey: `txfee-inv-${billId}-${cents}` },
      );
      invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true });

      let status = 'invoiced';
      let failureReason: string | null = null;
      try {
        invoice = await stripe.invoices.pay(invoice.id);
        if (invoice.status === 'paid') status = 'paid';
      } catch (payErr: any) {
        status = 'payment_failed';
        failureReason = payErr?.message ?? 'Payment failed';
      }
      await this.billModel.updateOne({ _id: bill._id }, {
        $set: {
          status, failureReason, stripeInvoiceId: invoice.id, hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
          paidAt: status === 'paid' ? new Date() : null,
        },
      });
      this.activityLogService.log({
        storeId, category: 'finance', action: 'transaction_fees_billed',
        description: `Transaction fees ${periodKey}: $${amountUSD.toFixed(2)} invoiced (${status})`,
        actorRole: 'system', targetId: billId, targetType: 'transaction_fee_bill',
      });
      return 'billed';
    } catch (err: any) {
      // Nothing reached the customer's invoice: put the rows back so the next run retries.
      await this.txModel.updateMany(
        { 'metadata.billing.billId': billId },
        { $set: { 'metadata.billing.status': PENDING }, $unset: { 'metadata.billing.billId': '' } },
      );
      await this.billModel.updateOne({ _id: bill._id }, { $set: { status: 'failed', failureReason: err?.message ?? 'Stripe error' } });
      this.logger.error(`Transaction-fee invoice failed for store ${storeId}: ${err?.message}`);
      return 'failed';
    }
  }

  // ── Stripe invoice outcome → keep the bill's status in sync ───────────────

  @OnEvent('stripe.invoice.payment_succeeded')
  async handleInvoicePaid(invoice: any): Promise<void> {
    if (invoice?.metadata?.purpose !== 'transaction_fees' || !invoice.id) return;
    await this.billModel.updateOne(
      { stripeInvoiceId: invoice.id },
      { $set: { status: 'paid', paidAt: new Date(), failureReason: null } },
    );
  }

  @OnEvent('stripe.invoice.payment_failed')
  async handleInvoiceFailed(invoice: any): Promise<void> {
    if (invoice?.metadata?.purpose !== 'transaction_fees' || !invoice.id) return;
    await this.billModel.updateOne(
      { stripeInvoiceId: invoice.id },
      { $set: { status: 'payment_failed', failureReason: 'Stripe invoice payment failed' } },
    );
  }
}
