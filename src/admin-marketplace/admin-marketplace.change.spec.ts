/* eslint-disable prettier/prettier */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminMarketplaceService } from './admin-marketplace.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

const meta = { adminId: 'admin-1' };
const doc = (type: string, id: string) => ({ type, publicId: `private/kyc-documents/seller/${id}`, resourceType: 'raw', fileName: `${type}.pdf`, uploadedAt: new Date() });
const pending = (over: any = {}) => ({ status: 'pending', fields: { businessAddress: 'New Street', authorizedContact: { phone: '0311' } }, documents: [doc('owner_id', 'new-id')], ...over });
const baseStore = (change: any) => ({
  _id: 'store-1', name: 'Shop', sellerId: 'seller-1', status: 'active', verificationStatus: 'verified', badges: ['verified'],
  verification: {
    businessAddress: 'Old Street', authorizedContact: { name: 'Ali', phone: '0300' },
    documents: [doc('owner_id', 'old-id'), doc('address_proof', 'addr')], change,
  },
});

function build(store: any, canSubmit = true) {
  const storeModel = {
    findOne: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(store) }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const db: any = { repositories: { storeModel } };
  const activityLog: any = { log: jest.fn() };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const uploads: any = { deletePrivateFile: jest.fn().mockResolvedValue('ok') };
  const storeService: any = { evaluateChangeGaps: jest.fn().mockResolvedValue({ ok: canSubmit, missingFields: canSubmit ? [] : ['businessAddress'], missingDocuments: [] }) };
  const sellerTrust: any = { recomputeStore: jest.fn().mockResolvedValue(null) };
  const service = new AdminMarketplaceService(db, activityLog, notifications, uploads, storeService, sellerTrust);
  return { service, storeModel, notifications, uploads, storeService, sellerTrust, activityLog };
}

describe('AdminMarketplaceService: change requests of verified sellers', () => {
  it('approve applies the new values and files, keeps the store verified with its badge, removes the replaced file and tells the seller', async () => {
    const { service, storeModel, uploads, notifications, sellerTrust } = build(baseStore(pending()));
    await service.approveChange('store-1', meta);
    const update = storeModel.findByIdAndUpdate.mock.calls[0][1];
    expect(update.$set).toMatchObject({
      'verification.businessAddress': 'New Street',
      'verification.authorizedContact': { name: 'Ali', phone: '0311' }, // merged key by key
      'verification.change.status': 'approved', 'verification.change.reviewedBy': 'admin-1',
    });
    expect(update.$set['verification.documents'].find((d: any) => d.type === 'owner_id').publicId).toBe('private/kyc-documents/seller/new-id');
    expect(update.$set['verification.documents'].find((d: any) => d.type === 'address_proof').publicId).toBe('private/kyc-documents/seller/addr');
    // the verified status and the badge are never touched
    expect(update.$set).not.toHaveProperty('verificationStatus');
    expect(update).not.toHaveProperty('$pull');
    expect(update.$push['verification.history']).toMatchObject({ action: 'change_approved', actorRole: 'admin' });
    expect(uploads.deletePrivateFile).toHaveBeenCalledWith('private/kyc-documents/seller/old-id', 'raw');
    expect(uploads.deletePrivateFile).not.toHaveBeenCalledWith('private/kyc-documents/seller/new-id', 'raw');
    expect(sellerTrust.recomputeStore).toHaveBeenCalledWith('store-1');
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: NOTIFICATION_TYPES.VERIFICATION_CHANGE_APPROVED, recipientId: 'seller-1' }));
  });

  it('approve is blocked when the details after the change would not meet the requirements, and nothing is saved', async () => {
    const { service, storeModel, uploads } = build(baseStore(pending()), false);
    const err: any = await service.approveChange('store-1', meta).catch((e: any) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().missingFields).toContain('businessAddress');
    expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(uploads.deletePrivateFile).not.toHaveBeenCalled();
  });

  it('reject leaves the live details as they are, deletes the new files and tells the seller why', async () => {
    const { service, storeModel, uploads, notifications } = build(baseStore(pending()));
    await service.rejectChange('store-1', 'The new address proof is unreadable', meta);
    const update = storeModel.findByIdAndUpdate.mock.calls[0][1];
    expect(Object.keys(update.$set).every((k) => k.startsWith('verification.change.'))).toBe(true);
    expect(update.$set).toMatchObject({ 'verification.change.status': 'rejected', 'verification.change.rejectionReason': 'The new address proof is unreadable' });
    expect(update.$push['verification.history']).toMatchObject({ action: 'change_rejected', note: 'The new address proof is unreadable' });
    expect(uploads.deletePrivateFile).toHaveBeenCalledTimes(1);
    expect(uploads.deletePrivateFile).toHaveBeenCalledWith('private/kyc-documents/seller/new-id', 'raw');
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: NOTIFICATION_TYPES.VERIFICATION_CHANGE_REJECTED }));
  });

  it('there must be a waiting request; a storage failure never undoes a decision', async () => {
    const none = build(baseStore(null));
    await expect(none.service.approveChange('store-1', meta)).rejects.toThrow('no change request');
    await expect(none.service.rejectChange('store-1', 'x', meta)).rejects.toThrow('no change request');
    const done = build(baseStore(pending({ status: 'approved' })));
    await expect(done.service.approveChange('store-1', meta)).rejects.toThrow('no change request');
    const missing = build(null);
    await expect(missing.service.approveChange('store-1', meta)).rejects.toBeInstanceOf(NotFoundException);

    const flaky = build(baseStore(pending()));
    flaky.uploads.deletePrivateFile.mockRejectedValue(new Error('storage down'));
    await expect(flaky.service.approveChange('store-1', meta)).resolves.toMatchObject({ success: true });
    await expect(flaky.service.rejectChange('store-1', 'x', meta)).resolves.toMatchObject({ success: true });
  });
});
