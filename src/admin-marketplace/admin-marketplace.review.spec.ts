/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { AdminMarketplaceService } from './admin-marketplace.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

// Seller trust: reviewing a verification never blocks or (re)activates a store
// on its own — only `verificationStatus` (+ the 'verified' badge) moves, except
// that approval still takes a store that was waiting on review live.

const meta = { adminId: 'admin-1' };

function build(store: any) {
  const storeModel = {
    findOne: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(store) }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const db: any = { repositories: { storeModel } };
  const activityLog: any = { log: jest.fn() };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const storeService: any = { getVerificationEvaluationForAdmin: jest.fn().mockResolvedValue({ canSubmit: true, missingFields: [], missingDocuments: [] }) };
  const sellerTrust: any = { recomputeStore: jest.fn().mockResolvedValue(null) };
  const service = new AdminMarketplaceService(db, activityLog, notifications, {} as any, storeService, sellerTrust);
  return { service, storeModel, notifications, sellerTrust, storeService };
}

const baseStore = { _id: 'store-1', name: 'Shop', sellerId: 'seller-1', status: 'active', verificationStatus: 'pending', badges: [] };

describe('AdminMarketplaceService review (seller trust)', () => {
  it('reject no longer blocks the store: status untouched, verified badge removed', async () => {
    const { service, storeModel, sellerTrust, notifications } = build({ ...baseStore, badges: ['verified'] });
    await service.rejectLead('store-1', 'NTN certificate is unreadable', meta);
    const update = storeModel.findByIdAndUpdate.mock.calls[0][1];
    expect(update.$set).not.toHaveProperty('status');
    expect(update.$set).toMatchObject({ verificationStatus: 'rejected', rejectionReason: 'NTN certificate is unreadable' });
    expect(update.$pull).toEqual({ badges: 'verified' });
    expect(update.$push['verification.history']).toMatchObject({ action: 'rejected', actorRole: 'admin' });
    expect(sellerTrust.recomputeStore).toHaveBeenCalledWith('store-1');
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: NOTIFICATION_TYPES.STORE_REJECTED }));
  });

  it('approve adds the verified badge and never reactivates a suspended store', async () => {
    const { service, storeModel } = build({ ...baseStore, status: 'suspended', verificationStatus: 'under_review' });
    await service.approveLead('store-1', meta);
    const update = storeModel.findByIdAndUpdate.mock.calls[0][1];
    expect(update.$set).not.toHaveProperty('status');
    expect(update.$set).toMatchObject({ verificationStatus: 'verified', marketplaceHidden: false });
    expect(update.$addToSet).toEqual({ badges: 'verified' });
  });

  it('approve still takes a pending (or legacy rejected) store live', async () => {
    for (const status of ['pending', 'rejected']) {
      const { service, storeModel } = build({ ...baseStore, status });
      await service.approveLead('store-1', meta);
      expect(storeModel.findByIdAndUpdate.mock.calls[0][1].$set.status).toBe('active');
    }
  });

  it('approve is blocked while requirements are missing', async () => {
    const { service, storeService, storeModel } = build({ ...baseStore });
    storeService.getVerificationEvaluationForAdmin.mockResolvedValue({ canSubmit: false, missingFields: ['taxId'], missingDocuments: [] });
    await expect(service.approveLead('store-1', meta)).rejects.toBeInstanceOf(BadRequestException);
    expect(storeModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('request-info moves pending/under_review to needs_info with the message, history and a seller notification', async () => {
    for (const verificationStatus of ['pending', 'under_review']) {
      const { service, storeModel, notifications } = build({ ...baseStore, verificationStatus });
      await service.requestInfo('store-1', 'Please upload the back of your CNIC', meta);
      const update = storeModel.findByIdAndUpdate.mock.calls[0][1];
      expect(update.$set).toMatchObject({ verificationStatus: 'needs_info', infoRequestMessage: 'Please upload the back of your CNIC' });
      expect(update.$set).not.toHaveProperty('status');
      expect(update.$push['verification.history']).toMatchObject({ action: 'info_requested', note: 'Please upload the back of your CNIC' });
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: NOTIFICATION_TYPES.VERIFICATION_INFO_REQUESTED, recipientId: 'seller-1' }));
    }
  });

  it('request-info is refused once the review is over', async () => {
    for (const verificationStatus of ['verified', 'rejected', 'needs_info', 'not_started']) {
      const { service } = build({ ...baseStore, verificationStatus });
      await expect(service.requestInfo('store-1', 'More please', meta)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
