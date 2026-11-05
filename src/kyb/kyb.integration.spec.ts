/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import { makePaymentsFixture, setKybKeys, TEST_KEY_V1, TEST_KEY_V2 } from '../payments-core/testing/payments-harness';

jest.setTimeout(120_000);

type F = Awaited<ReturnType<typeof makePaymentsFixture>>;
const fresh = (verified = false) => makePaymentsFixture({ verified });
const PDF = (name = 'doc.pdf', size = 1000) => ({ originalname: name, mimetype: 'application/pdf', size, buffer: Buffer.alloc(8, 1) }) as any;
const IBAN = 'PK36SCBL0000001123456702';
const CNIC = '3520212345671';
const NTN = '7654321'; // deliberately not a substring of the CNIC, so the "no plaintext" scan is meaningful
const ACCT = 'Bright Traders Collection A/C';
const admin = (id = 'admin-1') => ({ type: 'admin' as const, id, ip: '10.0.0.1', userAgent: 'jest' });

const fill = async (x: F, o: { type?: string; docs?: string[] } = {}) => {
  const { sellerId, storeId } = x.s;
  await x.kyb.saveDraft(sellerId, storeId, {
    businessType: o.type ?? 'company', legalBusinessName: 'Bright Traders (Pvt) Ltd', businessAddress: 'Shop 4, Main Boulevard, Lahore',
    contact: { name: 'Ayesha Khan', email: 'ayesha@bright.pk', phone: '+923001234567' }, bankName: 'Standard Chartered', cnic: CNIC, ntn: NTN, iban: IBAN, accountTitle: ACCT,
  });
  for (const t of o.docs ?? ['owner_cnic', 'bank_proof', 'business_registration', 'tax_registration']) await x.kyb.uploadDocument(sellerId, storeId, t, PDF(`${t}.pdf`));
};
const actions = async (x: F, storeId: string) => ((await x.kybAuditModel.find({ storeId }).sort({ at: 1, _id: 1 }).lean()) as any[]).map((a) => a.action);

beforeEach(() => setKybKeys({ v1: true, current: '1' }));
afterAll(() => setKybKeys({ v1: false, current: null }));

describe('KYB: encryption at rest, masking, fail closed', () => {
  it('the raw database holds ONLY ciphertext for CNIC / NTN / IBAN / account title (no plaintext anywhere in the row), plus last-4 for display', async () => {
    const x = await fresh();
    await fill(x);
    const raw: any = await x.kybModel.collection.findOne({ storeId: x.s.storeId });
    for (const f of ['cnicEnc', 'ntnEnc', 'ibanEnc', 'accountTitleEnc']) expect(raw[f]).toMatch(/^kyb:v1:/);
    expect(raw).toMatchObject({ cnicLast4: '5671', ntnLast4: '4321', ibanLast4: '6702' });
    const dump = JSON.stringify(raw);
    for (const secret of [CNIC, NTN, IBAN, ACCT, 'SCBL0000001123456702']) expect(dump).not.toContain(secret);
    expect(dump).toContain('Bright Traders (Pvt) Ltd'); // the legal business NAME is not secret (admin lists need it); the ACCOUNT TITLE is encrypted
    // nothing sensitive in the audit trail or the history either
    const trail = JSON.stringify(await x.kybAuditModel.find({}).lean()) + JSON.stringify(raw.history);
    for (const secret of [CNIC, IBAN, NTN]) expect(trail).not.toContain(secret);
    await x.stop();
  });

  it('the owner only ever sees masked values and a checklist — and the response has no storage ids or ciphertext', async () => {
    const x = await fresh();
    await fill(x);
    const v: any = await x.kyb.getOwn(x.s.sellerId, x.s.storeId);
    expect(v).toMatchObject({ status: 'draft', cnicMasked: '•••••••••5671', ibanMasked: expect.stringMatching(/^PK•+6702$/), ntnMasked: '••••4321', accountTitleSet: true });
    const json = JSON.stringify(v);
    for (const bad of [CNIC, IBAN, NTN, ACCT, 'kyb:v1', 'private/kyb', 'publicId']) expect(json).not.toContain(bad);
    expect(v.requirements.missingDocuments).toEqual([]);
    await x.stop();
  });

  it('FAILS CLOSED without a key: saving a sensitive field returns 503 KYB_ENCRYPTION_UNAVAILABLE and stores NOTHING; non-sensitive reads/edits still work', async () => {
    const x = await fresh();
    const { sellerId, storeId } = x.s;
    setKybKeys({ v1: false, current: null });
    await expect(x.kyb.saveDraft(sellerId, storeId, { legalBusinessName: 'Acme', cnic: CNIC })).rejects.toMatchObject({ status: 503, response: { code: 'KYB_ENCRYPTION_UNAVAILABLE' } });
    await expect(x.kyb.saveDraft(sellerId, storeId, { iban: IBAN })).rejects.toMatchObject({ status: 503 });
    const raw: any = await x.kybModel.collection.findOne({ storeId });
    expect(raw.legalBusinessName).toBeNull(); // the whole request was refused, not half-applied
    expect(JSON.stringify(raw)).not.toContain(CNIC);
    expect(raw.cnicEnc).toBeNull();
    await expect(x.kyb.saveDraft(sellerId, storeId, { legalBusinessName: 'Acme' })).resolves.toMatchObject({ legalBusinessName: 'Acme' });
    await expect(x.kyb.getOwn(sellerId, storeId)).resolves.toMatchObject({ status: 'draft' });
    // admin detail needs the key: 503, and NO "viewed" audit row is written for a read that did not happen
    await x.kybModel.collection.updateOne({ storeId }, { $set: { status: 'submitted' } });
    await expect(x.kybAdmin.detail(storeId, admin())).rejects.toMatchObject({ status: 503, response: { code: 'KYB_ENCRYPTION_UNAVAILABLE' } });
    expect(await actions(x, storeId)).not.toContain('kyb_viewed');
    await x.stop();
  });

  it('validates identifiers server-side (IBAN checksum, CNIC, NTN, e-mail, business type)', async () => {
    const x = await fresh();
    const { sellerId, storeId } = x.s;
    const bad = async (input: any, field: string) => expect(x.kyb.saveDraft(sellerId, storeId, input)).rejects.toMatchObject({ response: { code: 'KYB_INVALID_FIELD', field } });
    await bad({ iban: 'PK37SCBL0000001123456702' }, 'iban'); await bad({ iban: 'GB82WEST12345698765432' }, 'iban');
    await bad({ cnic: '123' }, 'cnic'); await bad({ ntn: '12' }, 'ntn'); await bad({ contact: { email: 'nope' } }, 'contact.email');
    await bad({ businessType: 'cult' }, 'businessType');
    await x.stop();
  });
});

describe('KYB: owner flow draft → submitted, locking, documents', () => {
  it('submit needs everything the requirement set lists (company: NTN + registration + tax docs), and says exactly what is missing', async () => {
    const x = await fresh();
    const { sellerId, storeId } = x.s;
    await x.kyb.saveDraft(sellerId, storeId, { businessType: 'company', legalBusinessName: 'A Ltd' });
    await expect(x.kyb.submit(sellerId, storeId)).rejects.toMatchObject({ response: { code: 'KYB_INCOMPLETE', missingFields: expect.arrayContaining(['cnic', 'iban', 'ntn', 'accountTitle', 'bankName']), missingDocuments: expect.arrayContaining(['owner_cnic', 'bank_proof', 'business_registration', 'tax_registration']) } });
    await fill(x);
    const done = await x.kyb.submit(sellerId, storeId);
    expect(done).toMatchObject({ status: 'submitted', digitalPaymentsEnabled: false });
    await x.stop();
  });

  it('a sole proprietor needs fewer documents (no registration/tax certificate, no NTN)', async () => {
    const x = await fresh();
    const { sellerId, storeId } = x.s;
    await x.kyb.saveDraft(sellerId, storeId, { businessType: 'sole_proprietor', legalBusinessName: 'Ali Traders', businessAddress: 'Shop 1', contact: { name: 'Ali', email: 'a@b.pk', phone: '0300' }, bankName: 'HBL', cnic: CNIC, iban: IBAN, accountTitle: 'Ali' });
    await x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', PDF()); await x.kyb.uploadDocument(sellerId, storeId, 'bank_proof', PDF());
    await expect(x.kyb.submit(sellerId, storeId)).resolves.toMatchObject({ status: 'submitted' });
    await x.stop();
  });

  it('after submission the application is LOCKED (edit, upload, remove, resubmit all 409)', async () => {
    const x = await fresh();
    const { sellerId, storeId } = x.s;
    await fill(x); await x.kyb.submit(sellerId, storeId);
    await expect(x.kyb.saveDraft(sellerId, storeId, { legalBusinessName: 'Changed' })).rejects.toMatchObject({ response: { code: 'KYB_LOCKED' } });
    await expect(x.kyb.uploadDocument(sellerId, storeId, 'address_proof', PDF())).rejects.toMatchObject({ response: { code: 'KYB_LOCKED' } });
    const docId = ((await x.kyb.getOwn(sellerId, storeId)) as any).documents[0].id;
    await expect(x.kyb.removeDocument(sellerId, storeId, docId)).rejects.toMatchObject({ response: { code: 'KYB_LOCKED' } });
    await expect(x.kyb.submit(sellerId, storeId)).rejects.toMatchObject({ response: { code: 'KYB_LOCKED' } });
    await x.stop();
  });

  it('only the store\'s own seller can touch it', async () => {
    const x = await fresh();
    await expect(x.kyb.getOwn(String(new Types.ObjectId()), x.s.storeId)).rejects.toMatchObject({ status: 403 });
    await expect(x.kyb.saveDraft(String(new Types.ObjectId()), x.s.storeId, { legalBusinessName: 'x' })).rejects.toMatchObject({ status: 403 });
    await x.stop();
  });

  it('document rules: type, mime, size; one per type (a re-upload replaces and deletes the old file); private folder', async () => {
    const x = await fresh();
    const { sellerId, storeId } = x.s;
    await expect(x.kyb.uploadDocument(sellerId, storeId, 'selfie', PDF())).rejects.toMatchObject({ response: { code: 'KYB_INVALID_DOCUMENT_TYPE' } });
    await expect(x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', { ...PDF(), mimetype: 'application/zip' })).rejects.toMatchObject({ response: { code: 'KYB_FILE_TYPE' } });
    await expect(x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', PDF('big.pdf', 11 * 1024 * 1024))).rejects.toMatchObject({ response: { code: 'KYB_FILE_TOO_LARGE' } });
    await expect(x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', undefined)).rejects.toMatchObject({ response: { code: 'KYB_FILE_REQUIRED' } });
    await x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', PDF('a.pdf'));
    const first = [...x.upload.files.keys()][0];
    expect(first).toMatch(new RegExp(`^private/kyb/${storeId}/`));
    const v: any = await x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', PDF('b.pdf'));
    expect(v.documents).toHaveLength(1); expect(v.documents[0].fileName).toBe('b.pdf');
    expect(x.upload.files.has(first)).toBe(false);
    expect(x.upload.files.size).toBe(1);
    await x.stop();
  });

  it('a REJECTED application reopens as a draft when the owner edits it, and can be resubmitted', async () => {
    const x = await fresh();
    const { sellerId, storeId } = x.s;
    await fill(x); await x.kyb.submit(sellerId, storeId);
    await x.kybAdmin.reject(storeId, admin(), 'The CNIC photo is unreadable');
    const rejected: any = await x.kyb.getOwn(sellerId, storeId);
    expect(rejected).toMatchObject({ status: 'rejected', rejectionReason: 'The CNIC photo is unreadable' });
    await expect(x.kyb.submit(sellerId, storeId)).rejects.toMatchObject({ response: { code: 'KYB_REJECTED_EDIT_FIRST' } });
    expect(await x.kyb.saveDraft(sellerId, storeId, { businessAddress: 'New address, Lahore' })).toMatchObject({ status: 'draft', rejectionReason: null });
    await expect(x.kyb.submit(sellerId, storeId)).resolves.toMatchObject({ status: 'submitted' });
    await x.stop();
  });
});

describe('KYB: admin review, audited document access, approve/reject, sub-merchant, gate', () => {
  it('list: default queue is "submitted"; filters, search and pagination work; rows are masked (no decryption, no key needed)', async () => {
    const x = await fresh();
    await fill(x); await x.kyb.submit(x.s.sellerId, x.s.storeId);
    setKybKeys({ v1: false, current: null }); // listing must not need the key
    const q = await x.kybAdmin.list({});
    expect(q).toMatchObject({ total: 1, page: 1, items: [{ storeId: x.s.storeId, status: 'submitted', businessType: 'company', documentCount: 4, digitalPaymentsEnabled: false }] });
    expect(JSON.stringify(q)).not.toMatch(/kyb:v|PK36|3520212345671/);
    expect((await x.kybAdmin.list({ status: 'verified' })).total).toBe(0);
    expect((await x.kybAdmin.list({ status: 'all', q: 'bright' })).total).toBe(1);
    expect((await x.kybAdmin.list({ status: 'all', businessType: 'sole_proprietor' })).total).toBe(0);
    await expect(x.kybAdmin.list({ status: 'bogus' })).rejects.toMatchObject({ response: { code: 'INVALID_FILTER' } });
    expect((await x.kybAdmin.list({ status: 'all', limit: 1, page: 2 })).items).toHaveLength(0);
    await x.stop();
  });

  it('detail decrypts the sensitive fields and the READ IS AUDITED (who, when, from where) before it happens', async () => {
    const x = await fresh();
    await fill(x); await x.kyb.submit(x.s.sellerId, x.s.storeId);
    const d: any = await x.kybAdmin.detail(x.s.storeId, admin('adm-7'));
    expect(d).toMatchObject({ cnic: CNIC, ntn: NTN, iban: IBAN, accountTitle: ACCT, status: 'submitted', documents: expect.any(Array) });
    expect(JSON.stringify(d.documents)).not.toMatch(/publicId|private\/kyb/); // storage ids never leave the server
    const row: any = await x.kybAuditModel.findOne({ action: 'kyb_viewed' }).lean();
    expect(row).toMatchObject({ storeId: x.s.storeId, actorType: 'admin', actorId: 'adm-7', ip: '10.0.0.1' });
    // fail closed: if the audit write fails, nothing is decrypted or returned
    const spy = jest.spyOn(x.kybAudit, 'record').mockRejectedValueOnce(new Error('audit down'));
    await expect(x.kybAdmin.detail(x.s.storeId, admin())).rejects.toThrow('audit down');
    spy.mockRestore();
    await x.stop();
  });

  it('EVERY document view and download writes an audit row first; if the audit write fails there is NO access (no URL, no storage read)', async () => {
    const x = await fresh();
    await fill(x); await x.kyb.submit(x.s.sellerId, x.s.storeId);
    const docs: any[] = ((await x.kyb.getOwn(x.s.sellerId, x.s.storeId)) as any).documents;
    const doc = docs.find((d) => d.type === 'owner_cnic');
    const u: any = await x.kybAdmin.documentUrl(x.s.storeId, doc.id, admin());
    expect(u.url).toMatch(/^https:\/\/signed\.example\/private\/kyb\//); expect(u.expiresInSeconds).toBe(300);
    const dl: any = await x.kybAdmin.documentDownload(x.s.storeId, doc.id, admin());
    expect(dl.buffer).toBeInstanceOf(Buffer); expect(dl.fileName).toBe('owner_cnic.pdf');
    const rows: any[] = await x.kybAuditModel.find({ action: { $in: ['kyb_document_viewed', 'kyb_document_downloaded'] } }).sort({ at: 1 }).lean();
    expect(rows.map((r) => r.action)).toEqual(['kyb_document_viewed', 'kyb_document_downloaded']);
    expect(rows[0]).toMatchObject({ targetType: 'document', targetId: doc.id, meta: { type: 'owner_cnic' }, actorId: 'admin-1' });
    // fail closed
    x.upload.generateSignedUrl.mockClear(); x.upload.downloadPrivateFileBuffer.mockClear();
    const spy = jest.spyOn(x.kybAudit, 'record').mockRejectedValue(new Error('audit down'));
    await expect(x.kybAdmin.documentUrl(x.s.storeId, doc.id, admin())).rejects.toThrow('audit down');
    await expect(x.kybAdmin.documentDownload(x.s.storeId, doc.id, admin())).rejects.toThrow('audit down');
    expect(x.upload.generateSignedUrl).not.toHaveBeenCalled(); expect(x.upload.downloadPrivateFileBuffer).not.toHaveBeenCalled();
    spy.mockRestore();
    await expect(x.kybAdmin.documentUrl(x.s.storeId, String(new Types.ObjectId()), admin())).rejects.toMatchObject({ response: { code: 'KYB_DOCUMENT_NOT_FOUND' } });
    await x.stop();
  });

  it('approve → verified, but digital payments need the sub-merchant reference too; the gate then lets a QR payment through; revoking stops it at once', async () => {
    const x = await fresh();
    const { sellerId, storeId } = x.s;
    await fill(x);
    await expect(x.kybAdmin.approve(storeId, admin())).rejects.toMatchObject({ response: { code: 'KYB_NOT_SUBMITTED' } }); // still a draft
    await x.kyb.submit(sellerId, storeId);
    await expect(x.kybAdmin.setSubMerchant(storeId, admin(), { providerKey: 'mock', ref: 'SM-100' })).rejects.toMatchObject({ response: { code: 'KYB_NOT_VERIFIED' } });
    expect(await x.kybAdmin.approve(storeId, admin(), 'documents match')).toMatchObject({ status: 'verified', digitalPaymentsEnabled: false, needsSubMerchant: true });
    await expect(x.create()).rejects.toMatchObject({ response: { code: 'STORE_NOT_VERIFIED', reason: 'no_sub_merchant' } });
    await expect(x.kybAdmin.setSubMerchant(storeId, admin(), { providerKey: 'mock', ref: 'x' })).rejects.toMatchObject({ response: { code: 'INVALID_SUB_MERCHANT_REF' } });
    await expect(x.kybAdmin.setSubMerchant(storeId, admin(), { providerKey: 'Bad Key!', ref: 'SM-100' })).rejects.toMatchObject({ response: { code: 'INVALID_PROVIDER' } });
    expect(await x.kybAdmin.setSubMerchant(storeId, admin(), { providerKey: 'mock', ref: 'SM-100' })).toMatchObject({ digitalPaymentsEnabled: true });
    expect(await x.gate.isEnabled(storeId)).toBe(true);
    expect(await x.create()).toMatchObject({ status: 'created' }); // the QR payment is allowed now
    expect(await x.kyb.getOwn(sellerId, storeId)).toMatchObject({ digitalPaymentsEnabled: true });
    // revoke: stops immediately, reason required
    await expect(x.kybAdmin.reject(storeId, admin(), 'short')).rejects.toMatchObject({ response: { code: 'REASON_REQUIRED' } });
    await x.kybAdmin.reject(storeId, admin(), 'Fraud suspected — see ticket 4411');
    expect(await x.gate.isEnabled(storeId)).toBe(false);
    await expect(x.create()).rejects.toMatchObject({ response: { code: 'STORE_NOT_VERIFIED', reason: 'kyb_rejected' } });
    await x.stop();
  });

  it('one sub-merchant reference cannot belong to two stores', async () => {
    const x = await fresh();
    await fill(x); await x.kyb.submit(x.s.sellerId, x.s.storeId); await x.kybAdmin.approve(x.s.storeId, admin());
    await x.kybModel.collection.insertOne({ storeId: 'other-store', sellerId: 's', status: 'verified', subMerchant: { ref: 'SM-DUP', providerKey: 'mock' } });
    await expect(x.kybAdmin.setSubMerchant(x.s.storeId, admin(), { providerKey: 'mock', ref: 'SM-DUP' })).rejects.toMatchObject({ response: { code: 'SUB_MERCHANT_IN_USE' } });
    await x.stop();
  });

  it('the per-store audit trail records every step, in order, with actor and no secrets', async () => {
    const x = await fresh();
    await fill(x); await x.kyb.submit(x.s.sellerId, x.s.storeId);
    await x.kybAdmin.detail(x.s.storeId, admin());
    await x.kybAdmin.approve(x.s.storeId, admin());
    await x.kybAdmin.setSubMerchant(x.s.storeId, admin(), { providerKey: 'mock', ref: 'SM-1' });
    const a = await actions(x, x.s.storeId);
    expect(a).toEqual(['kyb_draft_saved', 'kyb_document_uploaded', 'kyb_document_uploaded', 'kyb_document_uploaded', 'kyb_document_uploaded', 'kyb_submitted', 'kyb_viewed', 'kyb_approved', 'kyb_sub_merchant_set']);
    const page = await x.kybAdmin.auditTrail(x.s.storeId, { limit: 3, page: 1 });
    expect(page).toMatchObject({ total: 9, pages: 3, items: [{ action: 'kyb_sub_merchant_set' }, { action: 'kyb_approved' }, { action: 'kyb_viewed' }] });
    expect((await x.kybAdmin.auditTrail(x.s.storeId, { action: 'kyb_approved' })).total).toBe(1);
    await x.stop();
  });

  it('the audit collection is append-only', async () => {
    const x = await fresh();
    await fill(x);
    await expect((x.kybAuditModel as any).updateOne({}, { $set: { action: 'x' } })).rejects.toThrow(/append-only/);
    await expect((x.kybAuditModel as any).deleteMany({})).rejects.toThrow(/append-only/);
    await x.stop();
  });
});

describe('KYB: key rotation', () => {
  it('re-encrypts every value to the current key version, idempotently, without changing what admins read', async () => {
    const x = await fresh();
    await fill(x);
    await x.kyb.submit(x.s.sellerId, x.s.storeId);
    // add V2 and make it current: new writes use V2, old values still readable
    process.env.KYB_ENC_KEY_V2 = TEST_KEY_V2; process.env.KYB_ENC_KEY_CURRENT = '2';
    expect((await x.kybAdmin.detail(x.s.storeId, admin())).iban).toBe(IBAN);
    const dry = await x.maintenance.rotateKeys({ dryRun: true });
    expect(dry).toMatchObject({ currentVersion: 2, dryRun: true, valuesRotated: 4, valuesAlreadyCurrent: 0 });
    expect(((await x.kybModel.collection.findOne({ storeId: x.s.storeId })) as any).ibanEnc).toMatch(/^kyb:v1:/); // a dry run changes nothing
    const run = await x.maintenance.rotateKeys();
    expect(run).toMatchObject({ valuesRotated: 4, failed: 0, remainingOnOldVersions: 0 });
    const raw: any = await x.kybModel.collection.findOne({ storeId: x.s.storeId });
    for (const f of ['cnicEnc', 'ntnEnc', 'ibanEnc', 'accountTitleEnc']) expect(raw[f]).toMatch(/^kyb:v2:/);
    expect(await x.maintenance.rotateKeys()).toMatchObject({ valuesRotated: 0, valuesAlreadyCurrent: 4 }); // idempotent
    // now V1 can be removed and everything still decrypts
    delete process.env.KYB_ENC_KEY_V1;
    expect(await x.kybAdmin.detail(x.s.storeId, admin())).toMatchObject({ cnic: CNIC, iban: IBAN, ntn: NTN, accountTitle: ACCT });
    expect((await x.kybAuditModel.findOne({ action: 'kyb_key_rotation_run', 'meta.valuesRotated': 4 }).lean()) as any).toMatchObject({ storeId: 'platform', meta: { valuesRotated: 4 } });
    process.env.KYB_ENC_KEY_V1 = TEST_KEY_V1;
    await x.stop();
  });

  it('a value whose old key was already removed is reported as failed (not silently skipped) and the rest still rotate', async () => {
    const x = await fresh();
    await fill(x);
    process.env.KYB_ENC_KEY_V2 = TEST_KEY_V2; process.env.KYB_ENC_KEY_CURRENT = '2'; delete process.env.KYB_ENC_KEY_V1;
    const r = await x.maintenance.rotateKeys();
    expect(r).toMatchObject({ failed: 4, valuesRotated: 0, remainingOnOldVersions: 4 });
    process.env.KYB_ENC_KEY_V1 = TEST_KEY_V1;
    await x.stop();
  });

  it('refuses to rotate when no current key is configured (fail closed)', async () => {
    const x = await fresh();
    setKybKeys({ v1: false, current: null });
    await expect(x.maintenance.rotateKeys()).rejects.toMatchObject({ status: 503 });
    await x.stop();
  });
});

describe('KYB: retention (configurable, NO default deletion, dry-run capable, disabled by default)', () => {
  const closeStore = async (x: F, daysAgo: number) => x.h.repos.storeModel.collection.updateOne({ _id: new Types.ObjectId(x.s.storeId) }, { $set: { isDelete: true, updatedAt: new Date(Date.now() - daysAgo * 86400_000) } });

  it('by default there is no retention period and nothing is ever deleted', async () => {
    const x = await fresh();
    await fill(x); await closeStore(x, 4000);
    expect(await x.maintenance.getSettings()).toMatchObject({ afterClosureDays: null, purgeEnabled: false });
    expect(await x.maintenance.runRetention({ dryRun: false })).toMatchObject({ skipped: true, reason: 'no_retention_period_set', purged: 0 });
    expect(((await x.kybModel.findOne({ storeId: x.s.storeId }).lean()) as any).documents).toHaveLength(4);
    expect(x.upload.deleteFile).not.toHaveBeenCalledWith(expect.stringContaining('private/kyb'), expect.anything());
    await x.stop();
  });

  it('settings are validated and audited; deletion cannot be enabled without a period', async () => {
    const x = await fresh();
    await expect(x.maintenance.updateSettings('adm', { purgeEnabled: true })).rejects.toMatchObject({ response: { code: 'RETENTION_PERIOD_REQUIRED' } });
    await expect(x.maintenance.updateSettings('adm', { afterClosureDays: 5 })).rejects.toMatchObject({ response: { code: 'INVALID_RETENTION' } });
    await expect(x.maintenance.updateSettings('adm', { afterClosureDays: 1.5 as any })).rejects.toMatchObject({ response: { code: 'INVALID_RETENTION' } });
    await x.maintenance.updateSettings('adm', { afterClosureDays: 365 });
    expect(await x.maintenance.getSettings()).toMatchObject({ afterClosureDays: 365, purgeEnabled: false });
    expect(await x.maintenance.runRetention({ dryRun: false })).toMatchObject({ skipped: true, reason: 'purge_disabled' });
    const a: any = await x.kybAuditModel.findOne({ action: 'kyb_retention_settings_changed' }).lean();
    expect(a).toMatchObject({ actorId: 'adm', meta: { to: { afterClosureDays: 365, purgeEnabled: false } } });
    await x.stop();
  });

  it('dry run lists who would be purged and changes nothing; the real run deletes documents + encrypted fields, keeps history and audit, only for stores closed longer than the period', async () => {
    const x = await fresh();
    await fill(x); await x.maintenance.updateSettings('adm', { afterClosureDays: 365, purgeEnabled: true });
    await closeStore(x, 100); // closed 100 days ago: inside the period
    expect(await x.maintenance.runRetention({})).toMatchObject({ skipped: false, dryRun: true, eligible: 0 });
    await closeStore(x, 400);
    const dry = await x.maintenance.runRetention({});
    expect(dry).toMatchObject({ dryRun: true, eligible: 1, purged: 0, stores: [{ storeId: x.s.storeId, documents: 4 }] });
    expect(((await x.kybModel.collection.findOne({ storeId: x.s.storeId })) as any).ibanEnc).toMatch(/^kyb:/);
    expect(x.upload.files.size).toBe(4);
    const real = await x.maintenance.runRetention({ dryRun: false, actor: { type: 'admin', id: 'adm' } });
    expect(real).toMatchObject({ dryRun: false, eligible: 1, purged: 1, failed: 0 });
    const raw: any = await x.kybModel.collection.findOne({ storeId: x.s.storeId });
    expect(raw).toMatchObject({ cnicEnc: null, ibanEnc: null, ntnEnc: null, accountTitleEnc: null, documents: [] });
    expect(raw.purgedAt).toBeInstanceOf(Date); expect(raw.history.at(-1).action).toBe('purged');
    expect(x.upload.files.size).toBe(0);
    expect((await actions(x, x.s.storeId))).toContain('kyb_purged');
    expect(await x.maintenance.runRetention({ dryRun: false })).toMatchObject({ eligible: 0, purged: 0 }); // idempotent
    await expect(x.kybAdmin.detail(x.s.storeId, admin())).rejects.toMatchObject({ response: { code: 'KYB_PURGED' } });
    await x.stop();
  });

  it('an ACTIVE store\'s documents are never touched, however old; a storage failure aborts that store only and is retried next run', async () => {
    const x = await fresh();
    await fill(x); await x.maintenance.updateSettings('adm', { afterClosureDays: 30, purgeEnabled: true });
    await x.h.repos.storeModel.collection.updateOne({ _id: new Types.ObjectId(x.s.storeId) }, { $set: { updatedAt: new Date(Date.now() - 5000 * 86400_000) } });
    expect(await x.maintenance.runRetention({ dryRun: false })).toMatchObject({ eligible: 0, purged: 0 });
    await closeStore(x, 100);
    x.upload.deleteFile.mockRejectedValueOnce(new Error('cloud down'));
    expect(await x.maintenance.runRetention({ dryRun: false })).toMatchObject({ eligible: 1, purged: 0, failed: 1 });
    expect(((await x.kybModel.findOne({ storeId: x.s.storeId }).lean()) as any).purgedAt).toBeNull();
    expect(await x.maintenance.runRetention({ dryRun: false })).toMatchObject({ purged: 1, failed: 0 });
    await x.stop();
  });
});
