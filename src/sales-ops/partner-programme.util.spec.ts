/* eslint-disable prettier/prettier */
import {
  DEFAULT_PROGRAMME_SETTINGS, agreementDates, buildChecklist, docProgress, eligibleTier, mergeSettings, nextStage, requiredDocs,
  type ChecklistFacts,
} from './partner-programme.util';

const facts = (o: Partial<ChecklistFacts> = {}): ChecklistFacts => ({
  entityType: 'business', stage: 'onboarding', appliedAt: new Date('2026-11-01'), approvedAt: new Date('2026-11-05'), docsAllVerified: true,
  agreementSignedAt: new Date('2026-11-10'), loginActivatedAt: null, demoStores: 0, certifiedStaff: 0, prospects: 0, firstProspectAt: null,
  liveSellers: 0, firstLiveAt: null, manual: {}, ...o,
});

describe('partner programme rules', () => {
  it('asks businesses for the B12 company documents and individuals for CNIC + bank only', () => {
    expect(requiredDocs('business')).toEqual(['company_registration', 'cnic', 'bank_account', 'business_plan']);
    expect(requiredDocs('business', { claimsPartnership: true })).toContain('partnership_proof');
    expect(requiredDocs('individual')).toEqual(['cnic', 'bank_account']);
  });

  it('treats a rejected document as missing until a new copy is uploaded, and uses the newest copy', () => {
    const p = docProgress('individual', [{ type: 'cnic', status: 'verified' }, { type: 'bank_account', status: 'rejected' }]);
    expect(p.missing).toEqual(['bank_account']);
    expect(p.allVerified).toBe(false);
    const p2 = docProgress('individual', [{ type: 'cnic', status: 'verified' }, { type: 'bank_account', status: 'rejected' }, { type: 'bank_account', status: 'pending' }]);
    expect(p2.allUploaded).toBe(true);
    expect(p2.allVerified).toBe(false);
  });

  it('moves through the stages from the facts and never leaves rejected', () => {
    const f = { firstLookPassed: false, docsAllUploaded: false, approved: false, agreementSigned: false, onboardingComplete: false };
    expect(nextStage('applied', f)).toBe('applied');
    expect(nextStage('applied', { ...f, firstLookPassed: true })).toBe('documents');
    expect(nextStage('documents', { ...f, firstLookPassed: true, docsAllUploaded: true })).toBe('review');
    expect(nextStage('review', { ...f, firstLookPassed: true, docsAllUploaded: true, approved: true })).toBe('agreement');
    expect(nextStage('agreement', { ...f, approved: true, agreementSigned: true })).toBe('onboarding');
    expect(nextStage('onboarding', { ...f, approved: true, agreementSigned: true, onboardingComplete: true })).toBe('live');
    expect(nextStage('rejected', { ...f, approved: true, agreementSigned: true })).toBe('rejected');
  });

  it('dates the pilot, term and renewal notice from the signing date', () => {
    const d = agreementDates(new Date('2026-12-01T00:00:00Z'), DEFAULT_PROGRAMME_SETTINGS);
    expect(d.pilotEndsAt.toISOString().slice(0, 10)).toBe('2027-03-01');
    expect(d.termEndsAt.toISOString().slice(0, 10)).toBe('2027-12-01');
    expect(d.noticeBy.toISOString().slice(0, 10)).toBe('2027-10-02');
  });

  it('ticks automatic items from real data, keeps manual ticks, and flags overdue weeks', () => {
    const now = new Date('2026-11-30');
    const list = buildChecklist(facts({ demoStores: 1, prospects: 2, firstProspectAt: new Date('2026-11-20'), manual: { brand_kit: new Date('2026-11-11') } }), now);
    const by = (k: string) => list.find((i) => i.key === k)!;
    expect(by('demo_stores').done).toBe(true);
    expect(by('brand_kit').done).toBe(true);
    expect(by('first_prospects')).toMatchObject({ done: true, week: 3 });
    expect(by('product_training')).toMatchObject({ done: false, overdue: true }); // week 2 → due 24 Nov
    expect(by('first_seller_live')).toMatchObject({ done: false, overdue: false }); // week 4 → due 8 Dec
    expect(by('agreement_signed').done).toBe(true);
  });

  it('leaves business-only items off an individual referral agent’s checklist', () => {
    const keys = buildChecklist(facts({ entityType: 'individual' })).map((i) => i.key);
    expect(keys).not.toContain('staff_certified');
    expect(keys).not.toContain('references_checked');
  });

  it('validates settings edits and keeps undecided values empty', () => {
    const s = mergeSettings(DEFAULT_PROGRAMME_SETTINGS, { pilotMinPayingSellers: 20, tiers: [{ key: 'silver', commissionPercent: 30 } as any], approvedKeys: ['pilotDays', 'nonsense'] });
    expect(s.pilotMinPayingSellers).toBe(20);
    expect(s.tiers.find((t) => t.key === 'silver')!.commissionPercent).toBe(30);
    expect(s.tiers.find((t) => t.key === 'registered')!.commissionPercent).toBeNull();
    expect(s.approvedKeys).toEqual(['pilotDays']);
    expect(() => mergeSettings(DEFAULT_PROGRAMME_SETTINGS, { statementDay: 20, payoutDay: 15 })).toThrow('Payout day');
    expect(() => mergeSettings(DEFAULT_PROGRAMME_SETTINGS, { pilotDays: null as any })).toThrow('pilotDays');
  });

  it('works out the tier a partner qualifies for (Regional only by invitation)', () => {
    const s = DEFAULT_PROGRAMME_SETTINGS;
    expect(eligibleTier(s, 10, 0, null)).toBe('registered');
    expect(eligibleTier(s, 30, 0, null)).toBe('silver');
    expect(eligibleTier(s, 120, 1, null)).toBe('silver'); // Gold needs 2 certified salespeople
    expect(eligibleTier(s, 120, 2, null)).toBe('gold');
  });
});
