import { getVerificationRequirements, QUESTIONNAIRE_REQUIRED_FIELDS } from './verification-requirements.config';

describe('getVerificationRequirements', () => {
  it('PK individual: NTN + CNIC required, STRN optional, NTN certificate required', () => {
    const r = getVerificationRequirements('PK', 'individual', 'basic');
    expect(r.requiredFields).toEqual(expect.arrayContaining(['taxId', 'cnicNumber', 'legalBusinessName']));
    expect(r.requiredFields).not.toContain('registrationNumber');
    expect(r.optionalFields).toEqual(['strn']);
    expect(r.requiredDocuments).toEqual(['owner_id', 'tax_registration', 'address_proof']);
  });

  it('PK company/partnership: also registration number + business registration', () => {
    for (const bt of ['company', 'partnership'] as const) {
      const r = getVerificationRequirements('PK', bt, 'business');
      expect(r.requiredFields).toEqual(expect.arrayContaining(['taxId', 'cnicNumber', 'registrationNumber']));
      expect(r.requiredDocuments).toEqual(['owner_id', 'tax_registration', 'address_proof', 'business_registration']);
    }
  });

  it('GCC: trade licence + VAT TRN, no NTN/CNIC; VAT certificate optional', () => {
    for (const c of ['AE', 'SA', 'QA', 'KW', 'BH', 'OM']) {
      const r = getVerificationRequirements(c, 'individual', 'basic');
      expect(r.requiredFields).toEqual(expect.arrayContaining(['registrationNumber', 'taxId']));
      expect(r.requiredFields).not.toContain('cnicNumber');
      expect(r.requiredDocuments).toEqual(['owner_id', 'business_registration', 'address_proof']);
      expect(r.optionalDocuments).toContain('tax_registration');
    }
  });

  it('other countries keep the level-based rules', () => {
    const basic = getVerificationRequirements('US', 'individual', 'basic');
    expect(basic.requiredFields).not.toContain('taxId');
    expect(basic.requiredDocuments).toEqual(['owner_id', 'address_proof']);
    const business = getVerificationRequirements('US', 'company', 'business');
    expect(business.requiredFields).toEqual(expect.arrayContaining(['registrationNumber', 'taxId']));
    expect(business.requiredDocuments).toEqual(['owner_id', 'address_proof', 'business_registration', 'tax_registration']);
  });

  it('requires the questionnaire everywhere (but not channels/couriers/regulated categories)', () => {
    const r = getVerificationRequirements('US', null, 'basic');
    expect(r.requiredFields).toEqual(expect.arrayContaining(QUESTIONNAIRE_REQUIRED_FIELDS));
    expect(r.requiredFields).not.toContain('businessProfile.otherChannels');
    expect(r.requiredFields).not.toContain('businessProfile.couriers');
    expect(r.requiredFields).not.toContain('businessProfile.regulatedCategories');
  });

  it('branded goods require a brand authorization; regulated categories require a product licence', () => {
    const none = getVerificationRequirements('PK', 'individual', 'basic', { sellsBrandedGoods: false, regulatedCategories: [] });
    expect(none.requiredDocuments).not.toContain('brand_authorization');
    expect(none.requiredDocuments).not.toContain('product_licence');
    expect(none.optionalDocuments).toEqual(expect.arrayContaining(['brand_authorization', 'product_licence']));

    const both = getVerificationRequirements('PK', 'individual', 'basic', { sellsBrandedGoods: true, regulatedCategories: ['cosmetics'] });
    expect(both.requiredDocuments).toEqual(expect.arrayContaining(['brand_authorization', 'product_licence']));
    expect(both.optionalDocuments).not.toContain('brand_authorization');
    expect(both.optionalDocuments).not.toContain('product_licence');
  });
});

describe('Pakistan STRN rule', () => {
  it('is optional by default and when the seller says they are not sales-tax registered', () => {
    for (const profile of [undefined, null, {}, { salesTaxRegistered: null }, { salesTaxRegistered: false }]) {
      const r = getVerificationRequirements('PK', 'individual', 'basic', profile as any);
      expect(r.requiredFields).not.toContain('strn');
      expect(r.optionalFields).toEqual(['strn']);
    }
  });

  it('becomes required when the seller says they are sales-tax registered', () => {
    const r = getVerificationRequirements('PK', 'individual', 'basic', { salesTaxRegistered: true });
    expect(r.requiredFields).toContain('strn');
    expect(r.optionalFields).not.toContain('strn');
    expect(r.requiredFields.filter((f) => f === 'strn')).toHaveLength(1);
  });

  it('becomes required for every Pakistani seller when the admin switch is on', () => {
    for (const bt of ['individual', 'company', 'partnership'] as const) {
      const r = getVerificationRequirements('PK', bt, bt === 'individual' ? 'basic' : 'business', { salesTaxRegistered: false }, { requireStrnForPk: true });
      expect(r.requiredFields).toContain('strn');
      expect(r.optionalFields).not.toContain('strn');
    }
    expect(getVerificationRequirements('PK', 'individual', 'basic', null, { requireStrnForPk: false }).requiredFields).not.toContain('strn');
  });

  it('never changes the documents or any other country', () => {
    const base = getVerificationRequirements('PK', 'individual', 'basic');
    const on = getVerificationRequirements('PK', 'individual', 'basic', { salesTaxRegistered: true }, { requireStrnForPk: true });
    expect(on.requiredDocuments).toEqual(base.requiredDocuments);
    for (const country of ['AE', 'US', 'GB']) {
      const a = getVerificationRequirements(country, 'individual', 'basic');
      const b = getVerificationRequirements(country, 'individual', 'basic', { salesTaxRegistered: true }, { requireStrnForPk: true });
      expect(b.requiredFields).toEqual(a.requiredFields);
      expect(b.requiredFields).not.toContain('strn');
    }
  });
});

describe('Director / partner of a company', () => {
  it('a company or partnership must name the person behind it, in every country', () => {
    for (const country of ['PK', 'AE', 'US']) {
      for (const bt of ['company', 'partnership'] as const) {
        const r = getVerificationRequirements(country, bt, 'business');
        expect(r.requiredFields).toEqual(expect.arrayContaining(['director.name', 'director.idNumber']));
        expect(r.requiredFields.filter((f) => f === 'director.name')).toHaveLength(1);
      }
    }
  });

  it('an individual seller is never asked for one', () => {
    for (const country of ['PK', 'AE', 'US']) {
      const r = getVerificationRequirements(country, 'individual', 'basic');
      expect(r.requiredFields).not.toContain('director.name');
      expect(r.requiredFields).not.toContain('director.idNumber');
    }
    expect(getVerificationRequirements('PK', null, 'basic').requiredFields).not.toContain('director.name');
  });
});
