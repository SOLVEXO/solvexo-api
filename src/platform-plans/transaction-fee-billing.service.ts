/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PlatformTaxService } from '@/platform-tax/platform-tax.service';
import { getInvoiceTaxCents } from '@/platform-tax/platform-tax.util';
import { OnEvent } from '@nestjs/event-emitter';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { round } from '../common/number.util';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

/** A manual bill is due this many days after it is created. */
export const MANUAL_BILL_DUE_DAYS = 14;

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
    @Optional() private readonly platformTax?: PlatformTaxService,
    @Optional() private readonly notificationsService?: NotificationsService,
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

    // Bills that were waiting for a manual payment, whose seller has since added a card: charge them now.
    const collectedFromCards = await this.collectAwaitingWithCards().catch((e: any) => { this.logger.error(`Retrying awaiting fee bills failed: ${e?.message}`); return 0; });
    const result = { stores: storeIds.length, billed: 0, awaitingPayment: 0, collectedFromCards, carried: 0, skipped: 0, failed: 0 };
    for (const storeId of storeIds) {
      try {
        const outcome = await this.billStore(storeId, cutoff, periodKey);
        if (outcome === 'billed') result.billed++;
        else if (outcome === 'awaiting') result.awaitingPayment++;
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

  private async billStore(storeId: string, cutoff: Date, periodKey: string): Promise<'billed' | 'awaiting' | 'carried' | 'skipped' | 'failed'> {
    const existing = await this.billModel.findOne({ storeId, periodKey });
    if (existing && ['invoiced', 'awaiting_payment', 'paid', 'payment_failed'].includes(existing.status)) return 'skipped'; // already billed this month

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
    const saleCount = breakdown.reduce((s, r) => s + r.saleCount, 0);

    // No card on file (for example a seller in a country without Stripe, billed for the plan by bank transfer): the fee is still
    // owed, so it becomes a bill that waits for a payment, the seller is told, and the admin marks it paid. It is never left
    // quietly piling up month after month.
    if (!seller?.stripeCustomerId) {
      return this.createManualBill(storeId, store, cutoff, periodKey, amountUSD, saleCount, breakdown);
    }
    const stripe = this.gateway.stripeClient;
    if (!stripe) return 'skipped';

    const bill: any = await this.billModel.findOneAndUpdate(
      { storeId, periodKey },
      { $set: { sellerId: store.sellerId, amountUSD, saleCount, breakdown, status: 'creating', collectionMode: 'stripe', failureReason: null } },
      { upsert: true, new: true },
    );
    const billId = String(bill._id);
    await this.claimFeeRows(storeId, cutoff, billId);
    return this.chargeWithStripe(bill, storeId, seller, { releaseOnFail: true });
  }

  /** Claims exactly the fee rows a bill covers, so a concurrent run or a rerun can not bill them twice. */
  private async claimFeeRows(storeId: string, cutoff: Date, billId: string) {
    const pending: any[] = await this.txModel.find(this.pendingMatch(storeId, cutoff)).select('_id').lean();
    const txIds = pending.map((t) => t._id);
    await this.txModel.updateMany(
      { _id: { $in: txIds }, 'metadata.billing.status': PENDING },
      { $set: { 'metadata.billing.status': 'invoiced', 'metadata.billing.billId': billId } },
    );
  }

  /** Creates the Stripe invoice for a bill and tries to collect it. Used by the monthly run and when an awaiting bill's seller adds a card. */
  private async chargeWithStripe(bill: any, storeId: string, seller: any, opts: { releaseOnFail: boolean }): Promise<'billed' | 'failed'> {
    const stripe = this.gateway.stripeClient;
    if (!stripe) return 'failed';
    const billId = String(bill._id);
    const periodKey = bill.periodKey as string;
    const saleCount = bill.saleCount ?? 0;
    const cents = Math.round(bill.amountUSD * 100);
    const description = `Transaction fees — ${periodKey} (${saleCount} sale${saleCount === 1 ? '' : 's'} via third-party payment gateways)`;
    try {
      // Solvexo's own tax on the fees (null = none applies): Stripe adds it on top of the net fee line.
      const taxRateId = await this.platformTax?.taxRateIdForStore(storeId);
      await stripe.invoiceItems.create(
        { customer: seller.stripeCustomerId, amount: cents, currency: 'usd', description, metadata: { purpose: 'transaction_fees', billId, storeId } },
        { idempotencyKey: `txfee-item-${billId}-${cents}` },
      );
      let invoice: any = await stripe.invoices.create(
        {
          customer: seller.stripeCustomerId, collection_method: 'charge_automatically', auto_advance: false,
          pending_invoice_items_behavior: 'include', description,
          ...(taxRateId ? { default_tax_rates: [taxRateId] } : {}),
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
          status, failureReason, collectionMode: 'stripe', stripeInvoiceId: invoice.id, hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
          taxAmountUSD: round(getInvoiceTaxCents(invoice) / 100),
          paidAt: status === 'paid' ? new Date() : null,
        },
      });
      this.activityLogService.log({
        storeId, category: 'finance', action: 'transaction_fees_billed',
        description: `Transaction fees ${periodKey}: $ ${Number(bill.amountUSD).toFixed(2)} invoiced (${status})`,
        actorRole: 'system', targetId: billId, targetType: 'transaction_fee_bill',
      });
      return 'billed';
    } catch (err: any) {
      if (opts.releaseOnFail) {
        // Nothing reached the customer's invoice: put the rows back so the next run retries.
        await this.txModel.updateMany(
          { 'metadata.billing.billId': billId },
          { $set: { 'metadata.billing.status': PENDING }, $unset: { 'metadata.billing.billId': '' } },
        );
        await this.billModel.updateOne({ _id: bill._id }, { $set: { status: 'failed', failureReason: err?.message ?? 'Stripe error' } });
      } else {
        // A bill that was waiting for a payment stays waiting; the next run tries again.
        await this.billModel.updateOne({ _id: bill._id }, { $set: { failureReason: err?.message ?? 'Stripe error' } });
      }
      this.logger.error(`Transaction-fee invoice failed for store ${storeId}: ${err?.message}`);
      return 'failed';
    }
  }

  /** The bill for a seller with no card on file: it waits for a payment (bank transfer, or a card added later). */
  private async createManualBill(storeId: string, store: any, cutoff: Date, periodKey: string, amountUSD: number, saleCount: number, breakdown: any[]): Promise<'awaiting'> {
    const quote = await this.platformTax?.quoteForStore(storeId, amountUSD).catch(() => null);
    const taxAmountUSD = round(quote?.taxUSD ?? 0);
    const dueAt = new Date(Date.now() + MANUAL_BILL_DUE_DAYS * 86_400_000);
    const bill: any = await this.billModel.findOneAndUpdate(
      { storeId, periodKey },
      { $set: { sellerId: store.sellerId, amountUSD, taxAmountUSD, saleCount, breakdown, status: 'awaiting_payment', collectionMode: 'manual', dueAt, failureReason: null } },
      { upsert: true, new: true },
    );
    const billId = String(bill._id);
    await this.claimFeeRows(storeId, cutoff, billId);

    const total = round(amountUSD + taxAmountUSD);
    this.activityLogService.log({
      storeId, category: 'finance', action: 'transaction_fees_awaiting_payment',
      description: `Transaction fees ${periodKey}: $ ${total.toFixed(2)} are due. The seller has no card on file, so the bill waits for a bank transfer.`,
      actorRole: 'system', targetId: billId, targetType: 'transaction_fee_bill',
    });
    // Tell the seller (in the app and by email) and the admin; a failure to notify never stops the billing run.
    this.notificationsService?.notify({
      recipientId: String(store.sellerId), recipientRole: 'seller', storeId,
      type: NOTIFICATION_TYPES.TRANSACTION_FEE_DUE,
      title: `Transaction fees due: $${total.toFixed(2)}`,
      body: `Your ${periodKey} fees for sales through other payment gateways are $${total.toFixed(2)}${taxAmountUSD > 0 ? ` (including $${taxAmountUSD.toFixed(2)} tax)` : ''}. You have no card on file, so please pay by bank transfer within ${MANUAL_BILL_DUE_DAYS} days and tell us through Help. See Plan & Billing.`,
      data: { billId, link: `/store/${storeId}/plan-billing` },
    } as any)?.catch?.(() => undefined);
    return 'awaiting';
  }

  /** A seller who had no card when a bill was made may add one later: charge those waiting bills to the card now. */
  async collectAwaitingWithCards(): Promise<number> {
    const waiting: any[] = await this.billModel.find({ status: 'awaiting_payment', collectionMode: 'manual', isDelete: false }).limit(500).lean();
    let collected = 0;
    for (const bill of waiting) {
      const seller: any = await this.db.repositories.sellerModel.findById(bill.sellerId).select('stripeCustomerId').lean();
      if (!seller?.stripeCustomerId) continue;
      const result = await this.chargeWithStripe(bill, String(bill.storeId), seller, { releaseOnFail: false });
      if (result === 'billed') collected++;
    }
    return collected;
  }

  /** The seller says the bank transfer was sent. This does not close the bill (only the admin can, after seeing the money); it tells the admin to look. Pressing it twice changes nothing. */
  async reportPaid(storeId: string, billId: string, note?: string | null) {
    const when = new Date();
    const bill: any = await this.billModel.findOneAndUpdate(
      { _id: billId, storeId, isDelete: false, status: 'awaiting_payment', sellerReportedPaidAt: null },
      { $set: { sellerReportedPaidAt: when, sellerPaymentNote: note ? String(note).trim().slice(0, 300) || null : null } },
      { new: true },
    );
    if (!bill) {
      const existing: any = await this.billModel.findOne({ _id: billId, storeId, isDelete: false });
      if (!existing) throw new NotFoundException('Bill not found.');
      if (existing.status === 'awaiting_payment' && existing.sellerReportedPaidAt) return { alreadyReported: true, reportedAt: existing.sellerReportedPaidAt };
      throw new BadRequestException('This bill is not waiting for a payment.');
    }
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('name').lean();
    this.activityLogService.log({
      storeId, category: 'finance', action: 'transaction_fees_payment_reported',
      description: `Seller reported a bank transfer for the ${bill.periodKey} transaction fees ($ ${Number(bill.amountUSD).toFixed(2)})`,
      actorRole: 'seller', targetId: billId, targetType: 'transaction_fee_bill',
    });
    this.notificationsService?.notifyAdmins({
      type: NOTIFICATION_TYPES.ADMIN_FEE_PAYMENT_REPORTED,
      title: 'A seller says a fee bill was paid',
      body: `${store?.name ?? 'A store'} reports a bank transfer for ${bill.periodKey} ($${Number(bill.amountUSD).toFixed(2)}). Check your bank, then mark the bill paid.`,
      data: { storeId, billId, link: '/admin/finance' },
    } as any)?.catch?.(() => undefined);
    return { alreadyReported: false, reportedAt: when };
  }

  /** The admin received the money (a bank transfer): close the bill. Only a bill that is still waiting for a payment can be closed this way. */
  async markPaidManually(billId: string, adminId: string, note?: string | null) {
    const bill: any = await this.billModel.findOneAndUpdate(
      { _id: billId, isDelete: false, status: { $in: ['awaiting_payment', 'payment_failed', 'failed'] } },
      { $set: { status: 'paid', paidAt: new Date(), failureReason: null, markedPaidBy: adminId, paymentNote: note ? String(note).slice(0, 300) : null } },
      { new: true },
    );
    if (!bill) return null;
    this.activityLogService.log({
      storeId: bill.storeId, category: 'finance', action: 'transaction_fees_marked_paid',
      description: `Transaction fees ${bill.periodKey}: $ ${Number(bill.amountUSD).toFixed(2)} marked as paid by an admin`,
      actorRole: 'admin', targetId: billId, targetType: 'transaction_fee_bill',
    });
    this.notificationsService?.notify({
      recipientId: String(bill.sellerId), recipientRole: 'seller', storeId: bill.storeId,
      type: NOTIFICATION_TYPES.TRANSACTION_FEE_PAID,
      title: 'Transaction fees paid',
      body: `Thank you. Your ${bill.periodKey} transaction fees are marked as paid.`,
      data: { billId },
    } as any)?.catch?.(() => undefined);
    return bill;
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
