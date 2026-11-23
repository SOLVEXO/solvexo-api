/* eslint-disable prettier/prettier */
import { type PartnerTier, type ProgrammeSettings, eligibleTier } from './partner-programme.util';

/**
 * Channel Partner Programme B13: what is measured, "quality as well as volume": paying sellers, sellers still paying
 * after 3 months, time to first sale, complaints; plus the B6 pilot milestones (X paying sellers, Y stores live with
 * 5+ products, complaint rate under Z%) and B3 tier eligibility. Pure functions so the numbers are unit-tested.
 */

const DAY = 86_400_000;
export const RETENTION_DAYS = 90;

export interface SellerFacts {
  sellerId: string;
  /** When the partner got credit (signup or registration). */
  creditedAt: Date;
  /** First paid Solvexo plan invoice, or null. */
  firstPaidAt: Date | null;
  payingNow: boolean;
  liveStore: boolean;
}

export interface ScoreInput {
  now: Date;
  /** Agreement signing date (start of the pilot); null for partners set up before the programme. */
  startedAt: Date | null;
  sellers: SellerFacts[];
  registrations: { submittedAt: Date; status: string; demoHeld: boolean }[];
  complaints: Date[];
  certifiedStaff: number;
  tier: PartnerTier | null;
  earnedPKR: number;
}

export interface Scorecard {
  prospects: number;
  registrationsAccepted: number;
  demos: number;
  signups: number;
  liveStores: number;
  payingNow: number;
  everPaid: number;
  /** Of sellers whose first payment was 3+ months ago, the share still paying; null when there are none yet. */
  retention3mPercent: number | null;
  retentionBase: number;
  /** Days from the start of the agreement to the first paying seller; null until there is one. */
  daysToFirstSale: number | null;
  complaints: number;
  /** Complaints per paying seller, in %; null with no paying sellers. */
  complaintRatePercent: number | null;
  earnedPKR: number;
  eligibleTier: PartnerTier;
  tierStatus: 'meets' | 'eligible_for_higher' | 'below_requirement';
}

export function scorecard(i: ScoreInput, s: ProgrammeSettings): Scorecard {
  const paid = i.sellers.filter((x) => x.firstPaidAt);
  const matured = paid.filter((x) => i.now.getTime() - x.firstPaidAt!.getTime() >= RETENTION_DAYS * DAY);
  const retained = matured.filter((x) => x.payingNow).length;
  const firstSale = paid.map((x) => x.firstPaidAt!.getTime()).sort((a, b) => a - b)[0];
  const payingNow = i.sellers.filter((x) => x.payingNow).length;
  const retention = matured.length ? Math.round((retained / matured.length) * 1000) / 10 : null;
  const eligible = eligibleTier(s, payingNow, i.certifiedStaff, retention);
  const rank = (t: PartnerTier | null) => ['registered', 'silver', 'gold', 'regional'].indexOf(t ?? 'registered');
  const current = i.tier ?? 'registered';
  const tierStatus = current === 'regional'
    ? 'meets'
    : rank(eligible) > rank(current) ? 'eligible_for_higher' : rank(eligible) < rank(current) ? 'below_requirement' : 'meets';
  return {
    prospects: i.registrations.length,
    registrationsAccepted: i.registrations.filter((r) => ['accepted', 'won', 'expired'].includes(r.status)).length,
    demos: i.registrations.filter((r) => r.demoHeld).length,
    signups: i.sellers.length,
    liveStores: i.sellers.filter((x) => x.liveStore).length,
    payingNow,
    everPaid: paid.length,
    retention3mPercent: retention,
    retentionBase: matured.length,
    daysToFirstSale: firstSale !== undefined && i.startedAt ? Math.max(0, Math.round((firstSale - i.startedAt.getTime()) / DAY)) : null,
    complaints: i.complaints.length,
    complaintRatePercent: payingNow ? Math.round((i.complaints.length / payingNow) * 1000) / 10 : null,
    earnedPKR: i.earnedPKR,
    eligibleTier: eligible,
    tierStatus,
  };
}

export interface Milestone { key: 'paying' | 'live' | 'complaints'; label: string; target: number | null; actual: number | null; met: boolean | null }

/** B6 pilot milestones against the programme settings; `met` is null while management has not set the target. */
export function pilotMilestones(c: Scorecard, s: ProgrammeSettings): Milestone[] {
  return [
    { key: 'paying', label: 'Paying sellers (X)', target: s.pilotMinPayingSellers, actual: c.payingNow, met: s.pilotMinPayingSellers === null ? null : c.payingNow >= s.pilotMinPayingSellers },
    { key: 'live', label: 'Stores live with 5+ products (Y)', target: s.pilotMinLiveStores, actual: c.liveStores, met: s.pilotMinLiveStores === null ? null : c.liveStores >= s.pilotMinLiveStores },
    {
      key: 'complaints', label: 'Complaint rate under (Z %)', target: s.pilotMaxComplaintRatePercent, actual: c.complaintRatePercent,
      met: s.pilotMaxComplaintRatePercent === null ? null : (c.complaintRatePercent ?? 0) < s.pilotMaxComplaintRatePercent,
    },
  ];
}

/** Last `months` calendar months (UTC), oldest first: registrations, signups and first payments per month. */
export function monthlyTrend(i: Pick<ScoreInput, 'sellers' | 'registrations' | 'now'>, months = 6) {
  const keys: string[] = [];
  const d = new Date(Date.UTC(i.now.getUTCFullYear(), i.now.getUTCMonth(), 1));
  for (let k = months - 1; k >= 0; k--) keys.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
  const key = (x: Date) => x.toISOString().slice(0, 7);
  return keys.map((m) => ({
    month: m,
    registrations: i.registrations.filter((r) => key(r.submittedAt) === m).length,
    signups: i.sellers.filter((x) => key(x.creditedAt) === m).length,
    firstPayments: i.sellers.filter((x) => x.firstPaidAt && key(x.firstPaidAt) === m).length,
  }));
}
