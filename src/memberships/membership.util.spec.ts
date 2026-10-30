import { accessUntil, addInterval, dunningDecision, prorationCredit, upgradeAmountDue } from './membership.util';

const d = (s: string) => new Date(s + 'T00:00:00Z');

describe('membership.util', () => {
  it('adds intervals, clamping month ends', () => {
    expect(addInterval(d('2026-01-31'), 'month', 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addInterval(d('2026-01-15'), 'week', 2).toISOString().slice(0, 10)).toBe('2026-01-29');
    expect(addInterval(d('2026-03-10'), 'year', 1).toISOString().slice(0, 10)).toBe('2027-03-10');
  });

  it('prorates the unused part of a period', () => {
    expect(prorationCredit(30, d('2026-01-01'), d('2026-01-31'), d('2026-01-16'))).toBe(15);
    expect(prorationCredit(30, d('2026-01-01'), d('2026-01-31'), d('2026-02-10'))).toBe(0);
    expect(prorationCredit(30, d('2026-01-01'), d('2026-01-31'), d('2025-12-01'))).toBe(30);
    expect(upgradeAmountDue(50, 15)).toBe(35);
    expect(upgradeAmountDue(10, 15)).toBe(0);
  });

  it('walks the dunning ladder 1/3/5/7 days then revokes', () => {
    const due = d('2026-01-01');
    const at = (days: number) => new Date(due.getTime() + days * 86_400_000);
    expect(dunningDecision({ failedCount: 0, dueAt: due, now: at(0.5) }).action).toBe('wait');
    expect(dunningDecision({ failedCount: 0, dueAt: due, now: at(1) }).action).toBe('retry');
    expect(dunningDecision({ failedCount: 1, dueAt: due, now: at(2) }).action).toBe('wait');
    expect(dunningDecision({ failedCount: 1, dueAt: due, now: at(3) }).action).toBe('retry');
    expect(dunningDecision({ failedCount: 3, dueAt: due, now: at(7) }).action).toBe('retry');
    expect(dunningDecision({ failedCount: 4, dueAt: due, now: at(7) }).action).toBe('revoke');
  });

  it('grace period bounds access (0-7 days)', () => {
    expect(accessUntil(d('2026-01-01'), 3).toISOString().slice(0, 10)).toBe('2026-01-04');
    expect(accessUntil(d('2026-01-01'), 99).toISOString().slice(0, 10)).toBe('2026-01-08');
    expect(accessUntil(d('2026-01-01'), -1).toISOString().slice(0, 10)).toBe('2026-01-01');
  });
});
