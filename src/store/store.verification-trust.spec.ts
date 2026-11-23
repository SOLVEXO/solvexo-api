/* eslint-disable prettier/prettier */
jest.mock('../database/databaseservice', () => ({ DatabaseService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { StoreService } from './store.service';
import { VERIFICATION_DECLARATION_VERSION } from './verification-requirements.config';

function build(store: any) {
  const storeModel = {
    findOne: jest.fn().mockImplementation(() => {
      const q: any = Promise.resolve(store);
      q.select = jest.fn().mockReturnValue(q);
      return q;
    }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockReturnValue({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) }),
  };
  const service: any = Object.create(StoreService.prototype);
  service.databaseService = { repositories: { storeModel } };
  service.sellerTrust = { recomputeStore: jest.fn().mockResolvedValue(null), deadlineFor: jest.fn().mockResolvedValue({ dueAt: null, limited: false, enforcementStarted: false }) };
  service.uploadService = { generateSignedUrl: jest.fn().mockReturnValue('https://signed'), generateExpiringPrivateUrl: jest.fn().mockReturnValue('https://signed') };
  service.notificationsService = { notifyAdmins: jest.fn().mockResolvedValue(0) };
  service.marketingService = { getActiveCampaignsForStores: jest.fn().mockResolvedValue(new Map()) };
  return { service, storeModel };
}

const baseStore = (over: any = {}) => ({ _id: 's1', sellerId: 'seller', name: 'Shop', country: 'PK', businessType: 'individual', verificationStatus: 'not_started', verification: {}, ...over });

describe('StoreService seller verification (trust)', () => {
  it('rejects a malformed NTN / CNIC for a PK store with a clear 400', async () => {
    const { service, storeModel } = build(baseStore());
    await expect(service.updateVerification('seller', 's1', { taxId: '12345' })).rejects.toThrow(/NTN must be 7 digits/);
    await expect(service.updateVerification('seller', 's1', { cnicNumber: '123' })).rejects.toThrow(/CNIC must be 13 digits/);
    expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('normalizes NTN + CNIC and merges the questionnaire, then recomputes trust', async () => {
    const { service, storeModel } = build(baseStore({ verification: { businessProfile: { sourcing: 'reseller' } } }));
    await service.updateVerification('seller', 's1', {
      taxId: '12345678', cnicNumber: '1234512345671', strn: ' 17-00-1234-567-89 ',
      businessProfile: { sellsBrandedGoods: true, regulatedCategories: ['food', 'food'], otherChannels: ['https://daraz.pk/shop/x'] },
    });
    const set = storeModel.findByIdAndUpdate.mock.calls[0][1].$set;
    expect(set.verification).toMatchObject({ taxId: '1234567-8', cnicNumber: '12345-1234567-1', strn: '17-00-1234-567-89' });
    expect(set.verification.businessProfile).toEqual({ sourcing: 'reseller', sellsBrandedGoods: true, regulatedCategories: ['food'], otherChannels: ['https://daraz.pk/shop/x'] });
    expect(service.sellerTrust.recomputeStore).toHaveBeenCalledWith('s1');
  });

  it('does not apply PK formats to other countries', async () => {
    const { service, storeModel } = build(baseStore({ country: 'AE' }));
    await service.updateVerification('seller', 's1', { taxId: '100123456700003', cnicNumber: '784-1990-1234567-1' });
    expect(storeModel.findByIdAndUpdate.mock.calls[0][1].$set.verification).toMatchObject({ taxId: '100123456700003', cnicNumber: '784-1990-1234567-1' });
  });

  it('validates the questionnaire values', async () => {
    const { service } = build(baseStore());
    await expect(service.updateVerification('seller', 's1', { businessProfile: { sourcing: 'pirate' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateVerification('seller', 's1', { businessProfile: { regulatedCategories: ['weapons'] } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateVerification('seller', 's1', { businessProfile: { otherChannels: ['a', 'b', 'c', 'd', 'e', 'f'] } })).rejects.toThrow(/at most 5/);
    await expect(service.updateVerification('seller', 's1', { businessProfile: { otherChannels: ['x'.repeat(201)] } })).rejects.toThrow(/200 characters/);
    await expect(service.updateVerification('seller', 's1', { businessProfile: { bankAccountInOwnName: 'yes' } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is editable in needs_info, locked while pending', async () => {
    const editable = build(baseStore({ verificationStatus: 'needs_info' }));
    await expect(editable.service.updateVerification('seller', 's1', { legalBusinessName: 'X' })).resolves.toMatchObject({ success: true });
    const locked = build(baseStore({ verificationStatus: 'pending' }));
    await expect(locked.service.updateVerification('seller', 's1', { legalBusinessName: 'X' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resubmitting from needs_info goes back to pending and clears the admin question', async () => {
    const doc = (type: string) => ({ type, publicId: `p-${type}`, resourceType: 'raw', fileName: `${type}.pdf`, uploadedAt: new Date() });
    const { service, storeModel } = build(baseStore({
      verificationStatus: 'needs_info',
      infoRequestMessage: 'Upload your NTN certificate',
      verification: {
        legalBusinessName: 'Shop', businessAddress: 'Lahore', idDocumentType: 'cnic', taxId: '1234567-8', cnicNumber: '12345-1234567-1',
        authorizedContact: { name: 'A', email: 'a@x.pk', phone: '0300' },
        businessProfile: { sourcing: 'reseller', sellsBrandedGoods: false, regulatedCategories: [], premises: 'shop', yearsSelling: '1_3y', dispatchTime: 'same_day', returnPolicy: '7_day_returns', monthlyOrders: 'lt_50', bankAccountInOwnName: true },
        documents: [doc('owner_id'), doc('tax_registration'), doc('address_proof')],
      },
    }));
    await service.submitVerification('seller', 's1', { accepted: true, ip: '1.2.3.4', userAgent: 'jest' });
    const update = storeModel.findByIdAndUpdate.mock.calls[0][1];
    expect(update.$set).toMatchObject({ verificationStatus: 'pending', infoRequestMessage: null });
    expect(update.$set.verificationSubmittedAt).toBeInstanceOf(Date);
    expect(update.$push['verification.history']).toMatchObject({ action: 'resubmitted' });
    // The declaration is recorded with its wording version, time and where it was accepted from.
    expect(update.$set['verification.consent']).toMatchObject({ version: VERIFICATION_DECLARATION_VERSION, ip: '1.2.3.4', userAgent: 'jest' });
    expect(update.$set['verification.consent'].acceptedAt).toBeInstanceOf(Date);
  });

  it('refuses to submit without the declaration — nothing is saved', async () => {
    const doc = (type: string) => ({ type, publicId: `p-${type}`, resourceType: 'raw', fileName: `${type}.pdf`, uploadedAt: new Date() });
    const { service, storeModel } = build(baseStore({
      verificationStatus: 'not_started',
      verification: {
        legalBusinessName: 'Shop', businessAddress: 'Lahore', idDocumentType: 'cnic', taxId: '1234567-8', cnicNumber: '12345-1234567-1',
        authorizedContact: { name: 'A', email: 'a@x.pk', phone: '0300' },
        businessProfile: { sourcing: 'reseller', sellsBrandedGoods: false, regulatedCategories: [], premises: 'shop', yearsSelling: '1_3y', dispatchTime: 'same_day', returnPolicy: '7_day_returns', monthlyOrders: 'lt_50', bankAccountInOwnName: true },
        documents: [doc('owner_id'), doc('tax_registration'), doc('address_proof')],
      },
    }));
    await expect(service.submitVerification('seller', 's1')).rejects.toThrow('confirm the declaration');
    await expect(service.submitVerification('seller', 's1', { accepted: false })).rejects.toThrow('confirm the declaration');
    expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('submit lists the missing NTN/CNIC/questionnaire for a PK seller', async () => {
    const { service } = build(baseStore({ verification: { legalBusinessName: 'Shop' } }));
    try {
      await service.submitVerification('seller', 's1');
      throw new Error('should fail');
    } catch (e: any) {
      const body = e.getResponse();
      expect(body.missingFields).toEqual(expect.arrayContaining(['taxId', 'cnicNumber', 'businessProfile.sourcing']));
      expect(body.missingDocuments).toEqual(expect.arrayContaining(['tax_registration']));
    }
  });

  it('GET verification exposes requirements, questionnaire, deadline and the admin question — never risk', async () => {
    const { service } = build(baseStore({ verificationStatus: 'needs_info', infoRequestMessage: 'Need NTN', riskLevel: 'high' }));
    const res = await service.getVerification('seller', 's1');
    expect(res.data).toMatchObject({ infoRequestMessage: 'Need NTN', deadline: { dueAt: null, limited: false, enforcementStarted: false } });
    expect(res.data.requirements.requiredFields).toContain('taxId');
    expect(res.data.businessProfile).toHaveProperty('sourcing', null);
    expect(res.data).not.toHaveProperty('riskLevel');
  });

  it('marketplace store browse leaves out trust-limited stores', async () => {
    const { service, storeModel } = build(baseStore());
    await service.listPublicStores({});
    expect(storeModel.countDocuments.mock.calls[0][0]).toMatchObject({ status: 'active', marketplaceHidden: { $ne: true } });
  });
});

describe('StoreService seller verification: STRN rule', () => {
  const filled = {
    legalBusinessName: 'Shop', businessAddress: 'Lahore', idDocumentType: 'cnic', taxId: '1234567-8', cnicNumber: '12345-1234567-1',
    authorizedContact: { name: 'A', email: 'a@x.pk', phone: '0300' },
    businessProfile: { sourcing: 'reseller', sellsBrandedGoods: false, regulatedCategories: [], premises: 'shop', yearsSelling: '1_3y', dispatchTime: 'same_day', returnPolicy: '7_day_returns', monthlyOrders: 'lt_50', bankAccountInOwnName: true } as any,
    documents: ['owner_id', 'tax_registration', 'address_proof'].map((type) => ({ type, publicId: `p-${type}`, resourceType: 'raw', fileName: `${type}.pdf`, uploadedAt: new Date() })),
  };
  const missing = async (store: any, settings?: any) => {
    const { service } = build(store);
    if (settings) service.sellerTrust.getSettings = jest.fn().mockResolvedValue(settings);
    return (await service.getVerification('seller', 's1')).data;
  };

  it('a complete PK submission without an STRN can be submitted by default', async () => {
    const d = await missing(baseStore({ verification: filled }));
    expect(d.missingFields).not.toContain('strn');
    expect(d.canSubmit).toBe(true);
  });

  it('answering "yes, sales-tax registered" makes the STRN required and the answer is saved and returned', async () => {
    const d = await missing(baseStore({ verification: { ...filled, businessProfile: { ...filled.businessProfile, salesTaxRegistered: true } } }));
    expect(d.missingFields).toContain('strn');
    expect(d.canSubmit).toBe(false);
    expect(d.businessProfile.salesTaxRegistered).toBe(true);
    const ok = await missing(baseStore({ verification: { ...filled, strn: '17-00-1234-567-89', businessProfile: { ...filled.businessProfile, salesTaxRegistered: true } } }));
    expect(ok.canSubmit).toBe(true);
  });

  it('the admin switch makes the STRN required for every PK seller, and getVerification reports it', async () => {
    const d = await missing(baseStore({ verification: filled }), { enforcementStartedAt: null, graceDays: 30, requireStrnForPk: true });
    expect(d.missingFields).toContain('strn');
    expect(d.requirements.requiredFields).toContain('strn');
    expect(d.canSubmit).toBe(false);
  });

  it('a settings failure falls back to the default rule instead of breaking the page', async () => {
    const { service } = build(baseStore({ verification: filled }));
    service.sellerTrust.getSettings = jest.fn().mockRejectedValue(new Error('db down'));
    const d = (await service.getVerification('seller', 's1')).data;
    expect(d.canSubmit).toBe(true);
  });

  it('the questionnaire accepts salesTaxRegistered true/false/null and rejects anything else', async () => {
    const { service, storeModel } = build(baseStore());
    await service.updateVerification('seller', 's1', { businessProfile: { salesTaxRegistered: true } });
    expect(storeModel.findByIdAndUpdate.mock.calls[0][1].$set.verification.businessProfile).toEqual({ salesTaxRegistered: true });
    await expect(service.updateVerification('seller', 's1', { businessProfile: { salesTaxRegistered: 'yes' } })).rejects.toBeInstanceOf(BadRequestException);
  });
});
