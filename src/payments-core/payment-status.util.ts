/* eslint-disable prettier/prettier */
export type PaymentStatus = 'created' | 'presented' | 'pending' | 'confirmed' | 'failed' | 'expired' | 'cancelled';
export type AttentionReason = 'paid_after_expiry' | 'confirmed_unattached' | 'anomaly' | 'refund_failed';
export type RefundStatus = 'none' | 'pending' | 'partial' | 'full';

export interface EventLike {
  seq: number; type: string; amountMinor?: number; late?: boolean; refundId?: string; at: Date | string; saleId?: string; note?: string;
  meta?: Record<string, unknown>; source?: string;
}

const STATUS_TYPES = new Set<string>(['created', 'presented', 'pending', 'confirmed', 'failed', 'expired', 'cancelled']);

export interface DerivedPayment {
  /** The latest status event — except that `confirmed` is final: no later event can move a paid payment back to another status. */
  status: PaymentStatus;
  confirmed: boolean;
  /** Confirmed after the till had already marked it expired / cancelled / failed. */
  paidAfterExpiry: boolean;
  confirmedAt: Date | null;
  consumed: boolean;
  saleId: string | null;
  reconciled: boolean;
  /** Sum of refund_succeeded amounts. */
  refundedMinor: number;
  /** Sum of refund_requested amounts that have neither succeeded nor failed yet. */
  refundPendingMinor: number;
  refundStatus: RefundStatus;
  anomalies: EventLike[];
  lastEventSeq: number;
  attention: AttentionReason[];
}

/**
 * Pure function of the event list (any order). `amountMinor` is the intent's amount. `unattachedGraceMs`: a confirmed payment that no
 * sale has consumed after this long is surfaced for a manager (the app crashed between "paid" and "sale saved").
 */
export function derivePayment(events: EventLike[], amountMinor: number, now: Date, unattachedGraceMs = 2 * 60 * 1000): DerivedPayment {
  const ev = [...events].sort((a, b) => a.seq - b.seq);
  const confirmedEv = ev.find((e) => e.type === 'confirmed') ?? null;
  const lastStatus = [...ev].reverse().find((e) => STATUS_TYPES.has(e.type));
  const status = (confirmedEv ? 'confirmed' : (lastStatus?.type ?? 'created')) as PaymentStatus;

  const reconciled = ev.some((e) => e.type === 'reconciled');
  const consumedEv = ev.find((e) => e.type === 'consumed') ?? null;
  const reconciledSale = ev.find((e) => e.type === 'reconciled' && e.saleId);

  // refunds: state per refundId = its latest refund_* event
  const byRefund = new Map<string, EventLike[]>();
  for (const e of ev) if (e.type.startsWith('refund_') && e.refundId) byRefund.set(e.refundId, [...(byRefund.get(e.refundId) ?? []), e]);
  let refundedMinor = 0, refundPendingMinor = 0, lastRefundFailed = false;
  const lastRefundSeq = Math.max(0, ...[...byRefund.values()].map((l) => l[l.length - 1].seq));
  for (const list of byRefund.values()) {
    const requested = list.find((e) => e.type === 'refund_requested');
    const last = list[list.length - 1];
    const amt = requested?.amountMinor ?? last.amountMinor ?? 0;
    if (last.type === 'refund_succeeded') refundedMinor += amt;
    else if (last.type === 'refund_requested') refundPendingMinor += amt;
    else if (last.type === 'refund_failed' && last.seq === lastRefundSeq) lastRefundFailed = true;
  }
  const refundStatus: RefundStatus = refundedMinor >= amountMinor && amountMinor > 0 ? 'full' : refundedMinor > 0 ? 'partial' : refundPendingMinor > 0 ? 'pending' : 'none';

  const anomalies = ev.filter((e) => e.type === 'anomaly');
  const paidAfterExpiry = !!confirmedEv && confirmedEv.late === true;
  const confirmedAt = confirmedEv ? new Date(confirmedEv.at) : null;
  const fullyRefunded = refundStatus === 'full';

  const attention: AttentionReason[] = [];
  if (paidAfterExpiry && !reconciled && !consumedEv && !fullyRefunded) attention.push('paid_after_expiry');
  if (confirmedEv && !paidAfterExpiry && !consumedEv && !reconciled && !fullyRefunded && confirmedAt && now.getTime() - confirmedAt.getTime() > unattachedGraceMs) attention.push('confirmed_unattached');
  if (anomalies.length > 0 && !reconciled) attention.push('anomaly');
  if (lastRefundFailed && !reconciled) attention.push('refund_failed');

  return {
    status, confirmed: !!confirmedEv, paidAfterExpiry, confirmedAt, consumed: !!consumedEv,
    saleId: consumedEv?.saleId ?? reconciledSale?.saleId ?? null,
    reconciled, refundedMinor, refundPendingMinor, refundStatus, anomalies,
    lastEventSeq: ev.length ? ev[ev.length - 1].seq : 0, attention,
  };
}

export const isOpen = (s: PaymentStatus): boolean => s === 'created' || s === 'presented' || s === 'pending';
export const isTerminalUnpaid = (s: PaymentStatus): boolean => s === 'failed' || s === 'expired' || s === 'cancelled';
