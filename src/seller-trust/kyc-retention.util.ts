/* eslint-disable prettier/prettier */
// Pure rules for how long seller verification documents are kept (no database, no Nest). The periods come from the admin
// settings (defaults below) because they are a legal decision that may change; the code never hard-codes them.
//
//  - A store that is still OPEN: its files are never touched while it is pending / under review / verified. Files that never
//    reached review (not_started) or whose review ended without a fix (rejected / needs_info) are deleted after N days.
//  - A store that was CLOSED (seller account deleted): if it ever went through verification its files and identity data are
//    kept for the retention years counted from the closing date (tax / audit records), then erased. If it never submitted
//    anything there is no reason to keep it, so it is erased at once.

export const DEFAULT_KYC_RETENTION_YEARS = 6;
export const DEFAULT_KYC_DRAFT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses whose files may expire while the store is open: nobody is reviewing them any more. */
export const EXPIRING_DRAFT_STATUSES = ['not_started', 'needs_info', 'rejected'] as const;

export function addYears(date: Date | string, years: number): Date {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

export interface RetentionDoc { type?: string; publicId: string; resourceType?: string; uploadedAt?: Date | string | null }

/** When the store was closed: the recorded closing date, else the last time the document changed (older rows have no closing date). */
export function closedAtOf(store: { verificationClosedAt?: Date | string | null; updatedAt?: Date | string | null; createdAt?: Date | string | null }): Date | null {
  const raw = store.verificationClosedAt ?? store.updatedAt ?? store.createdAt ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Should the identity data + files of this CLOSED store be erased now?
 * `submitted` = it ever went to review. A store without a known closing date is never erased (we cannot prove the period ended).
 */
export function closedStoreDue(
  store: { verificationClosedAt?: Date | string | null; updatedAt?: Date | string | null; createdAt?: Date | string | null; verification?: { submitted?: boolean | null } | null },
  retentionYears: number,
  now: Date = new Date(),
): boolean {
  if (!store.verification?.submitted) return true; // never submitted: no legal reason to keep anything
  const closedAt = closedAtOf(store);
  if (!closedAt) return false;
  return addYears(closedAt, retentionYears).getTime() <= now.getTime();
}

/**
 * The files of an OPEN store that expired. not_started: each file on its own age (from its upload). rejected / needs_info: all files,
 * once the decision is older than `days` (the seller had that long to fix it). Anything else (pending, under_review, verified): none.
 */
export function expiredDraftDocs(
  store: { verificationStatus?: string | null; reviewedAt?: Date | string | null; verification?: { documents?: RetentionDoc[] | null } | null },
  days: number,
  now: Date = new Date(),
): RetentionDoc[] {
  const docs = store.verification?.documents ?? [];
  if (!docs.length) return [];
  const status = store.verificationStatus ?? 'not_started';
  if (!(EXPIRING_DRAFT_STATUSES as readonly string[]).includes(status)) return [];
  const limit = days * DAY_MS;
  if (status === 'not_started') {
    return docs.filter((d) => d.uploadedAt && now.getTime() - new Date(d.uploadedAt).getTime() >= limit);
  }
  if (!store.reviewedAt) return [];
  return now.getTime() - new Date(store.reviewedAt).getTime() >= limit ? docs : [];
}

/** Every private file a store's verification holds: the live documents and the ones waiting in a change request. */
export function allKycFiles(verification: { documents?: RetentionDoc[] | null; change?: { documents?: RetentionDoc[] | null } | null } | null | undefined): RetentionDoc[] {
  return [...(verification?.documents ?? []), ...(verification?.change?.documents ?? [])];
}
