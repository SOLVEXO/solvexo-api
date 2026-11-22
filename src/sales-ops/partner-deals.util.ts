/* eslint-disable prettier/prettier */

/**
 * Channel Partner Programme B7 (deal registration and attribution), as pure functions:
 *  - a partner registers a prospect, with the seller's permission;
 *  - Solvexo accepts or rejects within N working days, with a reason;
 *  - an accepted registration is protected for N days, extended when the partner shows progress;
 *  - the earliest accepted registration wins a duplicate; existing customers and house accounts are not registrable;
 *  - the seller always chooses: a registration never blocks a seller from signing up on their own.
 */

export const DEAL_STATUSES = ['pending', 'accepted', 'rejected', 'expired', 'won', 'lost'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
export const DEAL_PROGRESS = ['demo_held', 'trial_started', 'other'] as const;

const DAY = 86_400_000;

/** Adds working days (Monday–Friday); the deadline is the end of that working day. */
export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    d.setTime(d.getTime() + DAY);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

export const phoneKeyOf = (raw: string | null | undefined) => {
  const k = (raw ?? '').replace(/\D/g, '').slice(-10);
  return k.length >= 9 ? k : null;
};
export const emailKeyOf = (raw: string | null | undefined) => {
  const e = (raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
};
/** Business names compared loosely: lower case, letters and digits only, common suffixes dropped. */
export const nameKeyOf = (raw: string | null | undefined) => {
  const k = (raw ?? '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llc|co|company|store|shop|traders?|enterprises?)\b/g, '').replace(/[^a-z0-9]/g, '');
  return k.length >= 3 ? k : null;
};

export interface DealKeys { phoneKey: string | null; emailKey: string | null; nameKey: string | null }

export function keysOf(p: { phone?: string | null; email?: string | null; businessName?: string | null }): DealKeys {
  return { phoneKey: phoneKeyOf(p.phone), emailKey: emailKeyOf(p.email), nameKey: nameKeyOf(p.businessName) };
}

/** Same prospect: same phone or same email; a same-name match alone is only a hint. */
export function sameProspect(a: DealKeys, b: DealKeys): 'strong' | 'name' | null {
  if ((a.phoneKey && a.phoneKey === b.phoneKey) || (a.emailKey && a.emailKey === b.emailKey)) return 'strong';
  if (a.nameKey && a.nameKey === b.nameKey) return 'name';
  return null;
}

export interface ConflictInput {
  keys: DealKeys;
  partnerId: string;
  /** Other registrations still in play (pending, or accepted and protected). */
  others: { id: string; partnerId: string; partnerName: string; status: DealStatus; submittedAt: Date; protectedUntil: Date | null; keys: DealKeys }[];
  /** Existing Solvexo sellers (already a customer). */
  customers: { sellerId: string; name: string; keys: DealKeys }[];
  /** The partner's house accounts (B6): names or emails Solvexo handles directly. */
  houseAccounts: string[];
  now: Date;
}

export interface Conflict { kind: 'customer' | 'house_account' | 'registered' | 'pending_elsewhere' | 'name_match'; detail: string; refId?: string }

/**
 * What stands in the way of a registration. `autoReject` holds the reason when B7 decides it on its own:
 * an existing customer, a house account, or another partner's accepted registration that is still protected.
 */
export function conflictsFor(c: ConflictInput): { conflicts: Conflict[]; autoReject: string | null } {
  const out: Conflict[] = [];
  let autoReject: string | null = null;
  for (const s of c.customers) {
    const m = sameProspect(c.keys, s.keys);
    if (m === 'strong') { out.push({ kind: 'customer', detail: `Already a Solvexo customer (${s.name})`, refId: s.sellerId }); autoReject ??= 'Already a Solvexo customer.'; }
    else if (m === 'name') out.push({ kind: 'name_match', detail: `Same name as Solvexo customer ${s.name}: check it is not the same business`, refId: s.sellerId });
  }
  const house = c.houseAccounts.map((h) => h.trim()).filter(Boolean);
  for (const h of house) {
    const hk: DealKeys = { phoneKey: null, emailKey: emailKeyOf(h), nameKey: nameKeyOf(h) };
    if (sameProspect(c.keys, hk)) { out.push({ kind: 'house_account', detail: `House account: ${h}` }); autoReject ??= 'This is a house account Solvexo handles directly.'; }
  }
  for (const o of c.others) {
    if (o.partnerId === c.partnerId) continue;
    const m = sameProspect(c.keys, o.keys);
    if (!m) continue;
    const protectedNow = o.status === 'accepted' && o.protectedUntil && o.protectedUntil.getTime() > c.now.getTime();
    if (m === 'strong' && protectedNow) {
      out.push({ kind: 'registered', detail: `Registered by ${o.partnerName} (protected until ${o.protectedUntil!.toISOString().slice(0, 10)})`, refId: o.id });
      autoReject ??= 'Already registered by another partner.';
    } else if (m === 'strong' && o.status === 'pending') {
      out.push({ kind: 'pending_elsewhere', detail: `Also submitted by ${o.partnerName} on ${o.submittedAt.toISOString().slice(0, 10)}: the earlier one wins`, refId: o.id });
    } else if (m === 'name') {
      out.push({ kind: 'name_match', detail: `Similar name registered by ${o.partnerName}`, refId: o.id });
    }
  }
  return { conflicts: out, autoReject };
}

/** B7.3: protection runs from acceptance; an extension adds days from the later of now and the current end. */
export function protectedUntilAfter(base: Date, days: number): Date {
  return new Date(base.getTime() + days * DAY);
}

export function extendProtection(current: Date | null, now: Date, days: number): Date {
  const from = current && current.getTime() > now.getTime() ? current : now;
  return new Date(from.getTime() + days * DAY);
}
