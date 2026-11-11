/* eslint-disable prettier/prettier */
// Pure deadline rules for seller verification enforcement (owner decision 4):
//   - enforcement not started            → no deadline, nothing limited
//   - store created BEFORE enforcement    → due = enforcementStartedAt + graceDays
//   - store created at/after enforcement  → due = createdAt (limited until verified)

export interface SellerTrustSettings {
  enforcementStartedAt: Date | null;
  graceDays: number;
}

export const DEFAULT_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeadlineStoreInput {
  createdAt?: Date | string | null;
  verificationStatus?: string | null;
}

export function verificationDeadline(store: DeadlineStoreInput, settings: SellerTrustSettings): Date | null {
  if (!settings?.enforcementStartedAt) return null;
  const start = new Date(settings.enforcementStartedAt);
  const graceDays = Number.isFinite(settings.graceDays) ? settings.graceDays : DEFAULT_GRACE_DAYS;
  const created = store?.createdAt ? new Date(store.createdAt) : null;
  // A store with no createdAt (shouldn't happen) is treated as pre-existing — it gets the grace period.
  if (!created || created.getTime() < start.getTime()) return new Date(start.getTime() + graceDays * DAY_MS);
  return created;
}

export function isTrustLimited(store: DeadlineStoreInput, settings: SellerTrustSettings, now: Date = new Date()): boolean {
  if (store?.verificationStatus === 'verified') return false;
  const due = verificationDeadline(store, settings);
  return !!due && now.getTime() >= due.getTime();
}

/** The `{ dueAt, limited, enforcementStarted }` block the seller and admin APIs return. */
export function deadlineInfo(store: DeadlineStoreInput, settings: SellerTrustSettings, now: Date = new Date()) {
  return {
    dueAt: verificationDeadline(store, settings),
    limited: isTrustLimited(store, settings, now),
    enforcementStarted: !!settings?.enforcementStartedAt,
  };
}

export const PAYOUT_HOLD_MESSAGE = 'Payouts are on hold until your business is verified';
export const PAYOUT_MANUAL_HOLD_MESSAGE = 'Payouts for this store are on hold. Please contact Solvexo support.';

/** Why payouts are refused for this store right now, or null when they're allowed. */
export function payoutBlockReason(
  store: DeadlineStoreInput & { payoutHold?: { active?: boolean } | null },
  settings: SellerTrustSettings,
  now: Date = new Date(),
): string | null {
  if (store?.payoutHold?.active) return PAYOUT_MANUAL_HOLD_MESSAGE;
  if (isTrustLimited(store, settings, now)) return PAYOUT_HOLD_MESSAGE;
  return null;
}
