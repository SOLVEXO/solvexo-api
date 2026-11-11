import { deadlineInfo, isTrustLimited, payoutBlockReason, verificationDeadline, PAYOUT_HOLD_MESSAGE } from './seller-trust-deadline.util';

const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2026-11-01T00:00:00Z');
const on = { enforcementStartedAt: start, graceDays: 30 };
const off = { enforcementStartedAt: null, graceDays: 30 };

describe('verification deadline', () => {
  it('no deadline and nothing limited before enforcement starts', () => {
    const store = { createdAt: new Date('2026-01-01'), verificationStatus: 'not_started' };
    expect(verificationDeadline(store, off)).toBeNull();
    expect(isTrustLimited(store, off, new Date('2030-01-01'))).toBe(false);
    expect(deadlineInfo(store, off)).toEqual({ dueAt: null, limited: false, enforcementStarted: false });
  });

  it('existing stores get enforcementStartedAt + graceDays', () => {
    const store = { createdAt: new Date('2026-01-01'), verificationStatus: 'pending' };
    const due = verificationDeadline(store, on)!;
    expect(due.toISOString()).toBe(new Date(start.getTime() + 30 * DAY).toISOString());
    expect(isTrustLimited(store, on, new Date(due.getTime() - 1))).toBe(false);
    expect(isTrustLimited(store, on, due)).toBe(true);
  });

  it('stores created after enforcement started are due immediately (no grace)', () => {
    const created = new Date(start.getTime() + 5 * DAY);
    const store = { createdAt: created, verificationStatus: 'not_started' };
    expect(verificationDeadline(store, on)).toEqual(created);
    expect(isTrustLimited(store, on, created)).toBe(true);
  });

  it('a verified store is never limited', () => {
    const store = { createdAt: new Date('2026-01-01'), verificationStatus: 'verified' };
    expect(isTrustLimited(store, on, new Date('2030-01-01'))).toBe(false);
  });

  it('respects a custom grace period', () => {
    const store = { createdAt: new Date('2026-01-01') };
    expect(verificationDeadline(store, { enforcementStartedAt: start, graceDays: 7 })!.getTime()).toBe(start.getTime() + 7 * DAY);
  });

  it('payouts: refused when limited or on a manual hold', () => {
    const later = new Date('2030-01-01');
    expect(payoutBlockReason({ createdAt: new Date('2026-01-01'), verificationStatus: 'pending' }, on, later)).toBe(PAYOUT_HOLD_MESSAGE);
    expect(payoutBlockReason({ createdAt: new Date('2026-01-01'), verificationStatus: 'pending' }, on, new Date('2026-11-02'))).toBeNull();
    expect(payoutBlockReason({ createdAt: new Date('2026-01-01'), verificationStatus: 'verified', payoutHold: { active: true } }, off)).toMatch(/on hold/);
    expect(payoutBlockReason({ createdAt: new Date('2026-01-01'), verificationStatus: 'verified', payoutHold: null }, on, later)).toBeNull();
  });
});
