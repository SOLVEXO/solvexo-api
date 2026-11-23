/* eslint-disable prettier/prettier */
jest.mock('../database/databaseservice', () => ({ DatabaseService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { StoreService } from './store.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

const doc = (type: string, id: string) => ({ type, publicId: `private/kyc-documents/seller/${id}`, resourceType: 'raw', fileName: `${type}.pdf`, uploadedAt: new Date() });
const verified = (over: any = {}) => ({
  legalBusinessName: 'Ali Traders', businessAddress: 'Old Street, Lahore', idDocumentType: 'cnic', taxId: '1234567-8', cnicNumber: '12345-1234567-1',
  authorizedContact: { name: 'Ali', email: 'ali@x.pk', phone: '0300 1234567' },
  businessProfile: { sourcing: 'reseller', sellsBrandedGoods: false, regulatedCategories: [], premises: 'shop', yearsSelling: '1_3y', dispatchTime: 'same_day', returnPolicy: '7_day_returns', monthlyOrders: 'lt_50', bankAccountInOwnName: true },
  documents: [doc('owner_id', 'old-id'), doc('tax_registration', 'old-ntn'), doc('address_proof', 'old-addr')],
  ...over,
});
const store = (over: any = {}, v: any = {}) => ({ _id: 's1', sellerId: 'seller', name: 'Ali Traders', country: 'PK', businessType: 'individual', verificationStatus: 'verified', verification: verified(v), ...over });

function build(s: any) {
  const storeModel = {
    findOne: jest.fn().mockImplementation(() => { const q: any = Promise.resolve(s); q.select = jest.fn().mockReturnValue(q); return q; }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const service: any = Object.create(StoreService.prototype);
  service.databaseService = { repositories: { storeModel } };
  service.sellerTrust = { recomputeStore: jest.fn().mockResolvedValue(null), deadlineFor: jest.fn().mockResolvedValue({ dueAt: null, limited: false, enforcementStarted: false }) };
  service.uploadService = { generateExpiringPrivateUrl: jest.fn().mockReturnValue('https://signed'), deletePrivateFile: jest.fn().mockResolvedValue('ok') };
  service.notificationsService = { notifyAdmins: jest.fn().mockResolvedValue(0) };
  return { service, storeModel };
}
const ok = { accepted: true, ip: '1.2.3.4', userAgent: 'jest' };

describe('StoreService: change request of a verified seller', () => {
  it('only a verified store can send one: others edit directly', async () => {
    const { service } = build(store({ verificationStatus: 'pending' }));
    await expect(service.requestVerificationChange('seller', 's1', { businessAddress: 'X' }, ok)).rejects.toThrow('edit them directly');
  });

  it('needs the declaration', async () => {
    const { service, storeModel } = build(store());
    await expect(service.requestVerificationChange('seller', 's1', { businessAddress: 'New' })).rejects.toThrow('confirm the declaration');
    await expect(service.requestVerificationChange('seller', 's1', { businessAddress: 'New' }, { accepted: false })).rejects.toThrow('confirm the declaration');
    expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('saves ONLY what differs, leaves the live details alone, records history + the declaration and alerts the admins', async () => {
    const { service, storeModel } = build(store());
    await service.requestVerificationChange('seller', 's1', {
      businessAddress: ' New Street, Karachi ', legalBusinessName: 'Ali Traders', taxId: '12345678',
      authorizedContact: { name: 'Ali', phone: '0311 7654321' }, note: 'We moved',
    }, ok);
    const update = storeModel.findByIdAndUpdate.mock.calls[0][1];
    // nothing live is touched
    expect(Object.keys(update.$set)).toEqual(['verification.change']);
    const change = update.$set['verification.change'];
    expect(change).toMatchObject({ status: 'pending', sellerNote: 'We moved', fields: { businessAddress: 'New Street, Karachi', authorizedContact: { phone: '0311 7654321' } } });
    expect(change.fields).not.toHaveProperty('legalBusinessName'); // same value: not part of the request
    expect(change.fields).not.toHaveProperty('taxId'); // 12345678 normalises to the live 1234567-8
    expect(change.consent).toMatchObject({ ip: '1.2.3.4' });
    expect(update.$push['verification.history']).toMatchObject({ action: 'change_requested', actorRole: 'seller', note: 'Business address, Contact phone' });
    expect(service.notificationsService.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({ type: NOTIFICATION_TYPES.ADMIN_VERIFICATION_CHANGE_REQUESTED }));
  });

  it('formats are checked like a normal save', async () => {
    const { service, storeModel } = build(store());
    await expect(service.requestVerificationChange('seller', 's1', { taxId: '123' }, ok)).rejects.toThrow(/NTN must be 7 digits/);
    await expect(service.requestVerificationChange('seller', 's1', { cnicNumber: '123' }, ok)).rejects.toThrow(/CNIC must be 13 digits/);
    expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects "nothing changed" and a change that would blank a required detail', async () => {
    const { service } = build(store());
    await expect(service.requestVerificationChange('seller', 's1', { businessAddress: 'Old Street, Lahore' }, ok)).rejects.toThrow('not changed anything');
    await expect(service.requestVerificationChange('seller', 's1', { businessAddress: '   ' }, ok)).rejects.toThrow(BadRequestException);
    const err: any = await service.requestVerificationChange('seller', 's1', { businessAddress: '' }, ok).catch((e: any) => e);
    expect(err.getResponse().missingFields).toContain('businessAddress');
  });

  it('new files must be this seller own uploads, and are kept one per type', async () => {
    const { service, storeModel } = build(store());
    const bad = { type: 'owner_id', publicId: 'private/kyc-documents/someone-else/x', resourceType: 'raw', fileName: 'id.pdf' };
    await expect(service.requestVerificationChange('seller', 's1', { documents: [bad] }, ok)).rejects.toThrow('Invalid document');
    const a = { type: 'owner_id', publicId: 'private/kyc-documents/seller/new1', resourceType: 'raw', fileName: 'a.pdf' };
    const b = { type: 'owner_id', publicId: 'private/kyc-documents/seller/new2', resourceType: 'raw', fileName: 'b.pdf' };
    await service.requestVerificationChange('seller', 's1', { documents: [a, b] }, ok);
    const saved = storeModel.findByIdAndUpdate.mock.calls[0][1].$set['verification.change'];
    expect(saved.documents).toHaveLength(1);
    expect(saved.documents[0].publicId).toBe('private/kyc-documents/seller/new2');
  });

  it('refuses a second request while one is waiting', async () => {
    const { service } = build(store({}, { change: { status: 'pending', fields: { businessAddress: 'X' }, documents: [] } }));
    await expect(service.requestVerificationChange('seller', 's1', { businessAddress: 'Y' }, ok)).rejects.toThrow('already have a change request');
  });

  it('cancel marks it cancelled and deletes the files uploaded for it; nothing to cancel gives a 400', async () => {
    const waiting = { status: 'pending', fields: { businessAddress: 'X' }, documents: [doc('owner_id', 'new-id')] };
    const { service, storeModel } = build(store({}, { change: waiting }));
    await service.cancelVerificationChange('seller', 's1');
    expect(storeModel.findByIdAndUpdate.mock.calls[0][1].$set).toMatchObject({ 'verification.change.status': 'cancelled' });
    expect(service.uploadService.deletePrivateFile).toHaveBeenCalledWith('private/kyc-documents/seller/new-id', 'raw');
    const none = build(store());
    await expect(none.service.cancelVerificationChange('seller', 's1')).rejects.toThrow('no change request');
  });

  it('GET verification returns the change (no links for the seller); a cancelled one is hidden', async () => {
    const pending = { status: 'pending', fields: { businessAddress: 'X' }, documents: [doc('owner_id', 'n')], requestedAt: new Date(), consent: { acceptedAt: new Date(), version: 'v' } };
    const a = (await build(store({}, { change: pending })).service.getVerification('seller', 's1')).data;
    expect(a.change).toMatchObject({ status: 'pending', fields: { businessAddress: 'X' } });
    expect(a.change.documents[0]).toMatchObject({ type: 'owner_id', viewUrl: null });
    const c = (await build(store({}, { change: { ...pending, status: 'cancelled' } })).service.getVerification('seller', 's1')).data;
    expect(c.change).toBeNull();
  });
});

describe('StoreService: director of a company', () => {
  const company = (v: any = {}, over: any = {}) => store({ businessType: 'company', verificationLevel: 'business', ...over }, {
    registrationNumber: 'SECP-123', documents: [...verified().documents, doc('business_registration', 'reg')], director: { name: 'Bilal Khan', idNumber: '12345-1234567-1' }, ...v,
  });

  it('a draft save normalises a PK director CNIC and rejects a bad one', async () => {
    const { service, storeModel } = build(company({}, { verificationStatus: 'not_started' }));
    await service.updateVerification('seller', 's1', { director: { name: ' Bilal Khan ', idNumber: '1234512345671' } });
    expect(storeModel.findByIdAndUpdate.mock.calls[0][1].$set.verification.director).toEqual({ name: 'Bilal Khan', idNumber: '12345-1234567-1' });
    await expect(service.updateVerification('seller', 's1', { director: { idNumber: '123' } })).rejects.toThrow(/Director ID: CNIC must be 13 digits/);
  });

  it('GET verification returns the director and lists a missing one as required for a company', async () => {
    const ok = (await build(company()).service.getVerification('seller', 's1')).data;
    expect(ok.director).toEqual({ name: 'Bilal Khan', idNumber: '12345-1234567-1' });
    expect(ok.missingFields).not.toContain('director.name');
    const missing = (await build(company({ director: undefined })).service.getVerification('seller', 's1')).data;
    expect(missing.missingFields).toEqual(expect.arrayContaining(['director.name', 'director.idNumber']));
    expect(missing.canSubmit).toBe(false);
  });

  it('a verified company can ask to change its director (format checked) and only the changed key is kept', async () => {
    const { service, storeModel } = build(company());
    await expect(service.requestVerificationChange('seller', 's1', { director: { idNumber: '12' } }, ok)).rejects.toThrow('Director ID');
    await service.requestVerificationChange('seller', 's1', { director: { name: 'Bilal Khan', idNumber: '5432176543219' } }, ok);
    const change = storeModel.findByIdAndUpdate.mock.calls[0][1].$set['verification.change'];
    expect(change.fields).toEqual({ director: { idNumber: '54321-7654321-9' } });
  });

  it('a company verified BEFORE the director was required can still change its address (the old gap does not block)', async () => {
    const { service, storeModel } = build(company({ director: undefined }));
    await service.requestVerificationChange('seller', 's1', { businessAddress: 'New Street' }, ok);
    expect(storeModel.findByIdAndUpdate.mock.calls[0][1].$set['verification.change'].fields).toEqual({ businessAddress: 'New Street' });
  });

  it('but a change that creates a NEW gap is still refused (blanking a director that exists)', async () => {
    const { service } = build(company());
    const err: any = await service.requestVerificationChange('seller', 's1', { director: { name: '' } }, ok).catch((e: any) => e);
    expect(err.getResponse().missingFields).toContain('director.name');
  });
});
