/* eslint-disable prettier/prettier */
import { creditLimitCheck, isOverdue, isPaymentMethodAllowed, outstandingBalance, paidTotal, paymentDueDate, paymentStatusOf, round2 } from './b2b-pricing.util';

/** What an order remembers about its wholesale buyer and receivable. Seller records only: Solvexo moves no money. */
export interface OrderB2B {
  companyId: string;
  companyName: string;
  locationId: string;
  poNumber: string | null;
  /** null = placed with a normal payment method (COD, bank transfer, ...): the PO number is kept, there is no receivable schedule. */
  terms: { type: string; netDays?: number | null } | null;
  dueDate: Date | null;
  total: number;
  currency: string;
  depositRequired: number;
  paidTotal: number;
  payments: { _id: any; amount: number; method: string; reference: string | null; date: Date; recordedBy: string; voided?: boolean }[];
  status: 'unpaid' | 'partial' | 'paid';
}

const OPEN_STATUSES_EXCLUDED = ['cancelled', 'refunded'];

/** Set by the khata module: called after a terms order's receivable changed, so the customer ledger mirrors it. Never throws into the order flow. */
export const b2bOrderChanged: { fn?: (orderId: string) => Promise<void> } = {};
export async function notifyB2BOrderChanged(orderId: string) {
  try { await b2bOrderChanged.fn?.(String(orderId)); } catch (e: any) { console.error('Khata mirror failed:', e?.message); }
}

export function buildOrderB2B(
  snapshot: { companyId: string; companyName: string; locationId: string; poNumber?: string | null; paymentTerms?: { type: string; netDays?: number | null } | null; depositPercent?: number | null },
  order: { total: number; currency: string },
  opts: { withTerms: boolean; placedAt?: Date },
): OrderB2B {
  const placedAt = opts.placedAt ?? new Date();
  const terms = opts.withTerms ? snapshot.paymentTerms ?? null : null;
  const dep = typeof snapshot.depositPercent === 'number' && snapshot.depositPercent > 0 ? round2((order.total * Math.min(100, snapshot.depositPercent)) / 100) : 0;
  return {
    companyId: snapshot.companyId, companyName: snapshot.companyName, locationId: snapshot.locationId, poNumber: snapshot.poNumber ?? null,
    terms, dueDate: terms ? paymentDueDate(terms as any, placedAt, null) : null, total: round2(order.total), currency: order.currency,
    depositRequired: terms ? dep : 0, paidTotal: 0, payments: [], status: 'unpaid',
  };
}

/** Receivable view of an order: outstanding, status, due date (due-on-fulfilment orders become due once the order has left the shop) and overdue flag. */
export function receivableOf(order: { b2b?: OrderB2B | null; orderStatus?: string; updatedAt?: Date }, now = new Date()) {
  const b = order.b2b;
  if (!b || !b.terms) return null;
  const live = (b.payments ?? []).filter((p) => !p.voided);
  const outstanding = outstandingBalance(b.total, live);
  const fulfilled = ['shipped', 'delivered', 'completed'].includes(String(order.orderStatus));
  const dueDate = b.dueDate ?? (b.terms.type === 'due_on_fulfilment' && fulfilled ? order.updatedAt ?? null : null);
  return {
    total: b.total, currency: b.currency, paid: paidTotal(live), outstanding, status: paymentStatusOf(b.total, live), dueDate,
    overdue: isOverdue(dueDate ? new Date(dueDate) : null, outstanding, now), depositRequired: b.depositRequired ?? 0, depositMet: paidTotal(live) + 0.004 >= (b.depositRequired ?? 0),
  };
}

/**
 * Everything this company still owes on open terms orders, in the STORE currency (each order is converted with its own frozen rates).
 * Cancelled / refunded orders owe nothing.
 */
export async function companyOutstanding(
  orderModel: any, convert: (amount: number, from: string, to: string, snapshots: any[]) => number,
  storeId: string, companyId: string, storeCurrency: string,
): Promise<number> {
  const orders: any[] = await orderModel
    .find({ isDelete: false, 'b2b.companyId': companyId, 'b2b.terms': { $ne: null }, 'sellerOrders.storeId': storeId, orderStatus: { $nin: OPEN_STATUSES_EXCLUDED } })
    .select('b2b currency fxSnapshots').limit(2000).lean();
  let sum = 0;
  for (const o of orders) {
    const owed = outstandingBalance(o.b2b.total, (o.b2b.payments ?? []).filter((p: any) => !p.voided));
    sum += o.currency === storeCurrency ? owed : convert(owed, o.currency, storeCurrency, o.fxSnapshots ?? []);
  }
  return round2(sum);
}

export { creditLimitCheck };

/** Recomputes `b2b.paidTotal` and `b2b.status` from the recorded (non-voided) installments. */
export async function syncReceivableStatus(orderModel: any, orderId: string) {
  const o: any = await orderModel.findById(orderId).select('b2b').lean();
  if (!o?.b2b?.terms) return null;
  const live = (o.b2b.payments ?? []).filter((p: any) => !p.voided);
  const status = paymentStatusOf(o.b2b.total, live);
  await orderModel.updateOne({ _id: orderId }, { $set: { 'b2b.status': status, 'b2b.paidTotal': paidTotal(live) } });
  return status;
}

/**
 * A return or a partial cancellation on a terms order that is still unpaid lowers what the company owes (a credit note on the
 * receivable). The total never drops below what was already recorded as paid (that would be a refund the seller handles). Atomic.
 */
export async function creditReceivable(orderModel: any, orderId: string, amount: number, note: string) {
  const credit = round2(amount);
  if (!(credit > 0)) return;
  await orderModel.updateOne(
    { _id: orderId, 'b2b.terms': { $ne: null } },
    [{ $set: {
      'b2b.total': { $max: [{ $ifNull: ['$b2b.paidTotal', 0] }, { $subtract: ['$b2b.total', credit] }] },
      'b2b.adjustments': { $concatArrays: [{ $ifNull: ['$b2b.adjustments', []] }, [{ amount: -credit, note, date: '$$NOW' }]] },
    } }],
    { updatePipeline: true } as any,
  );
  await syncReceivableStatus(orderModel, orderId);
  await notifyB2BOrderChanged(orderId);
}

/**
 * Payment methods a wholesale company may see at checkout: the store's list narrowed by the company's allow-list (an empty list
 * allows everything), plus `b2b_terms` when the company has payment terms and the cart is from one store. "split" (online + COD)
 * needs both halves allowed. Retail checkouts (no snapshot) are returned unchanged.
 */
export function filterPaymentMethodsForB2B(
  methods: string[],
  b2b: { allowedPaymentMethods?: string[] | null; paymentTerms?: unknown } | null | undefined,
  singleStore: boolean,
): string[] {
  if (!b2b) return methods;
  const allow = (m: string) => isPaymentMethodAllowed(b2b.allowedPaymentMethods, m);
  const out = methods.filter((m) => (m === 'split' ? allow('stripe') && allow('cash_on_delivery') : allow(m)));
  if (b2b.paymentTerms && singleStore && allow('b2b_terms')) out.push('b2b_terms');
  return out;
}
