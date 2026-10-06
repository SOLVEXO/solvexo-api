/* eslint-disable prettier/prettier */
import { canApplyReturnAction, canReceiveReturnLine, canRefundReturnLine, pickRestockChoice, splitRefundShares } from './order-returns.util';
import { effectiveReturnStatus, isLegacyResolvedReturn, withEffectiveReturnStatus } from '../common/return-status.util';

describe('legacy return detection', () => {
  it('treats approved lines that carry a refund or an exchange as finished', () => {
    expect(isLegacyResolvedReturn({ returnStatus: 'approved', refundedAmount: 10 })).toBe(true);
    expect(isLegacyResolvedReturn({ returnStatus: 'approved', exchangeOrderId: 'x' })).toBe(true);
    expect(isLegacyResolvedReturn({ returnStatus: 'approved', refundedAmount: 0 })).toBe(false);
    expect(isLegacyResolvedReturn({ returnStatus: 'refunded', refundedAmount: 10 })).toBe(false);
  });
  it('maps them to refunded / exchanged for display', () => {
    expect(effectiveReturnStatus({ returnStatus: 'approved', refundedAmount: 5 })).toBe('refunded');
    expect(effectiveReturnStatus({ returnStatus: 'approved', exchangeOrderId: 'x', refundedAmount: 5 })).toBe('exchanged');
    expect(effectiveReturnStatus({ returnStatus: 'approved' })).toBe('approved');
    expect(effectiveReturnStatus({})).toBe('none');
    expect(withEffectiveReturnStatus({ returnStatus: 'approved', refundedAmount: 5 }).returnStatus).toBe('refunded');
  });
});

describe('canApplyReturnAction', () => {
  it('approve / reject only from requested', () => {
    expect(canApplyReturnAction({ returnStatus: 'requested' }, 'approve').ok).toBe(true);
    expect(canApplyReturnAction({ returnStatus: 'requested' }, 'reject').ok).toBe(true);
    expect(canApplyReturnAction({ returnStatus: 'approved' }, 'approve').ok).toBe(false);
    expect(canApplyReturnAction({ returnStatus: 'received' }, 'reject').ok).toBe(false);
  });
  it('close from approved or received, never for legacy refunded lines', () => {
    expect(canApplyReturnAction({ returnStatus: 'approved' }, 'close').ok).toBe(true);
    expect(canApplyReturnAction({ returnStatus: 'received' }, 'close').ok).toBe(true);
    expect(canApplyReturnAction({ returnStatus: 'requested' }, 'close').ok).toBe(false);
    expect(canApplyReturnAction({ returnStatus: 'approved', refundedAmount: 9 }, 'close').ok).toBe(false);
  });
});

describe('receive / refund eligibility', () => {
  it('receives approved physical lines only', () => {
    expect(canReceiveReturnLine({ type: 'physical', returnStatus: 'approved' }).ok).toBe(true);
    expect(canReceiveReturnLine({ type: 'physical', returnStatus: 'requested' }).ok).toBe(false);
    expect(canReceiveReturnLine({ type: 'physical', returnStatus: 'received' }).ok).toBe(false);
    expect(canReceiveReturnLine({ type: 'digital', returnStatus: 'approved' }).ok).toBe(false);
    expect(canReceiveReturnLine({ type: 'physical', returnStatus: 'approved', refundedAmount: 3 }).ok).toBe(false);
  });
  it('refunds received lines only, once', () => {
    expect(canRefundReturnLine({ returnStatus: 'received' }).ok).toBe(true);
    expect(canRefundReturnLine({ returnStatus: 'approved' }).ok).toBe(false);
    expect(canRefundReturnLine({ returnStatus: 'refunded' }).ok).toBe(false);
    expect(canRefundReturnLine({ returnStatus: 'received', exchangeOrderId: 'x' }).ok).toBe(false);
  });
});

describe('pickRestockChoice', () => {
  it('prefers the per-line decision, then the default, else none', () => {
    expect(pickRestockChoice('a', { a: 'damaged' }, 'restock')).toBe('damaged');
    expect(pickRestockChoice('b', { a: 'damaged' }, 'restock')).toBe('restock');
    expect(pickRestockChoice('b', undefined, undefined)).toBe('none');
    expect(pickRestockChoice('b', { b: 'bogus' }, null)).toBe('none');
  });
});

describe('splitRefundShares', () => {
  it('splits proportionally and sums exactly to the granted amount', () => {
    const s = splitRefundShares([10, 20, 30], 50);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(50, 5);
    expect(s[0]).toBeCloseTo(8.33, 2);
  });
  it('returns zeros when nothing was granted', () => {
    expect(splitRefundShares([10, 20], 0)).toEqual([0, 0]);
  });
});
