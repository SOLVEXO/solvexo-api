/* eslint-disable prettier/prettier */
import { round } from '../common/number.util';
import { effectiveReturnStatus, isLegacyResolvedReturn } from '../common/return-status.util';

export type ReturnAction = 'approve' | 'reject' | 'close';
export type RestockChoice = 'restock' | 'damaged' | 'none';

interface Line { type?: string; returnStatus?: string; refundedAmount?: number; exchangeOrderId?: string | null; status?: string; name?: string }

/** Which current status each seller action may start from. */
export const RETURN_ACTION_FROM: Record<ReturnAction, string[]> = {
  approve: ['requested'],
  reject: ['requested'],
  close: ['approved', 'received'],
};
export const RETURN_ACTION_TO: Record<ReturnAction, string> = { approve: 'approved', reject: 'rejected', close: 'closed' };

/** Is `action` allowed on a line right now? New-flow lines only: legacy approved+refunded lines are already finished. */
export function canApplyReturnAction(item: Line, action: ReturnAction): { ok: boolean; reason?: string } {
  if (isLegacyResolvedReturn(item)) return { ok: false, reason: 'This return was already refunded or exchanged' };
  const cur = item.returnStatus || 'none';
  if (!RETURN_ACTION_FROM[action].includes(cur)) {
    return { ok: false, reason: action === 'close' ? 'Only an approved or received return can be closed' : 'This item has no pending return request' };
  }
  return { ok: true };
}

/** "Mark as received" applies to approved (not yet resolved) physical lines only. */
export function canReceiveReturnLine(item: Line): { ok: boolean; reason?: string } {
  if (item.type !== 'physical') return { ok: false, reason: 'Only physical items can be received back' };
  if (isLegacyResolvedReturn(item)) return { ok: false, reason: 'This return was already refunded or exchanged' };
  if (item.returnStatus === 'received') return { ok: false, reason: 'This return was already marked as received' };
  if (item.returnStatus !== 'approved') return { ok: false, reason: 'Approve the return before marking it as received' };
  return { ok: true };
}

/** Refund resolution applies to received lines only (refunding earlier = the order-level "Refund" action). */
export function canRefundReturnLine(item: Line): { ok: boolean; reason?: string } {
  if (item.exchangeOrderId) return { ok: false, reason: 'This item was already exchanged' };
  if (isLegacyResolvedReturn(item) || effectiveReturnStatus(item) === 'refunded') return { ok: false, reason: 'This return was already refunded' };
  if (item.returnStatus !== 'received') return { ok: false, reason: 'Mark the return as received before refunding it' };
  return { ok: true };
}

/** Per-line restock choice: explicit map entry wins, then the request-wide default, else untouched. */
export function pickRestockChoice(itemId: string, decisions: Record<string, unknown> | undefined | null, fallback?: string | null): RestockChoice {
  const v = decisions && typeof decisions === 'object' ? decisions[itemId] : undefined;
  const c = (v ?? fallback) as string | undefined;
  return c === 'restock' || c === 'damaged' ? c : 'none';
}

/** Splits the granted refund over lines by (price + tax) weight; the last line takes the rounding remainder. */
export function splitRefundShares(wantedPerLine: number[], granted: number): number[] {
  const total = wantedPerLine.reduce((s, w) => s + w, 0);
  if (!(total > 0) || !(granted > 0)) return wantedPerLine.map(() => 0);
  let used = 0;
  return wantedPerLine.map((w, i) => {
    if (i === wantedPerLine.length - 1) return round(Math.max(0, granted - used));
    const share = round((granted * w) / total);
    used = round(used + share);
    return share;
  });
}
