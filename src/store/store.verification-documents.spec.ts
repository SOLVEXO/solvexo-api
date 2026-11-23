/* eslint-disable prettier/prettier */
import { StoreService } from './store.service';

/**
 * Seller business-verification documents (CNIC / passport, address proof, registration, tax certificate) are private Cloudinary files.
 * Their links must really expire (the signed DOWNLOAD API, ≤ 5 min, inline) and a replaced document's private file must be removed.
 * Only these callers use the expiring helpers; the shared `generateSignedUrl` / `deleteFile` are untouched (see CLOUDINARY_HELPERS_REPORT.md).
 */
const make = (store: any) => {
  const svc: any = Object.create(StoreService.prototype);
  const uploads = {
    generateExpiringPrivateUrl: jest.fn((id: string) => `https://res.cloudinary.test/download?public_id=${id}&expires_at=1`),
    generateSignedUrl: jest.fn(() => { throw new Error('the permanent-link helper must not be used for seller documents'); }),
    deletePrivateFile: jest.fn().mockResolvedValue('ok'),
    deleteFile: jest.fn(() => { throw new Error('the public-delete helper must not be used for seller documents'); }),
  };
  const update = jest.fn().mockResolvedValue({});
  svc.uploadService = uploads;
  svc.databaseService = { repositories: { storeModel: { findByIdAndUpdate: update } } };
  svc.findOwnedStoreOrThrow = jest.fn().mockResolvedValue(store);
  return { svc, uploads, update };
};
const doc = (type: string, id: string, fileName = 'id-card.pdf') => ({ type, publicId: `private/kyc-documents/u1/${id}`, resourceType: 'raw', fileName, uploadedAt: new Date() });
const store = (docs: any[]) => ({ _id: 's1', sellerId: 'u1', country: 'PK', businessType: 'individual', verificationStatus: 'not_started', verification: { documents: docs, toObject() { return { documents: docs }; } } });

describe('seller verification documents: expiring links', () => {
  it('a document view link is the signed DOWNLOAD url, inline, for at most 5 minutes — also for a file name with an extension', () => {
    const { svc, uploads } = make(store([]));
    const url = svc.signedDocumentUrl(doc('owner_id', 'abc', 'passport.final.pdf'));
    expect(url).toContain('download');
    expect(uploads.generateExpiringPrivateUrl).toHaveBeenCalledWith('private/kyc-documents/u1/abc', 'raw', 300, { inline: true });
    expect(uploads.generateSignedUrl).not.toHaveBeenCalled();
  });

  it('getVerification hands the seller (and the admin lead view, which reads the same checklist) an expiring link per uploaded document', async () => {
    const { svc, uploads } = make(store([doc('owner_id', 'abc')]));
    const res: any = await svc.getVerification('u1', 's1');
    const links = JSON.stringify(res.data);
    expect(links).toContain('download');
    expect(uploads.generateExpiringPrivateUrl).toHaveBeenCalled();
    expect(uploads.generateSignedUrl).not.toHaveBeenCalled();
  });
});

describe('seller verification documents: only the seller\'s own uploaded file can be attached', () => {
  const attach = (svc: any, publicId: any, resourceType: any = 'raw') =>
    svc.updateVerification('u1', 's1', { documents: [{ type: 'owner_id', publicId, resourceType, fileName: 'x.pdf' }] });

  it('rejects another seller\'s file, another private folder, a path trick and an empty id — and saves nothing', async () => {
    const { svc, update } = make(store([]));
    await expect(attach(svc, 'private/kyc-documents/u2/abc')).rejects.toThrow('Invalid document');
    await expect(attach(svc, 'private/digital-products/abc')).rejects.toThrow('Invalid document');
    await expect(attach(svc, 'private/kyc-documents/u1/../u2/abc')).rejects.toThrow('Invalid document');
    await expect(attach(svc, 'private/kyc-documents/u1/')).rejects.toThrow('Invalid document');
    await expect(attach(svc, 'private/kyc-documents/u1')).rejects.toThrow('Invalid document');
    await expect(attach(svc, undefined)).rejects.toThrow('Invalid document');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a resource type that a KYC file can never have', async () => {
    const { svc, update } = make(store([]));
    await expect(attach(svc, 'private/kyc-documents/u1/abc', 'video')).rejects.toThrow('Invalid document type');
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts the seller\'s own file (image or raw)', async () => {
    const { svc } = make(store([]));
    await expect(attach(svc, 'private/kyc-documents/u1/abc', 'image')).resolves.toMatchObject({ success: true });
    await expect(attach(svc, 'private/kyc-documents/u1/def', 'raw')).resolves.toMatchObject({ success: true });
  });
});

describe('seller verification: authorized contact', () => {
  it('keeps only name, designation, email and phone (trimmed) — an extra key a client sends is dropped', async () => {
    const { svc, update } = make(store([]));
    await svc.updateVerification('u1', 's1', { authorizedContact: { name: ' Ali ', email: 'a@b.com', isAdmin: true, $set: { x: 1 } } as any });
    const saved = update.mock.calls[0][1].$set.verification.authorizedContact;
    expect(saved).toEqual({ name: 'Ali', email: 'a@b.com' });
  });
});

describe('seller verification documents: a replaced file is deleted (private)', () => {
  it('re-uploading a document type removes the OLD private file after the new one is saved; the same file again deletes nothing', async () => {
    const old = doc('owner_id', 'old');
    const { svc, uploads, update } = make(store([old]));
    await svc.updateVerification('u1', 's1', { documents: [{ type: 'owner_id', publicId: 'private/kyc-documents/u1/new', resourceType: 'raw', fileName: 'new.pdf' }] });
    expect(update).toHaveBeenCalledTimes(1);
    expect(uploads.deletePrivateFile).toHaveBeenCalledTimes(1);
    expect(uploads.deletePrivateFile).toHaveBeenCalledWith(old.publicId, 'raw');
    expect(uploads.deleteFile).not.toHaveBeenCalled();
    uploads.deletePrivateFile.mockClear();
    await svc.updateVerification('u1', 's1', { documents: [{ type: 'owner_id', publicId: old.publicId, resourceType: 'raw', fileName: 'same.pdf' }] });
    expect(uploads.deletePrivateFile).not.toHaveBeenCalled();
  });

  it('a different document type does not delete anything; a storage failure never fails the save', async () => {
    const { svc, uploads } = make(store([doc('owner_id', 'a')]));
    await svc.updateVerification('u1', 's1', { documents: [{ type: 'address_proof', publicId: 'private/kyc-documents/u1/b', resourceType: 'raw', fileName: 'b.pdf' }] });
    expect(uploads.deletePrivateFile).not.toHaveBeenCalled();
    uploads.deletePrivateFile.mockRejectedValueOnce(new Error('storage down'));
    await expect(svc.updateVerification('u1', 's1', { documents: [{ type: 'owner_id', publicId: 'private/kyc-documents/u1/c', resourceType: 'raw', fileName: 'c.pdf' }] })).resolves.toMatchObject({ success: true });
  });
});
