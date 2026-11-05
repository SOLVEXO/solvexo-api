/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Store, StoreDocument } from '../store/schemas/store.schema';
import { UploadService } from '../upload/upload.service';
import { KybActor, KybAuditService } from './kyb-audit.service';
import { KybService, failClosed } from './kyb.service';
import { KYB_BUSINESS_TYPES, KYB_STATUSES, StoreKyb, StoreKybDocument } from './kyb.schemas';
import { getKybRequirements } from './kyb-requirements.config';

const SUBMERCHANT_REF = /^[A-Za-z0-9._:-]{3,100}$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface KybListQuery { status?: string; businessType?: string; q?: string; from?: string; to?: string; page?: number; limit?: number; sort?: 'submittedAt' | '-submittedAt' | 'updatedAt' | '-updatedAt' }

@Injectable()
export class KybAdminService {
  constructor(
    @InjectModel(StoreKyb.name) private readonly model: Model<StoreKybDocument>,
    @InjectModel(Store.name) private readonly stores: Model<StoreDocument>,
    private readonly kyb: KybService,
    private readonly audit: KybAuditService,
    private readonly upload: UploadService,
  ) {}

  private async docOrThrow(storeId: string): Promise<any> {
    const k = await this.model.findOne({ storeId }).lean();
    if (!k) throw new NotFoundException({ code: 'KYB_NOT_FOUND', message: 'No business verification for this store' });
    return k;
  }

  /** List/filter — masked only, nothing is decrypted, so listing needs no key and writes no per-row audit. */
  async list(q: KybListQuery) {
    const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const filter: any = { status: { $in: ['submitted'] } };
    if (q.status) {
      if (q.status === 'all') delete filter.status;
      else if (KYB_STATUSES.includes(q.status as any)) filter.status = q.status;
      else throw new BadRequestException({ code: 'INVALID_FILTER', message: 'Unknown status' });
    }
    if (q.businessType) { if (!KYB_BUSINESS_TYPES.includes(q.businessType as any)) throw new BadRequestException({ code: 'INVALID_FILTER', message: 'Unknown business type' }); filter.businessType = q.businessType; }
    if (q.q) filter.$or = [{ legalBusinessName: { $regex: escapeRe(q.q.trim()), $options: 'i' } }, { storeId: q.q.trim() }, { 'subMerchant.ref': q.q.trim() }];
    if (q.from || q.to) { filter.submittedAt = {}; if (q.from) filter.submittedAt.$gte = new Date(q.from); if (q.to) filter.submittedAt.$lte = new Date(q.to); }
    const ALLOWED_SORT = ['submittedAt', '-submittedAt', 'updatedAt', '-updatedAt'];
    const sortKey = ALLOWED_SORT.includes(q.sort as string) ? (q.sort as string) : '-submittedAt';
    const sort: any = { [sortKey.replace('-', '')]: sortKey.startsWith('-') ? -1 : 1 };
    const [rows, total] = await Promise.all([this.model.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), this.model.countDocuments(filter)]);
    const stores: any[] = await this.stores.find({ _id: { $in: rows.map((r: any) => r.storeId) } }).select('name slug').lean();
    const nameOf = new Map(stores.map((s) => [String(s._id), s]));
    return {
      items: rows.map((k: any) => ({
        storeId: k.storeId, storeName: nameOf.get(k.storeId)?.name ?? null, storeSlug: nameOf.get(k.storeId)?.slug ?? null, status: k.status, businessType: k.businessType,
        legalBusinessName: k.legalBusinessName, submittedAt: k.submittedAt, reviewedAt: k.reviewedAt, documentCount: (k.documents ?? []).length,
        subMerchantRef: k.subMerchant?.ref ?? null, digitalPaymentsEnabled: k.status === 'verified' && !!k.subMerchant?.ref, updatedAt: k.updatedAt,
      })),
      page, limit, total, pages: Math.ceil(total / limit),
    };
  }

  /** Full submission with the sensitive fields DECRYPTED. The read itself is audited first; if the audit write fails, nothing is returned. */
  async detail(storeId: string, actor: KybActor) {
    const k = await this.docOrThrow(storeId);
    if (k.purgedAt) throw new ConflictException({ code: 'KYB_PURGED', message: 'Sensitive data was deleted under the retention policy' });
    failClosed(() => this.kyb.crypto.assertReady());
    await this.audit.record(storeId, actor, 'kyb_viewed', { status: k.status }); // awaited BEFORE decrypting
    const dec = (token: string | null, field: string) => (token ? failClosed(() => this.kyb.crypto.decrypt(token, `${storeId}:${field}`)) : null);
    const store: any = await this.stores.findById(storeId).select('name slug baseCurrency country').lean();
    const req = getKybRequirements(k.businessType ?? null);
    const have = new Set((k.documents ?? []).map((d: any) => d.type));
    return {
      storeId, store: store ? { name: store.name, slug: store.slug, baseCurrency: store.baseCurrency ?? null, country: store.country ?? null } : null,
      status: k.status, businessType: k.businessType, legalBusinessName: k.legalBusinessName, businessAddress: k.businessAddress, contact: k.contact,
      bankName: k.bankName, cnic: dec(k.cnicEnc, 'cnic'), ntn: dec(k.ntnEnc, 'ntn'), iban: dec(k.ibanEnc, 'iban'), accountTitle: dec(k.accountTitleEnc, 'accountTitle'),
      documents: (k.documents ?? []).map((d: any) => ({ id: String(d._id), type: d.type, fileName: d.fileName, mimeType: d.mimeType, fileSize: d.fileSize, uploadedAt: d.uploadedAt })),
      requirements: { ...req, missingDocuments: req.requiredDocuments.filter((t) => !have.has(t)) },
      submittedAt: k.submittedAt, reviewedAt: k.reviewedAt, reviewedBy: k.reviewedBy, rejectionReason: k.rejectionReason,
      subMerchant: { ref: k.subMerchant?.ref ?? null, providerKey: k.subMerchant?.providerKey ?? null, setAt: k.subMerchant?.setAt ?? null, setBy: k.subMerchant?.setBy ?? null },
      digitalPaymentsEnabled: k.status === 'verified' && !!k.subMerchant?.ref, history: k.history ?? [],
    };
  }

  private async docAccess(storeId: string, docId: string, actor: KybActor, action: 'kyb_document_viewed' | 'kyb_document_downloaded') {
    const k = await this.docOrThrow(storeId);
    if (k.purgedAt) throw new ConflictException({ code: 'KYB_PURGED', message: 'Documents were deleted under the retention policy' });
    const d = (k.documents ?? []).find((x: any) => String(x._id) === docId);
    if (!d) throw new NotFoundException({ code: 'KYB_DOCUMENT_NOT_FOUND', message: 'Document not found' });
    await this.audit.record(storeId, actor, action, { type: d.type, fileName: d.fileName }, { type: 'document', id: docId }); // fail closed: no audit row, no access
    return d;
  }

  async documentUrl(storeId: string, docId: string, actor: KybActor) {
    const d = await this.docAccess(storeId, docId, actor, 'kyb_document_viewed');
    const expiresInSeconds = 300;
    return { url: this.upload.generateSignedUrl(d.publicId, d.resourceType, expiresInSeconds, d.fileName), expiresInSeconds, fileName: d.fileName, mimeType: d.mimeType };
  }

  async documentDownload(storeId: string, docId: string, actor: KybActor) {
    const d = await this.docAccess(storeId, docId, actor, 'kyb_document_downloaded');
    const buffer = await this.upload.downloadPrivateFileBuffer(d.publicId, d.resourceType);
    return { buffer, fileName: d.fileName, mimeType: d.mimeType ?? 'application/octet-stream' };
  }

  async approve(storeId: string, actor: KybActor, note?: string) {
    const k = await this.docOrThrow(storeId);
    if (k.status !== 'submitted') throw new ConflictException({ code: 'KYB_NOT_SUBMITTED', message: `Only a submitted application can be approved (it is ${k.status})` });
    const res = await this.model.findOneAndUpdate(
      { storeId, status: 'submitted' },
      { $set: { status: 'verified', reviewedAt: new Date(), reviewedBy: actor.id ?? null, rejectionReason: null }, $push: { history: { action: 'approved', note: note?.slice(0, 300) ?? null, actorId: actor.id ?? null, actorRole: 'admin', at: new Date() } } },
      { new: true },
    ).lean();
    if (!res) throw new ConflictException({ code: 'KYB_NOT_SUBMITTED', message: 'The application changed; reload it' });
    await this.audit.record(storeId, actor, 'kyb_approved', { note: note ?? null });
    return { storeId, status: 'verified', digitalPaymentsEnabled: !!res.subMerchant?.ref, needsSubMerchant: !res.subMerchant?.ref };
  }

  /** Rejects a submitted application, or revokes a verified one (digital payments stop immediately: the gate reads the status). */
  async reject(storeId: string, actor: KybActor, reason: string) {
    const r = (reason ?? '').trim();
    if (r.length < 10) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A rejection reason of at least 10 characters is required' });
    const k = await this.docOrThrow(storeId);
    if (!['submitted', 'verified'].includes(k.status)) throw new ConflictException({ code: 'KYB_NOT_REVIEWABLE', message: `An application that is ${k.status} cannot be rejected` });
    const res = await this.model.findOneAndUpdate(
      { storeId, status: { $in: ['submitted', 'verified'] } },
      { $set: { status: 'rejected', reviewedAt: new Date(), reviewedBy: actor.id ?? null, rejectionReason: r.slice(0, 500) }, $push: { history: { action: 'rejected', note: r.slice(0, 500), actorId: actor.id ?? null, actorRole: 'admin', at: new Date() } } },
      { new: true },
    ).lean();
    if (!res) throw new ConflictException({ code: 'KYB_NOT_REVIEWABLE', message: 'The application changed; reload it' });
    await this.audit.record(storeId, actor, 'kyb_rejected', { reason: r.slice(0, 500), wasStatus: k.status });
    return { storeId, status: 'rejected', digitalPaymentsEnabled: false };
  }

  async setSubMerchant(storeId: string, actor: KybActor, dto: { providerKey: string; ref: string }) {
    const k = await this.docOrThrow(storeId);
    if (k.status !== 'verified') throw new ConflictException({ code: 'KYB_NOT_VERIFIED', message: 'A sub-merchant reference can only be set on a verified store' });
    const providerKey = (dto.providerKey ?? '').trim().toLowerCase(); const ref = (dto.ref ?? '').trim();
    if (!/^[a-z0-9_-]{2,40}$/.test(providerKey)) throw new BadRequestException({ code: 'INVALID_PROVIDER', message: 'providerKey must be 2–40 characters (a–z, 0–9, _ -)' });
    if (!SUBMERCHANT_REF.test(ref)) throw new BadRequestException({ code: 'INVALID_SUB_MERCHANT_REF', message: 'ref must be 3–100 characters (letters, digits, . _ : -)' });
    const clash = await this.model.findOne({ 'subMerchant.ref': ref, 'subMerchant.providerKey': providerKey, storeId: { $ne: storeId } }).select('storeId').lean();
    if (clash) throw new ConflictException({ code: 'SUB_MERCHANT_IN_USE', message: 'That sub-merchant reference is already assigned to another store' });
    const res = await this.model.findOneAndUpdate(
      { storeId, status: 'verified' },
      { $set: { subMerchant: { ref, providerKey, setAt: new Date(), setBy: actor.id ?? null } }, $push: { history: { action: 'sub_merchant_set', note: `${providerKey}:${ref}`, actorId: actor.id ?? null, actorRole: 'admin', at: new Date() } } },
      { new: true },
    ).lean();
    if (!res) throw new ConflictException({ code: 'KYB_NOT_VERIFIED', message: 'The application changed; reload it' });
    await this.audit.record(storeId, actor, 'kyb_sub_merchant_set', { providerKey, ref, previousRef: k.subMerchant?.ref ?? null });
    return { storeId, subMerchant: { ref, providerKey }, digitalPaymentsEnabled: true };
  }

  auditTrail(storeId: string, q: { page?: number; limit?: number; action?: string }) { return this.audit.list(storeId, q); }
}
