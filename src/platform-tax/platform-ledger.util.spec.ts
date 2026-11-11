/* eslint-disable prettier/prettier */
import { addonChargeFacts, feeBillFacts, planInvoiceFacts, taxRecordFacts } from './platform-ledger.util';
import { determine, EntityView, RuleView } from './platform-tax-determination.service';
import { projectEntity, projectLegacyRules } from './platform-entity.service';

const PAID = new Date('2026-11-01T10:00:00Z');
const pkEntity: EntityView = { entityKey: 'solvexo-platform', country: 'PK', registrations: [{ country: 'PK', type: 'NTN', number: '1234567', authority: 'PK_FBR' }] };
const verifiedRule = (country: string, rate = 18): RuleView => ({ country, supplyType: 'saas_subscription', treatment: 'taxable', ratePercent: rate, state: 'verified' });
const legacyRule = (country: string, rate = 18): RuleView => ({ country, supplyType: 'saas_subscription', treatment: 'taxable', ratePercent: rate, state: 'legacy_confirmed' });

describe('ledger facts: golden tests per source (chargedTax always equals what the source recorded)', () => {
  it('plan invoice with recorded tax', () => {
    const f = planInvoiceFacts({ _id: 'p1', storeId: 's1', sellerId: 'u1', status: 'paid', paidAt: PAID, amountUSD: 29.58, subtotalUSD: 29, taxAmountUSD: 0.58, taxRatePercent: 2, taxLabel: 'Sales Tax', taxCountry: 'PK', refundedAmountUSD: 0 })!;
    expect(f.taxKnown).toBe(true);
    expect(f.netUSD).toBe(29);
    expect(f.chargedTaxUSD).toBe(0.58);
    expect(f.totalUSD).toBe(29.58);
    expect(f.taxLines).toEqual([{ label: 'Sales Tax', ratePercent: 2, amountUSD: 0.58, country: 'PK' }]);
    expect(f.sourceId).toBe('p1');
  });
  it('plan invoice with subtotal but no tax = known zero, no tax lines', () => {
    const f = planInvoiceFacts({ _id: 'p2', storeId: 's1', status: 'paid', paidAt: PAID, amountUSD: 29, subtotalUSD: 29, taxAmountUSD: 0 })!;
    expect(f.taxKnown).toBe(true);
    expect(f.chargedTaxUSD).toBe(0);
    expect(f.taxLines).toEqual([]);
  });
  it('plan invoice from before tax was recorded (subtotal null) is UNKNOWN, tax null not 0, lines null', () => {
    const f = planInvoiceFacts({ _id: 'p3', storeId: 's1', status: 'paid', paidAt: PAID, amountUSD: 29, subtotalUSD: null, taxAmountUSD: 0 })!;
    expect(f.taxKnown).toBe(false);
    expect(f.chargedTaxUSD).toBeNull();
    expect(f.netUSD).toBeNull();
    expect(f.taxLines).toBeNull();
    expect(f.totalUSD).toBe(29);
  });
  it('unpaid / failed plan invoices produce no row; refunded keeps its refund figure', () => {
    expect(planInvoiceFacts({ _id: 'x', storeId: 's', status: 'failed', paidAt: null, amountUSD: 1 })).toBeNull();
    expect(planInvoiceFacts({ _id: 'x', storeId: 's', status: 'pending', paidAt: PAID, amountUSD: 1 })).toBeNull();
    const r = planInvoiceFacts({ _id: 'r', storeId: 's', status: 'partially_refunded', paidAt: PAID, amountUSD: 29, subtotalUSD: 29, taxAmountUSD: 0, refundedAmountUSD: 10 })!;
    expect(r.refundedUSD).toBe(10);
    expect(r.status).toBe('partially_refunded');
  });
  it('add-on: one row per charge, tax known only when the charge stored taxUSD', () => {
    const rows = addonChargeFacts({ _id: 'a1', storeId: 's1', sellerId: 'u1', charges: [
      { amountUSD: 10, taxUSD: 0.2, chargedAt: PAID }, { amountUSD: 10, chargedAt: PAID }, { amountUSD: 10, taxUSD: 0, chargedAt: PAID },
    ] });
    expect(rows.map((r) => r.sourceId)).toEqual(['a1:0', 'a1:1', 'a1:2']);
    expect(rows[0]).toMatchObject({ taxKnown: true, netUSD: 10, chargedTaxUSD: 0.2, totalUSD: 10.2 });
    expect(rows[1]).toMatchObject({ taxKnown: false, chargedTaxUSD: null, totalUSD: null, taxLines: null });
    expect(rows[2]).toMatchObject({ taxKnown: true, chargedTaxUSD: 0, taxLines: [] });
  });
  it('fee bill: only paid bills, tax known only when the stored bill has taxAmountUSD', () => {
    expect(feeBillFacts({ _id: 'b0', storeId: 's', status: 'awaiting_payment', paidAt: PAID, amountUSD: 5 })).toBeNull();
    const withTax = feeBillFacts({ _id: 'b1', storeId: 's1', status: 'paid', paidAt: PAID, amountUSD: 5, taxAmountUSD: 0.1 })!;
    expect(withTax).toMatchObject({ taxKnown: true, netUSD: 5, chargedTaxUSD: 0.1, totalUSD: 5.1 });
    const old = feeBillFacts({ _id: 'b2', storeId: 's1', status: 'paid', paidAt: PAID, amountUSD: 5 })!;
    expect(old).toMatchObject({ taxKnown: false, chargedTaxUSD: null, totalUSD: null, taxLines: null });
  });
  it('one-off charges (pos plan, promotion, store app): tax known, net/total not', () => {
    for (const source of ['pos_plan', 'promotion', 'store_app']) {
      const f = taxRecordFacts({ source, refId: `ref-${source}`, storeId: 's1', taxAmountUSD: 1.5, collectedAt: PAID })!;
      expect(f.sourceType).toBe(source);
      expect(f.sourceId).toBe(`ref-${source}`);
      expect(f).toMatchObject({ taxKnown: true, netUSD: null, totalUSD: null, chargedTaxUSD: 1.5 });
    }
    expect(taxRecordFacts({ source: 'weird', refId: 'x', storeId: 's', taxAmountUSD: 1, collectedAt: PAID })).toBeNull();
  });
});

describe('determination (comparison only)', () => {
  const base = { supplyType: 'saas_subscription', taxKnown: true, chargedTaxUSD: 0 as number | null, taxLines: [] as any };

  it('AC1.8 UK customer, no verified rule: not eligible, reason rule_unverified, wording never says "foreign"', () => {
    const r = determine({ ...base, entity: pkEntity, customerCountry: 'GB', rules: [legacyRule('GB', 20)] });
    expect(r.routing.eligible).toBe(false);
    expect(r.routing.reason).toBe('rule_unverified');
    expect(JSON.stringify(r)).not.toMatch(/foreign(?!_tax_without_registration)/i);
  });
  it('AC1.8 the same UK invoice becomes eligible once a VERIFIED rule exists (nationality is not a reason)', () => {
    const r = determine({ ...base, entity: pkEntity, customerCountry: 'GB', rules: [verifiedRule('GB', 20)] });
    expect(r.routing).toEqual({ authority: 'PK_FBR', eligible: true, reason: 'ok' });
    expect(r.determination).toEqual({ treatment: 'taxable', ratePercent: 20, ruleState: 'verified' });
  });
  it('a Pakistani customer with only a legacy-confirmed rate is also held: legacy is never "verified"', () => {
    const r = determine({ ...base, entity: pkEntity, customerCountry: 'PK', rules: [legacyRule('PK', 18)] });
    expect(r.routing.eligible).toBe(false);
    expect(r.routing.reason).toBe('rule_unverified');
  });
  it('no rule at all for that country is held too, treatment unknown (never treated as zero)', () => {
    const r = determine({ ...base, entity: pkEntity, customerCountry: 'DE', rules: [] });
    expect(r.routing.reason).toBe('rule_unverified');
    expect(r.determination.treatment).toBe('unknown');
  });
  it('unknown tax is never eligible, even with a verified rule', () => {
    const r = determine({ ...base, entity: pkEntity, customerCountry: 'PK', rules: [verifiedRule('PK')], taxKnown: false, chargedTaxUSD: null, taxLines: null });
    expect(r.routing).toMatchObject({ eligible: false, reason: 'tax_unknown' });
  });
  it('no registration (no NTN/STRN) means no routing', () => {
    const r = determine({ ...base, entity: { ...pkEntity, registrations: [] }, customerCountry: 'PK', rules: [verifiedRule('PK')] });
    expect(r.routing).toMatchObject({ authority: null, eligible: false, reason: 'no_registration' });
  });
  it('a verified rule whose treatment is still unknown stays held', () => {
    const r = determine({ ...base, entity: pkEntity, customerCountry: 'PK', rules: [{ ...verifiedRule('PK'), treatment: 'unknown', ratePercent: null }] });
    expect(r.routing.reason).toBe('rule_unknown_treatment');
  });
  it('a registration under an authority with no adapter is held (adapter_missing)', () => {
    const e: EntityView = { entityKey: 'solvexo-platform', country: 'PK', registrations: [{ country: 'PK', type: 'STRN', number: '9', authority: 'PK_SRB' }] };
    const r = determine({ ...base, entity: e, customerCountry: 'PK', rules: [verifiedRule('PK')] });
    expect(r.routing).toMatchObject({ authority: 'PK_SRB', eligible: false, reason: 'adapter_missing' });
  });
  it('AC1.9 a Pakistani entity that charged UK tax without a UK registration gets the warning (and nothing else changes)', () => {
    const r = determine({ ...base, entity: pkEntity, customerCountry: 'GB', rules: [legacyRule('GB', 20)], chargedTaxUSD: 5.8, taxLines: [{ label: 'VAT', ratePercent: 20, amountUSD: 5.8, country: 'GB' }] });
    expect(r.warnings).toContain('foreign_tax_without_registration');
  });
  it('no warning when the tax country is one the entity is registered in', () => {
    const r = determine({ ...base, entity: pkEntity, customerCountry: 'PK', rules: [legacyRule('PK')], chargedTaxUSD: 5.2, taxLines: [{ label: 'Sales Tax', ratePercent: 18, amountUSD: 5.2, country: 'PK' }] });
    expect(r.warnings).not.toContain('foreign_tax_without_registration');
  });
  it('warns when the charged rate differs from the rule, and when the customer country is unknown', () => {
    const d = determine({ ...base, entity: pkEntity, customerCountry: 'PK', rules: [verifiedRule('PK', 18)], chargedTaxUSD: 1, taxLines: [{ label: 'x', ratePercent: 2, amountUSD: 1, country: 'PK' }] });
    expect(d.warnings).toContain('charged_tax_differs_from_rule');
    const u = determine({ ...base, entity: pkEntity, customerCountry: null, rules: [] });
    expect(u.warnings).toContain('customer_country_unknown');
  });
});

describe('entity projection (reads Admin settings, never changes them)', () => {
  it('FBR settings with NTN and STRN become a Pakistani entity with two PK_FBR registrations', () => {
    const e = projectEntity({ authority: 'FBR', ntn: '1234567', strn: '99-00', legalName: 'Solvexo' });
    expect(e.country).toBe('PK');
    expect(e.registrations.map((r) => [r.type, r.authority])).toEqual([['NTN', 'PK_FBR'], ['STRN', 'PK_FBR']]);
  });
  it('authority OTHER says nothing about the country; empty numbers register nothing', () => {
    expect(projectEntity({ authority: 'OTHER', ntn: '1' })).toMatchObject({ country: null, registrations: [] });
    expect(projectEntity({ authority: 'FBR', ntn: '', strn: '' }).registrations).toEqual([]);
    expect(projectEntity(null).registrations).toEqual([]);
  });
  it('legacy rates: confirmed -> legacy_confirmed, draft -> unverified, a 0% rate is NOT a zero-rating decision', () => {
    const rules = projectLegacyRules({ rates: [
      { country: 'pk', ratePercent: 18, status: 'confirmed' }, { country: 'GB', ratePercent: 20, status: 'draft' }, { country: 'AE', ratePercent: 0, status: 'confirmed' },
    ] });
    expect(rules[0]).toMatchObject({ country: 'PK', state: 'legacy_confirmed', treatment: 'taxable', ratePercent: 18 });
    expect(rules[1]).toMatchObject({ country: 'GB', state: 'unverified' });
    expect(rules[2]).toMatchObject({ treatment: 'unknown', ratePercent: null });
  });
});
