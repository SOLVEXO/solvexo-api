import { deriveRollupStatus, deriveSellerOrderStatus, deriveOrderStatus } from './order-status.util';

describe('deriveRollupStatus', () => {
  it('returns "pending" for an empty list', () => {
    expect(deriveRollupStatus([])).toBe('pending');
  });

  it('rolls up to the shared stage when every child is at the same fulfillment stage', () => {
    expect(deriveRollupStatus(['pending', 'pending'])).toBe('pending');
    expect(deriveRollupStatus(['processing', 'processing'])).toBe('processing');
    expect(deriveRollupStatus(['shipped', 'shipped'])).toBe('shipped');
    expect(deriveRollupStatus(['delivered', 'delivered'])).toBe('delivered');
    expect(deriveRollupStatus(['completed', 'completed'])).toBe('completed');
  });

  it('rolls up to "partially_shipped" for a mix of fulfillment stages with no cancellations', () => {
    expect(deriveRollupStatus(['pending', 'processing'])).toBe('partially_shipped');
    expect(deriveRollupStatus(['processing', 'shipped'])).toBe('partially_shipped');
    expect(deriveRollupStatus(['shipped', 'completed'])).toBe('partially_shipped');
  });

  it('rolls up to "cancelled" only when every child is cancelled', () => {
    expect(deriveRollupStatus(['cancelled', 'cancelled'])).toBe('cancelled');
    expect(deriveRollupStatus(['cancelled'])).toBe('cancelled');
  });

  it('rolls up to "refunded" only when every child is refunded', () => {
    expect(deriveRollupStatus(['refunded', 'refunded'])).toBe('refunded');
  });

  it('rolls up to "partially_cancelled" when some (not all) children are cancelled — the real bug this replaces', () => {
    // Previously: a partial cancellation left the parent's stored status
    // completely stale (still 'processing') since every hand-rolled
    // derivation only ever checked "are ALL items cancelled".
    expect(deriveRollupStatus(['cancelled', 'processing'])).toBe('partially_cancelled');
    expect(deriveRollupStatus(['cancelled', 'completed'])).toBe('partially_cancelled');
    expect(deriveRollupStatus(['cancelled', 'pending', 'shipped'])).toBe('partially_cancelled');
  });

  it('rolls up to "partially_refunded" when some (not all) children are refunded', () => {
    expect(deriveRollupStatus(['refunded', 'completed'])).toBe('partially_refunded');
  });

  it('prefers "partially_refunded" over "partially_cancelled" when both a cancellation and a refund are present', () => {
    expect(deriveRollupStatus(['cancelled', 'refunded', 'completed'])).toBe('partially_refunded');
  });

  it('handles a single-item list (the common case: one item per seller order)', () => {
    expect(deriveRollupStatus(['shipped'])).toBe('shipped');
  });

  it('ignores an unrecognized status string rather than throwing (forward-compatible with schema drift)', () => {
    expect(deriveRollupStatus(['pending', 'some_future_status'])).toBe('pending');
  });
});

describe('deriveSellerOrderStatus / deriveOrderStatus — object-shaped wrappers', () => {
  it('deriveSellerOrderStatus extracts .status from OrderItem-shaped objects', () => {
    expect(deriveSellerOrderStatus([{ status: 'shipped' }, { status: 'shipped' }])).toBe('shipped');
    expect(deriveSellerOrderStatus([{ status: 'cancelled' }, { status: 'delivered' }])).toBe('partially_cancelled');
  });

  it('deriveOrderStatus extracts .status from SellerOrder-shaped objects', () => {
    expect(deriveOrderStatus([{ status: 'completed' }, { status: 'completed' }])).toBe('completed');
    expect(deriveOrderStatus([{ status: 'processing' }, { status: 'shipped' }])).toBe('partially_shipped');
  });
});
