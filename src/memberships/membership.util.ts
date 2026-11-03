export type PlanInterval = 'week' | 'month' | 'year';

export const DUNNING_DAYS = [1, 3, 5, 7]; // retry / reminder ladder after the due date
export const MAX_GRACE_DAYS = 7;
export const REMINDER_DAYS_BEFORE = 7;
const DAY = 86_400_000;

export function addInterval(from: Date, interval: PlanInterval, count: number): Date {
  const d = new Date(from.getTime());
  if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7 * count);
  else if (interval === 'month') {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + count);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last)); // Jan 31 + 1 month = Feb 28/29
  } else d.setUTCFullYear(d.getUTCFullYear() + count);
  return d;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Unused part of the current period, in money (what an upgrade gets back). */
export function prorationCredit(amount: number, periodStart: Date, periodEnd: Date, now: Date): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0 || amount <= 0) return 0;
  const left = Math.min(Math.max(periodEnd.getTime() - now.getTime(), 0), total);
  return round2((amount * left) / total);
}

/** What the buyer owes today when moving to a more expensive plan mid-period. */
export function upgradeAmountDue(newAmount: number, credit: number): number {
  return Math.max(0, round2(newAmount - credit));
}

export type DunningAction = 'wait' | 'retry' | 'revoke';

/**
 * A subscription whose renewal is unpaid since `dueAt`: reminders/retries at +1/+3/+5/+7 days, then the
 * subscription expires. (The seller-configured 0-7 day grace only decides how long ACCESS continues, see accessUntil.) `failedCount` = reminders/retries already sent.
 */
export function dunningDecision(p: { failedCount: number; dueAt: Date; now: Date; graceDays?: number }): { action: DunningAction; nextAt: Date | null } {
  const elapsedDays = (p.now.getTime() - p.dueAt.getTime()) / DAY;
  const revokeAfter = DUNNING_DAYS[DUNNING_DAYS.length - 1];
  if (elapsedDays >= revokeAfter && p.failedCount >= DUNNING_DAYS.length) return { action: 'revoke', nextAt: null };
  const next = DUNNING_DAYS[p.failedCount];
  if (next !== undefined && elapsedDays >= next) return { action: 'retry', nextAt: new Date(p.dueAt.getTime() + (DUNNING_DAYS[p.failedCount + 1] ?? revokeAfter) * DAY) };
  return { action: 'wait', nextAt: new Date(p.dueAt.getTime() + (next ?? revokeAfter) * DAY) };
}

/** Last moment a past-due member still has access. */
export const accessUntil = (dueAt: Date, graceDays: number): Date => new Date(dueAt.getTime() + Math.min(Math.max(Math.floor(graceDays || 0), 0), MAX_GRACE_DAYS) * DAY);
