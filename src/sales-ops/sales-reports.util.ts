/* eslint-disable prettier/prettier */

/**
 * Sales Ops reports: campaign results and the team leaderboard. Pure functions; the service collects the rows.
 *
 * Campaign attribution: a lead counts when its utm_campaign is the campaign's code; a merchant sign-up counts when
 * the merchant's own sign-up carried that code (Seller.acquisitionCampaign) OR the merchant is linked to one of the
 * campaign's leads. Each merchant counts once per campaign. Codes are compared lower-case.
 */

const round = (n: number) => Math.round(n);
const per = (spend: number, n: number) =>
  spend > 0 && n > 0 ? round(spend / n) : null;

export interface CampaignInput {
  id: string;
  code: string;
  name: string;
  channel: string;
  budgetPKR: number | null;
  startDate: Date | null;
  endDate: Date | null;
  isArchived: boolean;
  spend: { amountPKR: number }[];
}
export interface LeadRow {
  id: string;
  campaign: string | null;
  stage: string;
  sellerId: string | null;
  dealValuePKR?: number | null;
}
export interface MerchantRow {
  sellerId: string;
  campaign: string | null;
  /** Ever started a trial (any subscription that had a trial). */
  trialed: boolean;
  /** Ever paid for a plan. */
  paid: boolean;
  /** MRR right now, USD. */
  mrrUSD: number;
}

export interface CampaignResult {
  id: string;
  code: string;
  name: string;
  channel: string;
  isArchived: boolean;
  startDate: Date | null;
  endDate: Date | null;
  budgetPKR: number | null;
  spendPKR: number;
  leads: number;
  wonLeads: number;
  signups: number;
  trials: number;
  paying: number;
  payingNow: number;
  mrrUSD: number;
  mrrPKR: number | null;
  costPerLeadPKR: number | null;
  costPerSignupPKR: number | null;
  costPerPayingPKR: number | null;
  /** Months of today's MRR it takes to earn back the spend. */
  paybackMonths: number | null;
}

export const normCode = (s: string | null | undefined) =>
  (s ?? '').trim().toLowerCase() || null;

/** "Eid Sale 2026!" → "eid-sale-2026". */
export function campaignCode(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

export function campaignResults(
  campaigns: CampaignInput[],
  leads: LeadRow[],
  merchants: MerchantRow[],
  pkrPerUSD: number | null,
): CampaignResult[] {
  const merchantById = new Map(merchants.map((m) => [m.sellerId, m]));
  return campaigns.map((c) => {
    const code = normCode(c.code);
    const cLeads = leads.filter((l) => normCode(l.campaign) === code);
    const sellerIds = new Set<string>([
      ...merchants
        .filter((m) => normCode(m.campaign) === code)
        .map((m) => m.sellerId),
      ...cLeads
        .map((l) => l.sellerId)
        .filter((x): x is string => !!x && merchantById.has(x)),
    ]);
    const ms = [...sellerIds].map((id) => merchantById.get(id)!);
    const spendPKR = round(
      c.spend.reduce((s, x) => s + (x.amountPKR > 0 ? x.amountPKR : 0), 0),
    );
    const paying = ms.filter((m) => m.paid).length;
    const mrrUSD = Math.round(ms.reduce((s, m) => s + m.mrrUSD, 0) * 100) / 100;
    const mrrPKR = pkrPerUSD ? round(mrrUSD * pkrPerUSD) : null;
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      channel: c.channel,
      isArchived: c.isArchived,
      startDate: c.startDate,
      endDate: c.endDate,
      budgetPKR: c.budgetPKR,
      spendPKR,
      leads: cLeads.length,
      wonLeads: cLeads.filter((l) => l.stage === 'won').length,
      signups: ms.length,
      trials: ms.filter((m) => m.trialed).length,
      paying,
      payingNow: ms.filter((m) => m.mrrUSD > 0).length,
      mrrUSD,
      mrrPKR,
      costPerLeadPKR: per(spendPKR, cLeads.length),
      costPerSignupPKR: per(spendPKR, ms.length),
      costPerPayingPKR: per(spendPKR, paying),
      paybackMonths:
        spendPKR > 0 && mrrPKR
          ? Math.round((spendPKR / mrrPKR) * 10) / 10
          : null,
    };
  });
}

/** utm_campaign codes seen on leads or sign-ups that no campaign tracks yet, most used first. */
export function untrackedCodes(
  campaignCodes: string[],
  leads: LeadRow[],
  merchants: MerchantRow[],
): { code: string; leads: number; signups: number }[] {
  const known = new Set(campaignCodes.map(normCode));
  const out = new Map<string, { leads: number; signups: number }>();
  const bump = (code: string | null, k: 'leads' | 'signups') => {
    if (!code || known.has(code)) return;
    const row = out.get(code) ?? { leads: 0, signups: 0 };
    row[k]++;
    out.set(code, row);
  };
  leads.forEach((l) => bump(normCode(l.campaign), 'leads'));
  merchants.forEach((m) => bump(normCode(m.campaign), 'signups'));
  return [...out]
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.leads + b.signups - (a.leads + a.signups));
}

// ── Team ────────────────────────────────────────────────────────────────────

/** Pakistan time (UTC+5, no daylight saving): month boundaries the team sees. */
const PKT = 5 * 3_600_000;
export function monthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number);
  return {
    from: new Date(Date.UTC(y, m - 1, 1) - PKT),
    to: new Date(Date.UTC(y, m, 1) - PKT),
  };
}
export const currentMonth = (now = Date.now()) =>
  new Date(now + PKT).toISOString().slice(0, 7);
export const isMonth = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export interface RepInput {
  adminId: string;
  name: string;
}
export interface TargetRow {
  adminId: string;
  wonDeals: number | null;
  wonValuePKR: number | null;
  activities: number | null;
}
export interface LeaderRow {
  adminId: string;
  name: string;
  newLeads: number;
  activities: number;
  demos: number;
  won: number;
  wonValuePKR: number;
  lost: number;
  winRate: number | null;
  openLeads: number;
  openValuePKR: number;
  overdue: number;
  target: TargetRow | null;
  /** 0–100 per goal that has a target, null otherwise. */
  progress: {
    wonDeals: number | null;
    wonValuePKR: number | null;
    activities: number | null;
  };
}

export function leaderboard(
  reps: RepInput[],
  data: {
    newLeads: { ownerAdminId: string | null }[];
    activities: { adminId: string | null }[];
    demos: { ownerAdminId: string | null }[];
    closed: {
      ownerAdminId: string | null;
      stage: string;
      dealValuePKR: number | null;
    }[];
    open: {
      ownerAdminId: string | null;
      dealValuePKR: number | null;
      overdue: boolean;
    }[];
  },
  targets: TargetRow[],
): LeaderRow[] {
  const count = <T>(rows: T[], key: (r: T) => string | null, id: string) =>
    rows.filter((r) => key(r) === id).length;
  const pct = (v: number, t: number | null) =>
    t && t > 0 ? Math.min(100, Math.round((v / t) * 100)) : null;
  return reps
    .map((r) => {
      const won = data.closed.filter(
        (c) => c.ownerAdminId === r.adminId && c.stage === 'won',
      );
      const lost = count(
        data.closed,
        (c) => (c.stage === 'lost' ? c.ownerAdminId : null),
        r.adminId,
      );
      const open = data.open.filter((o) => o.ownerAdminId === r.adminId);
      const wonValuePKR = won.reduce((s, c) => s + (c.dealValuePKR ?? 0), 0);
      const activities = count(data.activities, (a) => a.adminId, r.adminId);
      const target = targets.find((t) => t.adminId === r.adminId) ?? null;
      return {
        adminId: r.adminId,
        name: r.name,
        newLeads: count(data.newLeads, (l) => l.ownerAdminId, r.adminId),
        activities,
        demos: count(data.demos, (d) => d.ownerAdminId, r.adminId),
        won: won.length,
        wonValuePKR,
        lost,
        winRate:
          won.length + lost > 0
            ? Math.round((won.length / (won.length + lost)) * 100)
            : null,
        openLeads: open.length,
        openValuePKR: open.reduce((s, o) => s + (o.dealValuePKR ?? 0), 0),
        overdue: open.filter((o) => o.overdue).length,
        target,
        progress: {
          wonDeals: pct(won.length, target?.wonDeals ?? null),
          wonValuePKR: pct(wonValuePKR, target?.wonValuePKR ?? null),
          activities: pct(activities, target?.activities ?? null),
        },
      };
    })
    .sort(
      (a, b) =>
        b.wonValuePKR - a.wonValuePKR ||
        b.won - a.won ||
        b.activities - a.activities ||
        a.name.localeCompare(b.name),
    );
}
