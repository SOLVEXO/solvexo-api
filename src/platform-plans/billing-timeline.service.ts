/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { BillingTimelineQueryDto } from './dto/billing-timeline.dto';

export type TimelineKind = 'trial_started' | 'trial_ended' | 'plan_change' | 'credit' | 'payment' | 'payment_failed' | 'refund' | 'addon' | 'transaction_fee';
export type TimelineStatus = 'success' | 'failed' | 'pending' | 'info' | 'refunded';

export interface TimelineLineItem { kind: string; label: string; amountUSD: number }
export interface TimelineEvent {
  id: string; at: string; kind: TimelineKind; status: TimelineStatus;
  title: string; description: string;
  /** Positive = money charged to the seller, negative = money refunded to them, null = not a money event. */
  amountUSD: number | null; taxUSD?: number;
  /** Account-credit movement: + credit added to the balance, − credit used against a charge. */
  creditUSD?: number;
  invoiceId?: string | null; invoiceNumber?: string | null; hostedInvoiceUrl?: string | null;
  card?: { brand: string; last4: string } | null;
  lineItems?: TimelineLineItem[];
  attemptNumber?: number; reason?: string | null;
  /** Provider references — only ever filled for the admin audience. */
  internal?: { providerChargeId?: string | null; stripeInvoiceId?: string | null; providerRefundId?: string | null };
}

const ADDON_LABELS: Record<string, string> = {
  extra_ai_credits: 'Extra AI credits', extra_staff_seat: 'Extra staff seat', priority_marketplace_placement: 'Priority marketplace placement',
  advanced_tax_compliance: 'Advanced tax compliance', sms_notifications: 'SMS notifications',
};
const ALL_KINDS: TimelineKind[] = ['trial_started', 'trial_ended', 'plan_change', 'credit', 'payment', 'payment_failed', 'refund', 'addon', 'transaction_fee'];

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One chronological, finance-grade record of everything that ever happened to a store's Solvexo billing: trial,
 * plan changes, every payment (with card + line items), every failed attempt (with the reason), refunds, add-ons
 * and monthly transaction-fee bills. Read-only; the same data feeds the seller's "Billing activity", the admin
 * store timeline, the monthly statement and the CSV export.
 */
@Injectable()
export class BillingTimelineService {
  constructor(private readonly db: DatabaseService) {}

  private get subModel() { return this.db.repositories.sellerPlatformSubscriptionModel; }
  private get invoiceModel() { return this.db.repositories.platformPlanInvoiceModel; }
  private get attemptModel() { return this.db.repositories.platformPlanPaymentAttemptModel; }
  private get addonModel() { return this.db.repositories.platformAddonPurchaseModel; }
  private get feeModel() { return this.db.repositories.transactionFeeBillModel; }
  private get planModel() { return this.db.repositories.platformPlanModel; }

  async getForSeller(sellerId: string, storeId: string, q: BillingTimelineQueryDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, sellerId);
    return { success: true, data: await this.build(storeId, q, false) };
  }

  async getForAdmin(storeId: string, q: BillingTimelineQueryDto) {
    await this.assertStoreExists(storeId);
    return { success: true, data: await this.build(storeId, q, true) };
  }

  async exportForSeller(sellerId: string, storeId: string, q: BillingTimelineQueryDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, sellerId);
    return { success: true, data: this.toCsv(await this.build(storeId, q, false), storeId, false) };
  }

  async exportForAdmin(storeId: string, q: BillingTimelineQueryDto) {
    await this.assertStoreExists(storeId);
    return { success: true, data: this.toCsv(await this.build(storeId, q, true), storeId, true) };
  }

  private async assertStoreExists(storeId: string) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('A valid storeId is required');
    const store = await this.db.repositories.storeModel.findById(storeId).select('_id').lean();
    if (!store) throw new NotFoundException('Store not found');
  }

  private parseRange(q: BillingTimelineQueryDto) {
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) throw new BadRequestException('Invalid date range');
    const kinds = q.kinds ? q.kinds.split(',').map(s => s.trim()).filter((k): k is TimelineKind => (ALL_KINDS as string[]).includes(k)) : [];
    return { from, to, kinds };
  }

  /** Builds every event for the store (all time), then derives the summary (all time) and the statement (selected range). */
  async build(storeId: string, q: BillingTimelineQueryDto, admin: boolean) {
    const { from, to, kinds } = this.parseRange(q);
    const [store, sub, invoices, attempts, addons, fees] = await Promise.all([
      this.db.repositories.storeModel.findById(storeId).select('name').lean() as Promise<any>,
      this.subModel.findOne({ storeId, isDelete: false }).lean() as Promise<any>,
      this.invoiceModel.find({ storeId, isDelete: false }).sort({ createdAt: 1 }).lean() as Promise<any[]>,
      this.attemptModel.find({ storeId }).sort({ createdAt: 1 }).lean() as Promise<any[]>,
      this.addonModel.find({ storeId }).sort({ createdAt: 1 }).lean() as Promise<any[]>,
      this.feeModel.find({ storeId, isDelete: false }).sort({ createdAt: 1 }).lean() as Promise<any[]>,
    ]);
    const planIds = new Set<string>();
    for (const i of invoices) if (i.platformPlanId) planIds.add(String(i.platformPlanId));
    if (sub?.platformPlanId) planIds.add(String(sub.platformPlanId));
    const plans = planIds.size ? await this.planModel.find({ _id: { $in: [...planIds] } }).select('name').lean() as any[] : [];
    const planName = (id: any) => plans.find(p => String(p._id) === String(id))?.name ?? 'Plan';

    const all = this.collectEvents({ sub, invoices, attempts, addons, fees, planName, admin });
    all.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const inRange = all.filter(e => {
      const t = new Date(e.at).getTime();
      return (!from || t >= from.getTime()) && (!to || t <= to.getTime()) && (!kinds.length || kinds.includes(e.kind));
    });

    return {
      storeName: (store?.name as string | undefined) ?? null,
      summary: this.summarise(all, sub, invoices, planName),
      statement: this.statement(inRange, from, to),
      events: inRange,
    };
  }

  private collectEvents(x: { sub: any; invoices: any[]; attempts: any[]; addons: any[]; fees: any[]; planName: (id: any) => string; admin: boolean }): TimelineEvent[] {
    const { sub, invoices, attempts, addons, fees, planName, admin } = x;
    const ev: TimelineEvent[] = [];

    if (sub?.startedAt && sub?.trialEndsAt) {
      ev.push({ id: `trial-start-${sub._id}`, at: new Date(sub.startedAt).toISOString(), kind: 'trial_started', status: 'info', title: 'Free trial started', description: `Trial runs until ${new Date(sub.trialEndsAt).toDateString()}. No charge during the trial.`, amountUSD: null });
      if (new Date(sub.trialEndsAt).getTime() <= Date.now()) {
        ev.push({ id: `trial-end-${sub._id}`, at: new Date(sub.trialEndsAt).toISOString(), kind: 'trial_ended', status: 'info', title: 'Free trial ended', description: 'The trial period is over.', amountUSD: null });
      }
    }

    (sub?.planHistory ?? []).forEach((h: any, i: number) => {
      const prorated = h.proratedAmountUSD ?? 0;
      const money = prorated > 0 ? `$ ${r2(prorated).toFixed(2)} charged` : prorated < 0 ? `$ ${r2(-prorated).toFixed(2)} credited to your account` : 'no charge';
      ev.push({
        id: `plan-${sub._id}-${i}`, at: new Date(h.changedAt).toISOString(), kind: 'plan_change', status: 'info',
        title: h.fromPlanId ? `Plan changed: ${h.fromPlanName} → ${h.toPlanName}` : `Plan started: ${h.toPlanName}`,
        description: `${h.toPlanName}${h.interval ? ` (${h.interval})` : ''}${h.amountUSD != null ? ` at $ ${r2(h.amountUSD).toFixed(2)}` : ''} — ${money}.`,
        amountUSD: null,
      });
      if (prorated < 0) {
        ev.push({
          id: `credit-add-${sub._id}-${i}`, at: new Date(new Date(h.changedAt).getTime() + 1).toISOString(), kind: 'credit', status: 'info',
          title: 'Account credit added', description: `$ ${r2(-prorated).toFixed(2)} credit from the unused time on ${h.fromPlanName}. It is applied to your next charge.`,
          amountUSD: null, creditUSD: r2(-prorated),
        });
      }
    });

    const failedInvoiceKeys: Array<{ amount: number; at: number }> = [];
    for (const inv of invoices) {
      const card = inv.cardLast4 ? { brand: inv.cardBrand ?? 'card', last4: inv.cardLast4 } : null;
      const internal = admin ? { providerChargeId: inv.providerChargeId ?? null, stripeInvoiceId: inv.stripeInvoiceId ?? null, providerRefundId: inv.providerRefundId ?? null } : undefined;
      const label = `${planName(inv.platformPlanId)} — ${inv.type === 'initial' ? 'first payment' : inv.type === 'proration' ? 'plan change' : 'renewal'}`;
      if (inv.status === 'failed') {
        failedInvoiceKeys.push({ amount: inv.amountUSD, at: new Date(inv.createdAt).getTime() });
        continue; // shown through its failed attempt; only kept below if no attempt exists for it
      }
      ev.push({
        id: `inv-${inv._id}`, at: new Date(inv.paidAt ?? inv.createdAt).toISOString(), kind: 'payment',
        status: inv.status === 'pending' ? 'pending' : 'success', title: `Payment: ${label}`,
        description: `Invoice ${inv.invoiceNumber}`,
        amountUSD: r2(inv.amountUSD), taxUSD: inv.taxAmountUSD || 0, invoiceId: String(inv._id), invoiceNumber: inv.invoiceNumber,
        hostedInvoiceUrl: inv.hostedInvoiceUrl ?? null, card, lineItems: this.invoiceLines(inv, planName), internal,
      });
      const usedCredit = (inv.lineItems ?? []).filter((l: any) => l.kind === 'credit' && /account credit/i.test(l.label ?? '')).reduce((s: number, l: any) => s + Math.abs(l.amountUSD ?? 0), 0);
      if (usedCredit > 0) {
        ev.push({
          id: `credit-use-${inv._id}`, at: new Date(new Date(inv.paidAt ?? inv.createdAt).getTime() + 1).toISOString(), kind: 'credit', status: 'info',
          title: 'Account credit used', description: `$ ${r2(usedCredit).toFixed(2)} of your credit was applied to invoice ${inv.invoiceNumber}.`,
          amountUSD: null, creditUSD: -r2(usedCredit), invoiceId: String(inv._id), invoiceNumber: inv.invoiceNumber,
        });
      }
      if ((inv.refundedAmountUSD ?? 0) > 0) {
        ev.push({
          id: `refund-${inv._id}`, at: new Date(inv.refundedAt ?? inv.updatedAt ?? inv.createdAt).toISOString(), kind: 'refund', status: 'refunded',
          title: inv.status === 'refunded' ? 'Refund issued' : 'Partial refund issued',
          description: `Refund for invoice ${inv.invoiceNumber}${inv.refundReason ? ` — ${inv.refundReason}` : ''}. It returns to the original card.`,
          amountUSD: -r2(inv.refundedAmountUSD), invoiceId: String(inv._id), invoiceNumber: inv.invoiceNumber, reason: inv.refundReason ?? null, card, internal,
        });
      }
    }

    // Failed attempts — each one is its own event so the seller can see how many times and why.
    const failedAttempts = attempts.filter(a => a.outcome === 'failed');
    failedAttempts.forEach((a, i) => {
      const card = a.cardLast4 ? { brand: a.cardBrand ?? 'card', last4: a.cardLast4 } : null;
      ev.push({
        id: `att-${a._id}`, at: new Date(a.createdAt).toISOString(), kind: 'payment_failed', status: 'failed',
        title: 'Payment failed', attemptNumber: i + 1, reason: a.failureReason ?? null,
        description: `${a.failureReason ?? 'The card was declined'}`,
        amountUSD: r2(a.amountUSD), card,
        internal: admin ? { providerChargeId: a.providerChargeId ?? null } : undefined,
      });
    });
    // Older failed invoices that never got an attempt record (matched by amount + time) still show up.
    for (const f of failedInvoiceKeys) {
      const covered = failedAttempts.some(a => r2(a.amountUSD) === r2(f.amount) && Math.abs(new Date(a.createdAt).getTime() - f.at) < 15 * 60 * 1000);
      if (!covered) {
        ev.push({ id: `failinv-${f.at}-${f.amount}`, at: new Date(f.at).toISOString(), kind: 'payment_failed', status: 'failed', title: 'Payment failed', description: 'A plan payment did not go through.', amountUSD: r2(f.amount) });
      }
    }

    for (const a of addons) {
      const label = ADDON_LABELS[a.addonType] ?? a.addonType;
      const charges = a.charges?.length ? a.charges : [{ amountUSD: a.priceUSD, taxUSD: 0, chargedAt: a.createdAt, providerChargeId: a.providerChargeId }];
      charges.forEach((c: any, i: number) => {
        const total = r2((c.amountUSD ?? 0) + (c.taxUSD ?? 0));
        ev.push({
          id: `addon-${a._id}-${i}`, at: new Date(c.chargedAt).toISOString(), kind: 'addon', status: 'success',
          title: `Add-on: ${label}`, description: `${i === 0 ? 'Purchased' : 'Monthly renewal'}${a.quantity > 1 ? ` · ×${a.quantity}` : ''}${a.status === 'canceled' ? ' · later canceled' : ''}`,
          amountUSD: total, taxUSD: c.taxUSD || 0,
          lineItems: c.taxUSD ? [{ kind: 'plan', label, amountUSD: r2(c.amountUSD) }, { kind: 'tax', label: 'Tax', amountUSD: r2(c.taxUSD) }] : undefined,
          internal: admin ? { providerChargeId: c.providerChargeId ?? null } : undefined,
        });
      });
    }

    for (const f of fees) {
      const total = r2((f.amountUSD ?? 0) + (f.taxAmountUSD ?? 0));
      const paid = f.status === 'paid';
      const failed = f.status === 'payment_failed' || f.status === 'failed';
      ev.push({
        id: `fee-${f._id}`, at: new Date(paid ? f.paidAt ?? f.updatedAt : f.createdAt).toISOString(), kind: 'transaction_fee',
        status: paid ? 'success' : failed ? 'failed' : 'pending', title: `Transaction fees — ${f.periodKey}`,
        description: `${f.saleCount ?? 0} sale(s)${paid ? '' : f.dueAt ? ` · due ${new Date(f.dueAt).toDateString()}` : ''}${failed && f.failureReason ? ` · ${f.failureReason}` : ''}`,
        amountUSD: total, taxUSD: f.taxAmountUSD || 0, hostedInvoiceUrl: f.hostedInvoiceUrl ?? null, reason: failed ? f.failureReason ?? null : null,
        internal: admin ? { stripeInvoiceId: f.stripeInvoiceId ?? null } : undefined,
      });
    }
    return ev;
  }

  /** Saved line items, or — for invoices created before line items existed — a plan + tax breakdown rebuilt from the stored amounts. */
  private invoiceLines(inv: any, planName: (id: any) => string): TimelineLineItem[] | undefined {
    if (inv.lineItems?.length) return inv.lineItems;
    const tax = inv.taxAmountUSD ?? 0;
    const sub = inv.subtotalUSD ?? r2(inv.amountUSD - tax);
    if (!(inv.amountUSD > 0)) return undefined;
    const out: TimelineLineItem[] = [{ kind: 'plan', label: `${planName(inv.platformPlanId)} plan`, amountUSD: r2(sub) }];
    if (tax > 0) out.push({ kind: 'tax', label: inv.taxLabel ?? 'Tax', amountUSD: r2(tax) });
    return out;
  }

  /** Money that actually left the seller's card: paid plan invoices + paid add-on charges + paid transaction-fee bills (refunds subtract). */
  private summarise(all: TimelineEvent[], sub: any, invoices: any[], planName: (id: any) => string) {
    const sum = (f: (e: TimelineEvent) => boolean) => r2(all.filter(f).reduce((s, e) => s + (e.amountUSD ?? 0), 0));
    const paidKinds = (e: TimelineEvent) => e.status === 'success' && (e.kind === 'payment' || e.kind === 'addon' || e.kind === 'transaction_fee');
    const lifetimePaidUSD = sum(paidKinds);
    const refundedUSD = r2(-sum(e => e.kind === 'refund'));
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const thisMonthUSD = sum(e => paidKinds(e) && new Date(e.at).getTime() >= monthStart);
    const lastCard = [...invoices].reverse().find(i => i.cardLast4);
    return {
      currency: 'USD',
      lifetimePaidUSD, refundedUSD, netLifetimeUSD: r2(lifetimePaidUSD - refundedUSD), thisMonthUSD,
      taxPaidUSD: r2(all.filter(paidKinds).reduce((s, e) => s + (e.taxUSD ?? 0), 0)),
      breakdown: {
        plans: sum(e => e.status === 'success' && e.kind === 'payment'),
        addons: sum(e => e.status === 'success' && e.kind === 'addon'),
        transactionFees: sum(e => e.status === 'success' && e.kind === 'transaction_fee'),
        refunds: -refundedUSD,
      },
      creditBalanceUSD: r2(sub?.creditBalanceUSD ?? 0),
      card: lastCard ? { brand: lastCard.cardBrand ?? 'card', last4: lastCard.cardLast4 } : null,
      failedPaymentsLast30Days: all.filter(e => e.kind === 'payment_failed' && Date.now() - new Date(e.at).getTime() < 30 * 86400000).length,
      pendingPlanChange: sub?.pendingPlanChange ? { planName: planName(sub.pendingPlanChange.planId), kind: sub.pendingPlanChange.kind, amountUSD: sub.pendingPlanChange.amountUSD } : null,
      lastBillingError: sub?.lastBillingError ?? null,
      current: sub ? {
        status: sub.status, planName: sub.platformPlanId ? planName(sub.platformPlanId) : null, interval: sub.billingInterval,
        amountUSD: sub.amountUSD ?? 0, nextBillingDate: sub.nextBillingDate ?? null, trialEndsAt: sub.trialEndsAt ?? null,
      } : null,
    };
  }

  /** Totals for the selected range — the "monthly statement" numbers. */
  private statement(events: TimelineEvent[], from: Date | null, to: Date | null) {
    const paid = events.filter(e => e.status === 'success' && (e.kind === 'payment' || e.kind === 'addon' || e.kind === 'transaction_fee'));
    const chargedUSD = r2(paid.reduce((s, e) => s + (e.amountUSD ?? 0), 0));
    const refundedUSD = r2(-events.filter(e => e.kind === 'refund').reduce((s, e) => s + (e.amountUSD ?? 0), 0));
    const taxUSD = r2(paid.reduce((s, e) => s + (e.taxUSD ?? 0), 0));
    return {
      from: from?.toISOString() ?? null, to: to?.toISOString() ?? null,
      chargedUSD, refundedUSD, taxUSD, netUSD: r2(chargedUSD - refundedUSD),
      paymentCount: paid.length, failedCount: events.filter(e => e.kind === 'payment_failed').length,
    };
  }

  private csvCell(v: unknown): string {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  private toCsv(built: { events: TimelineEvent[]; statement: any }, storeId: string, admin: boolean) {
    const head = ['Date (UTC)', 'Type', 'Description', 'Status', 'Amount USD (+charged / -refunded)', 'Tax USD', 'Invoice', 'Card', 'Failure reason', 'Line items'];
    if (admin) head.push('Provider charge', 'Provider invoice');
    const rows = built.events.map(e => {
      const cols: unknown[] = [
        e.at.replace('T', ' ').slice(0, 19), e.kind, `${e.title} — ${e.description}`, e.status, e.amountUSD ?? '', e.taxUSD ?? '',
        e.invoiceNumber ?? '', e.card ? `${e.card.brand} ****${e.card.last4}` : '', e.reason ?? '',
        (e.lineItems ?? []).map(l => `${l.label}: ${l.amountUSD}`).join(' | '),
      ];
      if (admin) cols.push(e.internal?.providerChargeId ?? '', e.internal?.stripeInvoiceId ?? '');
      return cols.map(c => this.csvCell(c)).join(',');
    });
    const day = (d: string | null) => (d ? d.slice(0, 10) : 'all');
    const s = built.statement;
    return { filename: `billing-${storeId}-${day(s.from)}_${day(s.to)}.csv`, csv: [head.map(h => this.csvCell(h)).join(','), ...rows].join('\n') };
  }
}
