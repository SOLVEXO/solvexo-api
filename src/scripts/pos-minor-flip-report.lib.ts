/* eslint-disable prettier/prettier */
import type { Db } from 'mongodb';
import { checkMinorPairs, isoExponent } from '../common/money-minor.util';

/**
 * READ-ONLY report for the step-f decision (flip reads to minor): did the dual-write stay consistent, and was every money path
 * actually exercised, for a date range. It only runs `find` / `countDocuments` — it writes nothing.
 *
 * Criteria (owner, G1b): ≥ 14 days with ZERO checker mismatches AND every path exercised at least once in that window:
 * cash, card, split, full refund, partial refund, held sale (create, resume, discard), offline sale synced, shift close with card variance.
 */
export const FLIP_PATHS = ['cash', 'card', 'split', 'fullRefund', 'partialRefund', 'heldCreate', 'heldResume', 'heldDiscard', 'offlineSynced', 'shiftCloseCardVariance'] as const;
export type FlipPath = (typeof FLIP_PATHS)[number];

export interface FlipReport {
  from: string; to: string; minCleanDays: number;
  /** Client payloads whose decimal and minor twin disagreed (accepted at the server's values). Informational — the STORED data is fine — so it never blocks the flip. */
  clientPayloadMismatches: number;
  mismatches: { auditEvents: number; scanViolations: number; total: number; byKind: Record<string, number>; firstExamples: any[] };
  checkedRows: { sales: number; sessions: number; payments: number; refunds: number };
  days: Array<{ day: string; mismatches: number }>;
  consecutiveCleanDaysEndingAtTo: number;
  pathCounts: Record<FlipPath, number>;
  pathsMissing: FlipPath[];
  ready: boolean;
  reasons: string[];
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const PAIRS = {
  sale: [['subtotal', 'subtotalMinor'], ['discount', 'discountMinor'], ['tax', 'taxMinor'], ['total', 'totalMinor'], ['changeGiven', 'changeGivenMinor'], ['paymentShortfall', 'paymentShortfallMinor'], ['refundedAmount', 'refundedAmountMinor'], ['items[].price', 'items[].priceMinor'], ['items[].listPrice', 'items[].listPriceMinor'], ['items[].lineTotal', 'items[].lineTotalMinor'], ['payments[].amount', 'payments[].amountMinor'], ['payments[].tendered', 'payments[].tenderedMinor'], ['refunds[].amount', 'refunds[].amountMinor']],
  session: [['openingCash', 'openingCashMinor'], ['closingCash', 'closingCashMinor'], ['expectedCash', 'expectedCashMinor'], ['cashDifference', 'cashDifferenceMinor'], ['cashSales', 'cashSalesMinor'], ['cardSales', 'cardSalesMinor'], ['otherSales', 'otherSalesMinor'], ['digitalSales', 'digitalSalesMinor'], ['totalSales', 'totalSalesMinor'], ['totalRefunds', 'totalRefundsMinor'], ['cashAdjustments[].amount', 'cashAdjustments[].amountMinor'], ['cardReconciliation.slipTotal', 'cardReconciliation.slipTotalMinor'], ['cardReconciliation.expectedCard', 'cardReconciliation.expectedCardMinor'], ['cardReconciliation.variance', 'cardReconciliation.varianceMinor']],
  payment: [['amount', 'amountMinor'], ['tendered', 'tenderedMinor']],
  refund: [['amount', 'amountMinor'], ['tenders[].amount', 'tenders[].amountMinor']],
} as Record<string, Array<[string, string]>>;

export async function buildFlipReport(db: Db, opts: { from: Date; to: Date; minCleanDays?: number; storeId?: string }): Promise<FlipReport> {
  const minCleanDays = opts.minCleanDays ?? 14;
  const to = new Date(opts.to.getTime() + 86_400_000 - 1); // `to` is inclusive of the whole day
  const range = { $gte: opts.from, $lte: to };
  const store = opts.storeId ? { storeId: opts.storeId } : {};

  const baseCurrency = new Map<string, string>();
  for await (const s of db.collection('stores').find(opts.storeId ? { _id: opts.storeId as any } : {}, { projection: { baseCurrency: 1 } })) baseCurrency.set(String(s._id), String((s as any).baseCurrency ?? 'USD'));

  // 1) mismatches the checker recorded
  const auditMismatch = await db.collection('posauditlogs').find({ ...store, action: 'money_minor_mismatch', 'metadata.source': { $ne: 'client' }, createdAt: range }).sort({ createdAt: 1 }).toArray();
  const clientPayloadMismatches = await db.collection('posauditlogs').countDocuments({ ...store, action: 'money_minor_mismatch', 'metadata.source': 'client', createdAt: range });
  const byDay = new Map<string, number>();
  const byKind: Record<string, number> = {};
  for (const a of auditMismatch as any[]) { byDay.set(dayKey(a.createdAt), (byDay.get(dayKey(a.createdAt)) ?? 0) + 1); byKind[a.targetType ?? 'unknown'] = (byKind[a.targetType ?? 'unknown'] ?? 0) + 1; }

  // 2) an independent re-scan of the rows written in the window (does not trust the checker's own events)
  const scan = { sales: 0, sessions: 0, payments: 0, refunds: 0 };
  const examples: any[] = [];
  let scanViolations = 0;
  const scanColl = async (name: string, kind: 'sale' | 'session' | 'payment' | 'refund', counter: keyof typeof scan, hasMinor: any) => {
    const cursor = db.collection(name).find({ ...store, createdAt: range, ...hasMinor });
    for await (const doc of cursor as any) {
      scan[counter]++;
      const exp = doc.currencyExponent ?? isoExponent(baseCurrency.get(String(doc.storeId)) ?? 'USD');
      const bad = checkMinorPairs(doc, PAIRS[kind], exp);
      if (bad.length) {
        scanViolations++;
        byDay.set(dayKey(doc.createdAt), (byDay.get(dayKey(doc.createdAt)) ?? 0) + 1);
        if (examples.length < 5) examples.push({ collection: name, id: String(doc._id), mismatches: bad.slice(0, 3) });
      }
    }
  };
  await scanColl('sales', 'sale', 'sales', { totalMinor: { $exists: true } });
  await scanColl('registersessions', 'session', 'sessions', { openingCashMinor: { $exists: true } });
  await scanColl('pospayments', 'payment', 'payments', { amountMinor: { $exists: true } });
  await scanColl('posrefunds', 'refund', 'refunds', { amountMinor: { $exists: true } });

  // 3) per-path counts (only dual-written rows count: a row without minor proves nothing about the dual-write)
  const sales = db.collection('sales');
  const audit = db.collection('posauditlogs');
  const dual = { ...store, createdAt: range, totalMinor: { $exists: true }, status: { $nin: ['held', 'discarded'] } };
  const paths: Record<FlipPath, number> = {
    cash: await sales.countDocuments({ ...dual, paymentMethod: 'cash' }),
    card: await sales.countDocuments({ ...dual, paymentMethod: 'card' }),
    split: await sales.countDocuments({ ...dual, paymentMethod: 'split' }),
    offlineSynced: await sales.countDocuments({ ...dual, isOffline: true }),
    fullRefund: await audit.countDocuments({ ...store, action: 'sale_refunded_full', createdAt: range }),
    partialRefund: await audit.countDocuments({ ...store, action: 'sale_refunded_partial', createdAt: range }),
    heldCreate: await audit.countDocuments({ ...store, action: 'sale_held', createdAt: range }),
    heldResume: await audit.countDocuments({ ...store, action: 'sale_completed', 'metadata.fromHeld': true, createdAt: range }),
    heldDiscard: await audit.countDocuments({ ...store, action: 'held_sale_discarded', createdAt: range }),
    shiftCloseCardVariance: await audit.countDocuments({ ...store, action: 'card_variance_approved', createdAt: range }),
  };
  const missing = FLIP_PATHS.filter((p) => paths[p] === 0);

  // 4) clean days
  const days: Array<{ day: string; mismatches: number }> = [];
  for (let t = new Date(Date.UTC(opts.from.getUTCFullYear(), opts.from.getUTCMonth(), opts.from.getUTCDate())); t <= to; t = new Date(t.getTime() + 86_400_000)) days.push({ day: dayKey(t), mismatches: byDay.get(dayKey(t)) ?? 0 });
  let consecutive = 0;
  for (let i = days.length - 1; i >= 0 && days[i].mismatches === 0; i--) consecutive++;

  const total = auditMismatch.length + scanViolations;
  const reasons: string[] = [];
  if (total > 0) reasons.push(`${total} mismatch(es) in the window (${auditMismatch.length} audit event(s), ${scanViolations} row(s) failing the re-scan)`);
  if (consecutive < minCleanDays) reasons.push(`only ${consecutive} consecutive clean day(s) ending at ${dayKey(opts.to)}; ${minCleanDays} required`);
  if (missing.length) reasons.push(`paths never exercised in the window: ${missing.join(', ')}`);
  return {
    from: dayKey(opts.from), to: dayKey(opts.to), minCleanDays, clientPayloadMismatches,
    mismatches: { auditEvents: auditMismatch.length, scanViolations, total, byKind, firstExamples: examples.length ? examples : (auditMismatch as any[]).slice(0, 3).map((a) => ({ id: a.targetId, kind: a.targetType, mismatches: a.metadata?.mismatches?.slice(0, 2) })) },
    checkedRows: scan, days, consecutiveCleanDaysEndingAtTo: consecutive, pathCounts: paths, pathsMissing: missing, ready: reasons.length === 0, reasons,
  };
}
