/* eslint-disable prettier/prettier */
import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Store, StoreDocument } from '../store/schemas/store.schema';
import { UploadService } from '../upload/upload.service';
import { KybAuditService } from './kyb-audit.service';
import { KybCrypto, KybKeyUnavailableError, lastN, maskTail } from './kyb-field-crypto';
import { getKybRequirements } from './kyb-requirements.config';
import { isValidCnic, isValidNtn, isValidPkIban, normalizeCnic, normalizeIban, normalizeNtn } from './kyb-validators';
import {
  KYB_BUSINESS_TYPES, KYB_DOCUMENT_TYPES, KybBusinessType, KybDocumentType, StoreKyb, StoreKybDocument,
} from './kyb.schemas';

export const KYB_ENCRYPTION_UNAVAILABLE = 'KYB_ENCRYPTION_UNAVAILABLE';
export const KYB_LOCKED = 'KYB_LOCKED';
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];

export interface KybDraftInput {
  businessType?: string | null; legalBusinessName?: string | null; businessAddress?: string | null;
  contact?: { name?: string | null; designation?: string | null; email?: string | null; phone?: string | null };
  bankName?: string | null; cnic?: string | null; ntn?: string | null; iban?: string | null; accountTitle?: string | null;
}

/** Maps a missing/invalid key to a clean 503 — the request fails and NOTHING is stored in plaintext. */
export function failClosed<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof KybKeyUnavailableError) throw new ServiceUnavailableException({ code: KYB_ENCRYPTION_UNAVAILABLE, message: 'Business verification is temporarily unavailable' });
    throw e;
  }
}

@Injectable()
export class KybService {
  readonly crypto = new KybCrypto();

  constructor(
    @InjectModel(StoreKyb.name) readonly model: Model<StoreKybDocument>,
    @InjectModel(Store.name) private readonly stores: Model<StoreDocument>,
    private readonly audit: KybAuditService,
    private readonly upload: UploadService,
  ) {}

  private async ownStoreOrThrow(sellerId: string, storeId: string) {
    const store = await this.stores.findOne({ _id: storeId, sellerId, isDelete: false }).select('_id name baseCurrency').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async ensureDoc(sellerId: string, storeId: string): Promise<any> {
    const found = await this.model.findOne({ storeId }).lean();
    if (found) return found;
    try { return (await this.model.create([{ storeId, sellerId, status: 'draft' }]))[0].toObject(); }
    catch (e: any) { if (e?.code === 11000) return this.model.findOne({ storeId }).lean(); throw e; }
  }

  /** What the owner may see: status, masked identifiers, documents WITHOUT their storage ids, the requirement checklist. Works without the key. */
  view(k: any) {
    const req = getKybRequirements((k.businessType as KybBusinessType) ?? null);
    const have = new Set((k.documents ?? []).map((d: any) => d.type));
    return {
      storeId: k.storeId, status: k.status, businessType: k.businessType, legalBusinessName: k.legalBusinessName, businessAddress: k.businessAddress,
      contact: { name: k.contact?.name ?? null, designation: k.contact?.designation ?? null, email: k.contact?.email ?? null, phone: k.contact?.phone ?? null },
      bankName: k.bankName,
      cnicMasked: k.cnicLast4 ? maskTail('0'.repeat(13), 4).slice(0, -4) + k.cnicLast4 : null,
      ntnMasked: k.ntnLast4 ? '•'.repeat(4) + k.ntnLast4 : null,
      ibanMasked: k.ibanLast4 ? 'PK' + '•'.repeat(18) + k.ibanLast4 : null,
      accountTitleSet: !!k.accountTitleEnc,
      documents: (k.documents ?? []).map((d: any) => ({ id: String(d._id), type: d.type, fileName: d.fileName, mimeType: d.mimeType, fileSize: d.fileSize, uploadedAt: d.uploadedAt })),
      requirements: { ...req, missingDocuments: req.requiredDocuments.filter((t) => !have.has(t)) },
      submittedAt: k.submittedAt, reviewedAt: k.reviewedAt, rejectionReason: k.status === 'rejected' ? k.rejectionReason : null,
      digitalPaymentsEnabled: k.status === 'verified' && !!k.subMerchant?.ref,
      history: (k.history ?? []).map((h: any) => ({ action: h.action, note: h.actorRole === 'admin' && h.action !== 'rejected' ? null : h.note, actorRole: h.actorRole, at: h.at })),
      updatedAt: k.updatedAt,
    };
  }

  async getOwn(sellerId: string, storeId: string) {
    await this.ownStoreOrThrow(sellerId, storeId);
    return this.view(await this.ensureDoc(sellerId, storeId));
  }

  async saveDraft(sellerId: string, storeId: string, input: KybDraftInput, actor: { ip?: string; userAgent?: string } = {}) {
    await this.ownStoreOrThrow(sellerId, storeId);
    const cur = await this.ensureDoc(sellerId, storeId);
    if (cur.purgedAt) throw new ConflictException({ code: 'KYB_PURGED', message: 'This application was deleted under the retention policy' });
    if (!['draft', 'rejected'].includes(cur.status)) throw new ConflictException({ code: KYB_LOCKED, message: 'This application can no longer be edited' });

    const set: Record<string, any> = {};
    const bad = (field: string, message: string) => { throw new BadRequestException({ code: 'KYB_INVALID_FIELD', field, message }); };
    const str = (v: any, field: string, max: number) => { if (v === null || v === '') return null; if (typeof v !== 'string') bad(field, `${field} must be text`); const t = v.trim(); if (t.length > max) bad(field, `${field} is too long`); return t || null; };

    if (input.businessType !== undefined) { if (input.businessType !== null && !KYB_BUSINESS_TYPES.includes(input.businessType as any)) bad('businessType', 'Unknown business type'); set.businessType = input.businessType; }
    if (input.legalBusinessName !== undefined) set.legalBusinessName = str(input.legalBusinessName, 'legalBusinessName', 160);
    if (input.businessAddress !== undefined) set.businessAddress = str(input.businessAddress, 'businessAddress', 300);
    if (input.bankName !== undefined) set.bankName = str(input.bankName, 'bankName', 100);
    if (input.contact) {
      for (const f of ['name', 'designation', 'email', 'phone'] as const) {
        if (input.contact[f] !== undefined) {
          const v = str(input.contact[f], `contact.${f}`, 120);
          if (f === 'email' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) bad('contact.email', 'Invalid email');
          set[`contact.${f}`] = v;
        }
      }
    }

    // sensitive fields: validate, then encrypt. With no key the whole request fails BEFORE anything is written.
    const sensitive: Array<['cnic' | 'ntn' | 'iban' | 'accountTitle', string | null | undefined]> = [['cnic', input.cnic], ['ntn', input.ntn], ['iban', input.iban], ['accountTitle', input.accountTitle]];
    const touching = sensitive.some(([, v]) => v !== undefined && v !== null && v !== '');
    if (touching) failClosed(() => this.crypto.assertReady());
    for (const [name, raw] of sensitive) {
      if (raw === undefined) continue;
      const aad = `${storeId}:${name}`;
      if (raw === null || raw === '') { set[`${name}Enc`] = null; if (name !== 'accountTitle') set[`${name}Last4`] = null; continue; }
      if (typeof raw !== 'string') bad(name, `${name} must be text`);
      let plain: string;
      if (name === 'cnic') { if (!isValidCnic(raw)) bad('cnic', 'CNIC must be 13 digits'); plain = normalizeCnic(raw); }
      else if (name === 'ntn') { if (!isValidNtn(raw)) bad('ntn', 'NTN must be 7–8 digits (or a 13-digit CNIC)'); plain = normalizeNtn(raw); }
      else if (name === 'iban') { if (!isValidPkIban(raw)) bad('iban', 'Invalid Pakistani IBAN'); plain = normalizeIban(raw); }
      else { const t = raw.trim(); if (!t || t.length > 120) bad('accountTitle', 'Account title is required (max 120 characters)'); plain = t; }
      set[`${name}Enc`] = failClosed(() => this.crypto.encrypt(plain, aad));
      if (name !== 'accountTitle') set[`${name}Last4`] = lastN(plain, 4);
    }

    const reopen = cur.status === 'rejected';
    const update: any = { $set: { ...set, ...(reopen ? { status: 'draft' } : {}) }, $push: { history: { action: reopen ? 'reopened' : 'draft_saved', note: null, actorId: sellerId, actorRole: 'owner', at: new Date() } } };
    const res = await this.model.findOneAndUpdate({ storeId, status: { $in: ['draft', 'rejected'] } }, update, { new: true }).lean();
    if (!res) throw new ConflictException({ code: KYB_LOCKED, message: 'This application can no longer be edited' });
    await this.audit.record(storeId, { type: 'owner', id: sellerId, ...actor }, reopen ? 'kyb_reopened' : 'kyb_draft_saved', { fields: Object.keys(set).map((k) => k.replace(/(Enc|Last4)$/, '')).filter((v, i, a) => a.indexOf(v) === i) });
    return this.view(res);
  }

  async uploadDocument(sellerId: string, storeId: string, type: string, file: Express.Multer.File | undefined, actor: { ip?: string; userAgent?: string } = {}) {
    await this.ownStoreOrThrow(sellerId, storeId);
    if (!KYB_DOCUMENT_TYPES.includes(type as KybDocumentType)) throw new BadRequestException({ code: 'KYB_INVALID_DOCUMENT_TYPE', message: 'Unknown document type' });
    if (!file) throw new BadRequestException({ code: 'KYB_FILE_REQUIRED', message: 'A file is required' });
    if (file.size > MAX_DOC_BYTES) throw new BadRequestException({ code: 'KYB_FILE_TOO_LARGE', message: 'Files can be at most 10 MB' });
    if (!ALLOWED_MIME.includes(file.mimetype)) throw new BadRequestException({ code: 'KYB_FILE_TYPE', message: 'Only PDF, JPEG or PNG files are accepted' });
    const cur = await this.ensureDoc(sellerId, storeId);
    if (!['draft', 'rejected'].includes(cur.status)) throw new ConflictException({ code: KYB_LOCKED, message: 'This application can no longer be edited' });

    const up = await this.upload.uploadPrivateFile(file, `private/kyb/${storeId}`);
    const doc = { type, publicId: up.publicId, resourceType: up.resourceType, fileName: file.originalname.slice(0, 160), mimeType: up.mimeType ?? file.mimetype, fileSize: up.fileSize ?? file.size, uploadedAt: new Date(), uploadedBy: sellerId };
    const reopen = cur.status === 'rejected';
    const old = (cur.documents ?? []).filter((d: any) => d.type === type);
    // one document per type: pull the old one and push the new in a single guarded update
    const res = await this.model.findOneAndUpdate(
      { storeId, status: { $in: ['draft', 'rejected'] } },
      { $pull: { documents: { type } }, ...(reopen ? { $set: { status: 'draft' } } : {}) },
      { new: true },
    ).lean();
    if (!res) { await this.upload.deletePrivateFile(up.publicId, up.resourceType).catch(() => undefined); throw new ConflictException({ code: KYB_LOCKED, message: 'This application can no longer be edited' }); }
    const res2: any = await this.model.findOneAndUpdate({ storeId }, { $push: { documents: doc, history: { action: 'document_uploaded', note: type, actorId: sellerId, actorRole: 'owner', at: new Date() } } }, { new: true }).lean();
    for (const o of old) await this.upload.deletePrivateFile(o.publicId, o.resourceType).catch(() => undefined); // best-effort cleanup of the replaced file
    const added = (res2.documents ?? []).find((d: any) => d.publicId === up.publicId);
    await this.audit.record(storeId, { type: 'owner', id: sellerId, ...actor }, 'kyb_document_uploaded', { type, fileName: doc.fileName, fileSize: doc.fileSize, replaced: old.length }, { type: 'document', id: String(added?._id ?? '') });
    return this.view(res2);
  }

  async removeDocument(sellerId: string, storeId: string, docId: string, actor: { ip?: string; userAgent?: string } = {}) {
    await this.ownStoreOrThrow(sellerId, storeId);
    const cur: any = await this.ensureDoc(sellerId, storeId);
    if (!['draft', 'rejected'].includes(cur.status)) throw new ConflictException({ code: KYB_LOCKED, message: 'This application can no longer be edited' });
    const d = (cur.documents ?? []).find((x: any) => String(x._id) === docId);
    if (!d) throw new NotFoundException('Document not found');
    const res = await this.model.findOneAndUpdate({ storeId, status: { $in: ['draft', 'rejected'] } }, { $pull: { documents: { _id: d._id } }, $push: { history: { action: 'document_removed', note: d.type, actorId: sellerId, actorRole: 'owner', at: new Date() } } }, { new: true }).lean();
    if (!res) throw new ConflictException({ code: KYB_LOCKED, message: 'This application can no longer be edited' });
    await this.upload.deletePrivateFile(d.publicId, d.resourceType).catch(() => undefined);
    await this.audit.record(storeId, { type: 'owner', id: sellerId, ...actor }, 'kyb_document_removed', { type: d.type }, { type: 'document', id: docId });
    return this.view(res);
  }

  async submit(sellerId: string, storeId: string, actor: { ip?: string; userAgent?: string } = {}) {
    await this.ownStoreOrThrow(sellerId, storeId);
    const cur: any = await this.ensureDoc(sellerId, storeId);
    if (cur.status !== 'draft') throw new ConflictException({ code: cur.status === 'rejected' ? 'KYB_REJECTED_EDIT_FIRST' : KYB_LOCKED, message: cur.status === 'rejected' ? 'Update the application before submitting it again' : 'This application was already submitted' });
    const req = getKybRequirements((cur.businessType as KybBusinessType) ?? null);
    const present: Record<string, boolean> = {
      businessType: !!cur.businessType, legalBusinessName: !!cur.legalBusinessName, businessAddress: !!cur.businessAddress,
      'contact.name': !!cur.contact?.name, 'contact.email': !!cur.contact?.email, 'contact.phone': !!cur.contact?.phone,
      cnic: !!cur.cnicEnc, ntn: !!cur.ntnEnc, bankName: !!cur.bankName, accountTitle: !!cur.accountTitleEnc, iban: !!cur.ibanEnc,
    };
    const have = new Set((cur.documents ?? []).map((d: any) => d.type));
    const missingFields = req.requiredFields.filter((f) => !present[f]);
    const missingDocuments = req.requiredDocuments.filter((t) => !have.has(t));
    if (missingFields.length || missingDocuments.length) throw new BadRequestException({ code: 'KYB_INCOMPLETE', message: 'The application is not complete', missingFields, missingDocuments });
    const res = await this.model.findOneAndUpdate(
      { storeId, status: 'draft' },
      { $set: { status: 'submitted', submittedAt: new Date(), rejectionReason: null }, $push: { history: { action: 'submitted', note: null, actorId: sellerId, actorRole: 'owner', at: new Date() } } },
      { new: true },
    ).lean();
    if (!res) throw new ConflictException({ code: KYB_LOCKED, message: 'This application was already submitted' });
    await this.audit.record(storeId, { type: 'owner', id: sellerId, ...actor }, 'kyb_submitted', { documents: (cur.documents ?? []).length });
    return this.view(res);
  }
}
