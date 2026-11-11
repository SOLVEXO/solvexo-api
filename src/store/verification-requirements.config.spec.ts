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
