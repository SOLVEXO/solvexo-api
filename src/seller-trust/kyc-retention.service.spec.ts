/* eslint-disable prettier/prettier */
import { KycRetentionService } from './kyc-retention.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-12-01T05:20:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const yearsAgo = (n: number) => { const d = new Date(now); d.setUTCFullYear(d.getUTCFullYear() - n); return d; };
const file = (publicId: string, uploadedAt: Date | null = null, type = 'owner_id') => ({ type, publicId, resourceType: 'raw', fileName: `${publicId}.pdf`, uploadedAt });

/** Two queries per run: the first (closed stores) then the second (open stores' drafts). */
function build(closed: any[], drafts: any[], settings: any = { enforcementStartedAt: null, graceDays: 30 }) {
  const chain = (rows: any[]) => ({ select: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(rows) });
  const storeModel: any = { find: jest.fn().mockReturnValueOnce(chain(closed)).mockReturnValueOnce(chain(drafts)), updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
  const db: any = { repositories: { storeModel } };
  const sellerTrust: any = { getSettings: jest.fn().mockResolvedValue(settings) };
  const upload: any = { deletePrivateFile: jest.fn().mockResolvedValue('ok') };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const service = new KycRetentionService(db, sellerTrust, upload, notifications);
  return { service, storeModel, upload, notifications };
}

const closedStore = (over: any = {}, v: any = {}) => ({
  _id: 'c1', name: 'Old Shop', sellerId: 'seller-1', verificationClosedAt: yearsAgo(7),
  verification: { submitted: true, documents: [file('private/kyc-documents/seller-1/id'), file('private/kyc-documents/seller-1/ntn')], ...v }, ...over,
});
const draftStore = (over: any = {}, v: any = {}) => ({
  _id: 'd1', name: 'New Shop', sellerId: 'seller-2', verificationStatus: 'not_started', reviewedAt: null,
  verification: { documents: [file('private/kyc-documents/seller-2/old', daysAgo(100)), file('private/kyc-documents/seller-2/fresh', daysAgo(5), 'address_proof')], ...v }, ...over,
});

describe('KycRetentionService: closed stores', () => {
  it('after the retention period: deletes every file, then erases the identity data and marks it purged', async () => {
    const { service, storeModel, upload } = build([closedStore()], []);
    const res = await service.run(now);
    expect(res).toMatchObject({ closedErased: 1, filesDeleted: 2, failed: 0 });
    expect(upload.deletePrivateFile).toHaveBeenCalledWith('private/kyc-documents/seller-1/id', 'raw');
    expect(upload.deletePrivateFile).toHaveBeenCalledWith('private/kyc-documents/seller-1/ntn', 'raw');
    const [filter, update] = storeModel.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'c1' });
    expect(update.$set).toMatchObject({
      'verification.documents': [], 'verification.cnicNumber': null, 'verification.taxId': null, 'verification.strn': null,
      'verification.legalBusinessName': null, 'verification.businessAddress': null, 'verification.authorizedContact': {}, 'verification.change': null,
    });
    expect(update.$set['verification.purgedAt']).toEqual(now);
    expect(update.$push['verification.history']).toMatchObject({ action: 'retention_erased' });
  });

  it('also deletes the files waiting in a change request', async () => {
    const { service, upload } = build([closedStore({}, { change: { status: 'pending', documents: [file('private/kyc-documents/seller-1/new')] } })], []);
    await service.run(now);
    expect(upload.deletePrivateFile).toHaveBeenCalledWith('private/kyc-documents/seller-1/new', 'raw');
  });

  it('a closed store that went through verification is NOT erased before the period ends', async () => {
    const { service, storeModel, upload } = build([closedStore({ verificationClosedAt: yearsAgo(5) })], []);
    expect((await service.run(now)).closedErased).toBe(0);
    expect(upload.deletePrivateFile).not.toHaveBeenCalled();
    expect(storeModel.updateOne).not.toHaveBeenCalled();
  });

  it('a closed store that never submitted is erased at once', async () => {
    const { service } = build([closedStore({ verificationClosedAt: daysAgo(1) }, { submitted: false })], []);
    expect((await service.run(now)).closedErased).toBe(1);
  });

  it('asks only for closed, not-yet-erased stores that are due, using the configured years', async () => {
    const { service, storeModel } = build([], [], { enforcementStartedAt: null, graceDays: 30, kycRetentionYears: 3 });
    await service.run(now);
    const filter = storeModel.find.mock.calls[0][0];
    expect(filter).toMatchObject({ isDelete: true, 'verification.purgedAt': null });
    expect(filter.$or).toEqual(expect.arrayContaining([{ 'verification.submitted': { $ne: true } }]));
    const byClosing = filter.$or.find((c: any) => c.verificationClosedAt?.$lte);
    expect(byClosing.verificationClosedAt.$lte.toISOString()).toBe('2023-12-01T05:20:00.000Z');
  });

  it('if the storage refuses a file, nothing is cleared and it is retried next time', async () => {
    const { service, storeModel, upload } = build([closedStore()], []);
    upload.deletePrivateFile.mockResolvedValueOnce('ok').mockRejectedValueOnce(new Error('Cloudinary down'));
    const res = await service.run(now);
    expect(res).toMatchObject({ closedErased: 0, failed: 1, filesDeleted: 1 });
    expect(storeModel.updateOne).not.toHaveBeenCalled();
  });
});

describe('KycRetentionService: drafts of open stores', () => {
  it('deletes only the expired files, removes just those from the record, writes history and tells the seller', async () => {
    const { service, storeModel, upload, notifications } = build([], [draftStore()]);
    const res = await service.run(now);
    expect(res).toMatchObject({ draftsExpired: 1, filesDeleted: 1, failed: 0 });
    expect(upload.deletePrivateFile).toHaveBeenCalledTimes(1);
    expect(upload.deletePrivateFile).toHaveBeenCalledWith('private/kyc-documents/seller-2/old', 'raw');
    const update = storeModel.updateOne.mock.calls[0][1];
    expect(update.$pull).toEqual({ 'verification.documents': { publicId: { $in: ['private/kyc-documents/seller-2/old'] } } });
    expect(update.$push['verification.history']).toMatchObject({ action: 'documents_expired', note: 'owner_id' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 'seller-2', type: NOTIFICATION_TYPES.VERIFICATION_REMINDER, title: 'Your uploaded documents were removed',
      data: { storeId: 'd1', link: '/store/d1/settings/verification' },
    }));
  });

  it('a rejected store loses all its files once the decision is older than the period', async () => {
    const { service, upload } = build([], [draftStore({ verificationStatus: 'rejected', reviewedAt: daysAgo(91) })]);
    const res = await service.run(now);
    expect(res.filesDeleted).toBe(2);
    expect(upload.deletePrivateFile).toHaveBeenCalledTimes(2);
  });

  it('a recently rejected store keeps its files', async () => {
    const { service, storeModel } = build([], [draftStore({ verificationStatus: 'rejected', reviewedAt: daysAgo(10) })]);
    expect((await service.run(now)).draftsExpired).toBe(0);
    expect(storeModel.updateOne).not.toHaveBeenCalled();
  });

  it('never touches stores under review or verified, even if the query returned them', async () => {
    const { service, storeModel, upload } = build([], [
      draftStore({ _id: 'p', verificationStatus: 'pending' }), draftStore({ _id: 'v', verificationStatus: 'verified' }), draftStore({ _id: 'u', verificationStatus: 'under_review' }),
    ]);
    expect((await service.run(now)).draftsExpired).toBe(0);
    expect(upload.deletePrivateFile).not.toHaveBeenCalled();
    expect(storeModel.updateOne).not.toHaveBeenCalled();
  });

  it('only the files that were really deleted leave the record; a refused file stays for tomorrow', async () => {
    const { service, storeModel, upload, notifications } = build([], [draftStore({ verificationStatus: 'rejected', reviewedAt: daysAgo(120) })]);
    upload.deletePrivateFile.mockResolvedValueOnce('ok').mockRejectedValueOnce(new Error('down'));
    const res = await service.run(now);
    expect(res).toMatchObject({ filesDeleted: 1, failed: 1, draftsExpired: 1 });
    expect(storeModel.updateOne.mock.calls[0][1].$pull['verification.documents'].publicId.$in).toEqual(['private/kyc-documents/seller-2/old']);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('if every file is refused nothing changes and nobody is told', async () => {
    const { service, storeModel, upload, notifications } = build([], [draftStore()]);
    upload.deletePrivateFile.mockRejectedValue(new Error('down'));
    const res = await service.run(now);
    expect(res).toMatchObject({ draftsExpired: 0, failed: 1 });
    expect(storeModel.updateOne).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('follows the configured number of days', async () => {
    const strict = build([], [draftStore({}, { documents: [file('private/kyc-documents/seller-2/a', daysAgo(40))] })], { enforcementStartedAt: null, graceDays: 30, kycDraftRetentionDays: 30 });
    expect((await strict.service.run(now)).draftsExpired).toBe(1);
    const lenient = build([], [draftStore({}, { documents: [file('private/kyc-documents/seller-2/a', daysAgo(40))] })]);
    expect((await lenient.service.run(now)).draftsExpired).toBe(0); // default 90 days
  });
});
