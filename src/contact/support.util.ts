import type { SupportTier } from './schemas/contact-submission.schema';

/** Higher number = answered first in the admin inbox. */
export const TIER_RANK: Record<SupportTier, number> = { dedicated: 2, priority: 1, standard: 0 };

/**
 * The support tier of a store, decided ONLY from its plan limits on the server.
 * No time promises are attached to a tier: it only decides the order in the admin inbox.
 */
export function tierFromLimits(limits: { prioritySupport?: boolean; dedicatedAccountManager?: boolean } | null | undefined): SupportTier {
  if (limits?.dedicatedAccountManager) return 'dedicated';
  if (limits?.prioritySupport) return 'priority';
  return 'standard';
}

interface Sortable {
  status?: string;
  tier?: string | null;
  createdAt?: Date | string | null;
}

const time = (v: Sortable['createdAt']) => (v ? new Date(v).getTime() : 0);
const rankOf = (t?: string | null) => TIER_RANK[(t as SupportTier) ?? 'standard'] ?? 0;

/**
 * Admin inbox order: OPEN requests first (new / read) by tier (dedicated, priority, standard) and then the oldest first;
 * resolved ones follow, newest first. Returns a new array.
 */
export function sortSubmissions<T extends Sortable>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aOpen = a.status !== 'resolved';
    const bOpen = b.status !== 'resolved';
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (!aOpen) return time(b.createdAt) - time(a.createdAt);
    const byTier = rankOf(b.tier) - rankOf(a.tier);
    if (byTier !== 0) return byTier;
    return time(a.createdAt) - time(b.createdAt);
  });
}
