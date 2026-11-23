/* eslint-disable prettier/prettier */
import { AdminMarketplaceService } from './admin-marketplace.service';
import { AdminSellerTrustService } from '../admin-seller-trust/admin-seller-trust.service';

// Every time an admin opens a seller's verification page they are handed expiring links to private ID / tax
// documents. That access must leave an audit-log row (who, when, which store, which document types).

const meta = { adminId: 'admin-1', ip: '1.2.3.4', userAgent: 'jest' };
const STORE_ID = '64b000000000000000000001';
const store = { _id: STORE_ID, name: 'Ali Traders', sellerId: 'seller-1', status: 'active', verificationStatus: 'pending', country: 'PK', verification: {} };
const doc = (type: string, state: string) => ({ type, state, required: true, fileName: 'a.pdf', uploadedAt: null, viewUrl: state === 'uploaded' ? 'https://signed' : null });
const evaluationWith = (documents: any[]) => ({
  requirements: { verificationLevel: 'basic' }, missingFields: [], missingDocuments: [], documents, canSubmit: true,
});

function marketplace(documents: any[]) {
  const storeModel = { findOne: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(store) }) };
  const sellerModel = { findById: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Ali', email: 'a@b.com' }) }) };
  const db: any = { repositories: { storeModel, sellerModel, categoryModel: {} } };
  const activityLog: any = { log: jest.fn() };
  const storeService: any = {
    getVerificationEvaluationForAdmin: jest.fn().mockResolvedValue(evaluationWith(documents)),
    shapeBusinessProfile: jest.fn().mockReturnValue({}),
    shapeVerificationChange: jest.fn().mockReturnValue(null),
  };
  const service = new AdminMarketplaceService(db, activityLog, {} as any, {} as any, storeService, {} as any);
  return { service, activityLog };
}

function trust(documents: any[]) {
  const lean = (v: any) => ({ lean: jest.fn().mockResolvedValue(v) });
  const storeModel = { findOne: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue(lean(store)) }) };
  const sellerModel = { findById: jest.fn().mockReturnValue(lean({ name: 'Ali', email: 'a@b.com' })) };
  const db: any = { repositories: { storeModel, sellerModel, categoryModel: {}, adminModel: {} } };
  const activityLog: any = { log: jest.fn() };
  const storeService: any = {
    getVerificationEvaluationForAdmin: jest.fn().mockResolvedValue(evaluationWith(documents)),
    shapeBusinessProfile: jest.fn().mockReturnValue({}),
    shapeVerificationChange: jest.fn().mockReturnValue(null),
  };
  const sellerTrust: any = { getSettings: jest.fn().mockResolvedValue({ enforcementStartedAt: null, graceDays: 30 }) };
  const service = new AdminSellerTrustService(db, activityLog, {} as any, {} as any, storeService, {} as any, sellerTrust);
  return { service, activityLog };
}

describe('admin verification review: document access is audit-logged', () => {
  const docs = [doc('owner_id', 'uploaded'), doc('tax_registration', 'uploaded'), doc('address_proof', 'missing')];

  it('Leads detail logs who opened which uploaded document types (not the missing ones)', async () => {
    const { service, activityLog } = marketplace(docs);
    await service.getLeadDetail(STORE_ID, meta);
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'verification_documents_viewed', actorId: 'admin-1', actorRole: 'admin', targetId: STORE_ID, targetType: 'store',
      ip: '1.2.3.4', userAgent: 'jest', metadata: { documentTypes: ['owner_id', 'tax_registration'] },
    }));
  });

  it('Seller Trust detail logs the same way', async () => {
    const { service, activityLog } = trust(docs);
    await service.getStoreDetail(STORE_ID, new Date(), meta);
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'verification_documents_viewed', actorId: 'admin-1', targetId: STORE_ID, metadata: { documentTypes: ['owner_id', 'tax_registration'] },
    }));
  });

  it('logs nothing when the seller has uploaded no document', async () => {
    const a = marketplace([doc('owner_id', 'missing')]);
    await a.service.getLeadDetail(STORE_ID, meta);
    expect(a.activityLog.log).not.toHaveBeenCalled();
    const b = trust([doc('owner_id', 'missing')]);
    await b.service.getStoreDetail(STORE_ID, new Date(), meta);
    expect(b.activityLog.log).not.toHaveBeenCalled();
  });

  it('a failing audit write never blocks the review page', async () => {
    const a = marketplace(docs);
    a.activityLog.log.mockImplementation(() => { throw new Error('log down'); });
    await expect(a.service.getLeadDetail(STORE_ID, meta)).resolves.toMatchObject({ success: true });
    const b = trust(docs);
    b.activityLog.log.mockImplementation(() => { throw new Error('log down'); });
    await expect(b.service.getStoreDetail(STORE_ID, new Date(), meta)).resolves.toMatchObject({ success: true });
  });
});
