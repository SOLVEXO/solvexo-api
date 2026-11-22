/* eslint-disable prettier/prettier */

/**
 * Solvexo Channel Partner Programme (v0.1, 21 Nov 2026): the rules the Super Admin onboarding follows, as pure
 * functions so they can be unit-tested. Values the programme marks "requires management approval" live in the
 * programme settings (PartnerProgrammeSettings) with the document's proposals as defaults; a value is only shown as
 * approved once a manager marks it so.
 */

/** B2: every agreement states one model. `referral` = Referral Agent (individuals). */
export const PARTNER_MODELS = ['referral', 'reseller', 'service', 'regional'] as const;
export type PartnerModel = (typeof PARTNER_MODELS)[number];
/** B2 / A3 #7: an Authorised Reseller either acts for Solvexo (agency) or buys and resells (resale). */
export const RESELLER_MODES = ['agency', 'resale'] as const;
/** B3 */
export const PARTNER_TIERS = ['registered', 'silver', 'gold', 'regional'] as const;
export type PartnerTier = (typeof PARTNER_TIERS)[number];
export const ENTITY_TYPES = ['business', 'individual'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Where a partner is in the programme.
 *  applied     → application received, waiting for Solvexo's first look
 *  documents   → first look passed: they have a login and upload their B12 documents
 *  review      → every required document uploaded, waiting for verification / references
 *  agreement   → vetted and approved, agreement being signed
 *  onboarding  → agreement signed: the 30-day onboarding (B12) runs, commission earns from here
 *  live        → onboarding complete
 *  rejected    → not taken forward (reason kept)
 * Partners created before the programme have no stage and count as `live`.
 */
export const PARTNER_STAGES = ['applied', 'documents', 'review', 'agreement', 'onboarding', 'live', 'rejected'] as const;
export type PartnerStage = (typeof PARTNER_STAGES)[number];

/** B12 documents. `agreement` is the signed agreement, uploaded by Solvexo. */
export const PARTNER_DOC_TYPES = [
  'company_registration', 'ntn', 'cnic', 'bank_account', 'partnership_proof', 'business_plan', 'reference_letter', 'agreement', 'other',
] as const;
export type PartnerDocType = (typeof PARTNER_DOC_TYPES)[number];

export const PARTNER_DOC_LABELS: Record<PartnerDocType, string> = {
  company_registration: 'Company registration (SECP certificate, or partnership / sole-proprietor registration)',
  ntn: 'NTN and sales-tax registration (FBR / PRA), where applicable',
  cnic: 'CNIC of the owners and the authorised signatory',
  bank_account: 'Bank account (or mobile wallet) in the partner’s own name',
  partnership_proof: 'Proof of any partnership you mention (e.g. Alibaba)',
  business_plan: 'Short business plan for the territory: segments, channels, team, first 90 days',
  reference_letter: 'Reference letter',
  agreement: 'Signed partner agreement',
  other: 'Other document',
};

/** Which documents must be verified before approval (B12). */
export function requiredDocs(entityType: EntityType, opts: { claimsPartnership?: boolean } = {}): PartnerDocType[] {
  if (entityType === 'individual') return ['cnic', 'bank_account'];
  return ['company_registration', 'cnic', 'bank_account', 'business_plan', ...(opts.claimsPartnership ? ['partnership_proof' as const] : [])];
}

export interface PartnerDocState {
  type: string;
  status: 'pending' | 'verified' | 'rejected';
}

export function docProgress(entityType: EntityType, docs: PartnerDocState[], opts: { claimsPartnership?: boolean } = {}) {
  const req = requiredDocs(entityType, opts);
  const latest = (t: string) => docs.filter((d) => d.type === t).at(-1);
  const missing = req.filter((t) => !latest(t) || latest(t)!.status === 'rejected');
  const verified = req.filter((t) => latest(t)?.status === 'verified');
  return { required: req, missing, verified, allUploaded: missing.length === 0, allVerified: verified.length === req.length };
}

// ── Programme settings ───────────────────────────────────────────────────────

export interface TierRule {
  key: PartnerTier;
  /** Paying sellers needed (B3: Silver 25+, Gold 100+). null = by invitation / no threshold. */
  minPayingSellers: number | null;
  /** Retention target in %, sellers still paying after 3 months. null = not set yet. */
  retentionTargetPercent: number | null;
  /** Certified salespeople needed (B3: Gold 2). */
  certifiedStaff: number;
  /** Commission on the commission base, in %. null = awaiting management approval. */
  commissionPercent: number | null;
  /** Demo stores issued (not for resale). */
  demoStores: number;
}

export interface ProgrammeSettings {
  tiers: TierRule[];
  pilotDays: number;
  termMonths: number;
  noticeDays: number;
  /** B7 */
  dealResponseWorkingDays: number;
  dealProtectionDays: number;
  /** B6 pilot milestones X, Y, Z. */
  pilotMinPayingSellers: number | null;
  pilotMinLiveStores: number | null;
  pilotMaxComplaintRatePercent: number | null;
  /** A2 / A3 #8 */
  activationBonusPKR: number | null;
  /** B4.5 */
  minPayoutPKR: number | null;
  statementDay: number;
  payoutDay: number;
  /** B4.1: card processing fee taken out of the commission base (e.g. 2.9 % + US$0.30). null = not set yet. */
  cardFeePercent: number | null;
  cardFeeFixedUSD: number | null;
  /** Set automatically when the card fee changes: only payments from this date use it (B4.10). */
  cardFeeFrom: string | null;
  /** B4.7: withholding tax deducted from payouts, in %, unless set per partner. null = none. */
  withholdingTaxPercent: number | null;
  /** B4.4: days' notice after which commission on a seller the partner stopped supporting ends. */
  supportNoticeDays: number;
  agreementVersion: string;
  /** A3 #9 */
  signingEntity: string | null;
  /** Keys of the values above that management has approved; everything else shows "awaiting approval". */
  approvedKeys: string[];
}

/** The programme document's proposals; null where it gives no number. */
export const DEFAULT_PROGRAMME_SETTINGS: ProgrammeSettings = {
  tiers: [
    { key: 'registered', minPayingSellers: 0, retentionTargetPercent: null, certifiedStaff: 0, commissionPercent: null, demoStores: 1 },
    { key: 'silver', minPayingSellers: 25, retentionTargetPercent: null, certifiedStaff: 0, commissionPercent: null, demoStores: 2 },
    { key: 'gold', minPayingSellers: 100, retentionTargetPercent: null, certifiedStaff: 2, commissionPercent: 40, demoStores: 5 },
    { key: 'regional', minPayingSellers: null, retentionTargetPercent: null, certifiedStaff: 2, commissionPercent: 40, demoStores: 10 },
  ],
  pilotDays: 90,
  termMonths: 12,
  noticeDays: 60,
  dealResponseWorkingDays: 2,
  dealProtectionDays: 90,
  pilotMinPayingSellers: null,
  pilotMinLiveStores: null,
  pilotMaxComplaintRatePercent: null,
  activationBonusPKR: null,
  minPayoutPKR: null,
  statementDay: 10,
  payoutDay: 15,
  cardFeePercent: null,
  cardFeeFixedUSD: null,
  cardFeeFrom: null,
  withholdingTaxPercent: null,
  supportNoticeDays: 60,
  agreementVersion: '0.1',
  signingEntity: null,
  approvedKeys: [],
};

export const SETTING_KEYS = [
  'tiers', 'pilotDays', 'termMonths', 'noticeDays', 'dealResponseWorkingDays', 'dealProtectionDays',
  'pilotMinPayingSellers', 'pilotMinLiveStores', 'pilotMaxComplaintRatePercent', 'activationBonusPKR', 'minPayoutPKR',
  'statementDay', 'payoutDay', 'agreementVersion', 'signingEntity', 'cardFeePercent', 'cardFeeFixedUSD', 'withholdingTaxPercent',
  'supportNoticeDays',
] as const;

const intOrNull = (v: unknown, min: number, max: number): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('must be a number');
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
};

/** Validates and merges an edit onto the current settings. Throws Error with a readable message. */
export function mergeSettings(cur: ProgrammeSettings, input: Partial<ProgrammeSettings>): ProgrammeSettings {
  const out: ProgrammeSettings = { ...cur, tiers: cur.tiers.map((t) => ({ ...t })) };
  const num = (k: keyof ProgrammeSettings, min: number, max: number, nullable: boolean) => {
    if (!(k in input)) return;
    const v = intOrNull(input[k], min, max);
    if (v === null && !nullable) throw new Error(`${k} is required`);
    (out as any)[k] = v;
  };
  num('pilotDays', 7, 365, false);
  num('termMonths', 1, 60, false);
  num('noticeDays', 0, 365, false);
  num('dealResponseWorkingDays', 1, 30, false);
  num('dealProtectionDays', 7, 365, false);
  num('pilotMinPayingSellers', 0, 100000, true);
  num('pilotMinLiveStores', 0, 100000, true);
  num('pilotMaxComplaintRatePercent', 0, 100, true);
  num('activationBonusPKR', 0, 10_000_000, true);
  num('minPayoutPKR', 0, 10_000_000, true);
  num('statementDay', 1, 28, false);
  num('payoutDay', 1, 28, false);
  num('cardFeePercent', 0, 20, true);
  num('cardFeeFixedUSD', 0, 10, true);
  num('withholdingTaxPercent', 0, 50, true);
  num('supportNoticeDays', 0, 365, false);
  // The card fee applies from the moment it changes, so commission already earned is never reduced (B4.10).
  if (out.cardFeePercent !== cur.cardFeePercent || out.cardFeeFixedUSD !== cur.cardFeeFixedUSD) out.cardFeeFrom = new Date().toISOString();
  if (out.payoutDay < out.statementDay) throw new Error('Payout day must be on or after the statement day');
  if ('agreementVersion' in input) {
    const v = String(input.agreementVersion ?? '').trim().slice(0, 20);
    if (!v) throw new Error('agreementVersion is required');
    out.agreementVersion = v;
  }
  if ('signingEntity' in input) out.signingEntity = String(input.signingEntity ?? '').trim().slice(0, 120) || null;
  if (input.tiers) {
    for (const t of input.tiers) {
      const cur2 = out.tiers.find((x) => x.key === t.key);
      if (!cur2) throw new Error(`Unknown tier ${String(t.key)}`);
      if ('minPayingSellers' in t) cur2.minPayingSellers = intOrNull(t.minPayingSellers, 0, 100000);
      if ('retentionTargetPercent' in t) cur2.retentionTargetPercent = intOrNull(t.retentionTargetPercent, 0, 100);
      if ('certifiedStaff' in t) cur2.certifiedStaff = intOrNull(t.certifiedStaff, 0, 100) ?? 0;
      if ('commissionPercent' in t) cur2.commissionPercent = intOrNull(t.commissionPercent, 0, 100);
      if ('demoStores' in t) cur2.demoStores = intOrNull(t.demoStores, 0, 100) ?? 0;
    }
  }
  if (input.approvedKeys) out.approvedKeys = [...new Set(input.approvedKeys.filter((k) => (SETTING_KEYS as readonly string[]).includes(k)))];
  return out;
}

// ── Agreement dates ──────────────────────────────────────────────────────────

const DAY = 86_400_000;
export function agreementDates(signedAt: Date, s: Pick<ProgrammeSettings, 'pilotDays' | 'termMonths' | 'noticeDays'>) {
  const startsAt = new Date(signedAt);
  const pilotEndsAt = new Date(startsAt.getTime() + s.pilotDays * DAY);
  const termEndsAt = new Date(startsAt);
  termEndsAt.setMonth(termEndsAt.getMonth() + s.termMonths);
  const noticeBy = new Date(termEndsAt.getTime() - s.noticeDays * DAY);
  return { startsAt, pilotEndsAt, termEndsAt, noticeBy };
}

// ── The onboarding checklist (B12) ───────────────────────────────────────────

export type ChecklistKey =
  | 'application' | 'documents_verified' | 'references_checked' | 'approved'
  | 'agreement_signed' | 'login_ready' | 'demo_stores' | 'brand_kit'
  | 'product_training' | 'honest_selling_training'
  | 'staff_certified' | 'first_prospects'
  | 'first_seller_live' | 'first_pipeline_review';

export interface ChecklistDef {
  key: ChecklistKey;
  label: string;
  /** 0 = vetting (before the agreement), 1..4 = onboarding week. */
  week: 0 | 1 | 2 | 3 | 4;
  /** true: ticked from real data; false: a manager ticks it. */
  auto: boolean;
  /** Only for business partners (a Referral Agent has no sales team to certify). */
  businessOnly?: boolean;
}

export const CHECKLIST: ChecklistDef[] = [
  { key: 'application', label: 'Application received', week: 0, auto: true },
  { key: 'documents_verified', label: 'Required documents verified', week: 0, auto: true },
  { key: 'references_checked', label: 'References and claimed partnerships checked', week: 0, auto: false, businessOnly: true },
  { key: 'approved', label: 'Approved by Solvexo', week: 0, auto: true },
  { key: 'agreement_signed', label: 'Agreement signed', week: 1, auto: true },
  { key: 'login_ready', label: 'Partner login activated', week: 1, auto: true },
  { key: 'demo_stores', label: 'Demo store(s) issued', week: 1, auto: true },
  { key: 'brand_kit', label: 'Brand kit and approved claims shared', week: 1, auto: false },
  { key: 'product_training', label: 'Product training (store builder, POS, inventory, plans)', week: 2, auto: false },
  { key: 'honest_selling_training', label: 'Honest-selling training (B9)', week: 2, auto: false },
  { key: 'staff_certified', label: 'Salespeople certified (live demo to Solvexo)', week: 3, auto: true, businessOnly: true },
  { key: 'first_prospects', label: 'First prospects registered', week: 3, auto: true },
  { key: 'first_seller_live', label: 'First seller live (store active, 5+ products)', week: 4, auto: true },
  { key: 'first_pipeline_review', label: 'First weekly pipeline review', week: 4, auto: false },
];

export interface ChecklistFacts {
  entityType: EntityType;
  stage: PartnerStage;
  appliedAt: Date | null;
  approvedAt: Date | null;
  docsAllVerified: boolean;
  agreementSignedAt: Date | null;
  loginActivatedAt: Date | null;
  demoStores: number;
  certifiedStaff: number;
  /** Prospects registered (deal registrations) or sellers who signed up through the partner. */
  prospects: number;
  firstProspectAt: Date | null;
  liveSellers: number;
  firstLiveAt: Date | null;
  /** Manager ticks: key → when. */
  manual: Partial<Record<ChecklistKey, Date | null>>;
}

export interface ChecklistItem {
  key: ChecklistKey;
  label: string;
  week: number;
  auto: boolean;
  done: boolean;
  doneAt: Date | null;
  dueAt: Date | null;
  overdue: boolean;
}

/**
 * The checklist as it stands now. Week n items are due n weeks after the agreement was signed (B12's first 30 days);
 * vetting items have no due date. A manual tick always counts; an automatic item is done when the data says so.
 */
export function buildChecklist(f: ChecklistFacts, now = new Date()): ChecklistItem[] {
  const autoDone = (k: ChecklistKey): [boolean, Date | null] => {
    switch (k) {
      case 'application': return [!!f.appliedAt || f.stage !== 'applied', f.appliedAt];
      case 'documents_verified': return [f.docsAllVerified, null];
      case 'approved': return [!!f.approvedAt, f.approvedAt];
      case 'agreement_signed': return [!!f.agreementSignedAt, f.agreementSignedAt];
      case 'login_ready': return [!!f.loginActivatedAt, f.loginActivatedAt];
      case 'demo_stores': return [f.demoStores > 0, null];
      case 'staff_certified': return [f.certifiedStaff > 0, null];
      case 'first_prospects': return [f.prospects > 0, f.firstProspectAt];
      case 'first_seller_live': return [f.liveSellers > 0, f.firstLiveAt];
      default: return [false, null];
    }
  };
  return CHECKLIST.filter((d) => !d.businessOnly || f.entityType === 'business').map((d) => {
    const manualAt = f.manual[d.key] ?? null;
    const [aDone, aAt] = d.auto ? autoDone(d.key) : [false, null];
    const done = !!manualAt || aDone;
    const dueAt = d.week > 0 && f.agreementSignedAt ? new Date(f.agreementSignedAt.getTime() + d.week * 7 * DAY) : null;
    return {
      key: d.key, label: d.label, week: d.week, auto: d.auto, done,
      doneAt: manualAt ?? aAt ?? null, dueAt, overdue: !done && !!dueAt && dueAt.getTime() < now.getTime(),
    };
  });
}

/**
 * The stage implied by what has happened. A rejection is final until a manager reopens it; `live` once every
 * onboarding item is done.
 */
export function nextStage(cur: PartnerStage, f: { firstLookPassed: boolean; docsAllUploaded: boolean; approved: boolean; agreementSigned: boolean; onboardingComplete: boolean }): PartnerStage {
  if (cur === 'rejected') return 'rejected';
  if (f.agreementSigned) return f.onboardingComplete ? 'live' : 'onboarding';
  if (f.approved) return 'agreement';
  if (!f.firstLookPassed) return 'applied';
  return f.docsAllUploaded ? 'review' : 'documents';
}

/** B3: the highest tier whose seller and staff thresholds a partner meets (Regional is by invitation only). */
export function eligibleTier(s: ProgrammeSettings, payingSellers: number, certifiedStaff: number, retentionPercent: number | null): PartnerTier {
  let best: PartnerTier = 'registered';
  for (const t of s.tiers) {
    if (t.key === 'regional' || t.minPayingSellers === null) continue;
    const retentionOk = t.retentionTargetPercent === null || (retentionPercent !== null && retentionPercent >= t.retentionTargetPercent);
    if (payingSellers >= t.minPayingSellers && certifiedStaff >= t.certifiedStaff && retentionOk) best = t.key;
  }
  return best;
}
