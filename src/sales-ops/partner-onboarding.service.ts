/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { solvexoEmail } from '../notifications/templates/notification-email.template';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../otp/services/email.service';
import { UploadService } from '../upload/upload.service';
import { assertKycDocument } from '../upload/upload-file-validation';
import { AdminTeamService } from '../admin-team/admin-team.service';
import { superadminAppUrl } from '../common/app-urls.util';
import { SalesCaptureService } from './sales-capture.service';
import { SalesPartner, SalesPartnerDocument } from './schemas/sales-partner.schema';
import { SalesPartnerReferral, SalesPartnerReferralDocument } from './schemas/sales-partner-referral.schema';
import { PartnerProgrammeSettings, PartnerProgrammeSettingsDocument } from './schemas/partner-programme-settings.schema';
import { PartnerDeal, PartnerDealDocument } from './schemas/partner-deal.schema';
import { PartnerLog, PartnerLogDocument } from './schemas/partner-log.schema';
import {
  CHECKLIST, type ChecklistKey, DEFAULT_PROGRAMME_SETTINGS, ENTITY_TYPES, type EntityType, PARTNER_DOC_LABELS, PARTNER_DOC_TYPES,
  PARTNER_MODELS, PARTNER_TIERS, type PartnerDocType, type PartnerStage, type ProgrammeSettings, RESELLER_MODES,
  agreementDates, buildChecklist, docProgress, mergeSettings, nextStage,
} from './partner-programme.util';
import type { SalesActor } from './sales-ops.util';

const isId = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
const clean = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ADMIN_APP = () => superadminAppUrl().replace(/\/$/, '');

export interface PartnerApplicationInput {
  entityType?: string;
  model?: string;
  contactName?: string;
  contactRole?: string;
  legalName?: string;
  email?: string;
  phone?: string;
  city?: string;
  registrationNo?: string;
  ntn?: string;
  address?: string;
  teamSize?: number | string;
  salesContact?: string;
  supportContact?: string;
  website?: string;
  claimedPartnerships?: string;
  segments?: string;
  plan90?: string;
  heardFrom?: string;
  message?: string;
  references?: { name?: string; company?: string; phone?: string; email?: string }[];
  consent?: boolean;
}

export interface PartnerProfileInput {
  model?: string | null;
  resellerMode?: string | null;
  tier?: string | null;
  territory?: string | null;
  exclusive?: boolean;
  exclusiveFrom?: string | null;
  exclusiveUntil?: string | null;
  houseAccounts?: string[];
}

/**
 * Channel Partner Programme, part 1: applying, vetting (B12 documents, references), approval, the agreement and the
 * 30-day onboarding checklist. Commission itself stays in SalesPartnersService: a partner starts earning when the
 * agreement is signed (status → active).
 */
@Injectable()
export class PartnerOnboardingService {
  private readonly logger = new Logger(PartnerOnboardingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly upload: UploadService,
    private readonly team: AdminTeamService,
    private readonly capture: SalesCaptureService,
    @InjectModel(SalesPartner.name) private readonly partners: Model<SalesPartnerDocument>,
    @InjectModel(SalesPartnerReferral.name) private readonly referrals: Model<SalesPartnerReferralDocument>,
    @InjectModel(PartnerProgrammeSettings.name) private readonly settingsModel: Model<PartnerProgrammeSettingsDocument>,
    @InjectModel(PartnerDeal.name) private readonly deals: Model<PartnerDealDocument>,
    @InjectModel(PartnerLog.name) private readonly logs: Model<PartnerLogDocument>,
  ) {}

  // ── Settings ─────────────────────────────────────────────────────────────

  async settings(): Promise<ProgrammeSettings> {
    const doc: any = await this.settingsModel.findOne({ key: 'default' }).lean();
    const v = (doc?.values ?? {}) as Partial<ProgrammeSettings>;
    const base = DEFAULT_PROGRAMME_SETTINGS;
    return {
      ...base, ...v,
      tiers: base.tiers.map((t) => ({ ...t, ...(v.tiers ?? []).find((x) => x.key === t.key) })),
      approvedKeys: v.approvedKeys ?? [],
    };
  }

  async getSettings() {
    return { success: true, data: await this.settings() };
  }

  async saveSettings(actor: SalesActor, input: Partial<ProgrammeSettings>) {
    let next: ProgrammeSettings;
    try { next = mergeSettings(await this.settings(), input ?? {}); } catch (e: any) { throw new BadRequestException(e.message); }
    await this.settingsModel.updateOne({ key: 'default' }, { $set: { values: next, updatedBy: actor.adminId } }, { upsert: true });
    return { success: true, message: 'Programme settings saved', data: next };
  }

  // ── Public application ───────────────────────────────────────────────────

  async apply(input: PartnerApplicationInput, ip?: string) {
    const entityType = (ENTITY_TYPES as readonly string[]).includes(input.entityType ?? '') ? (input.entityType as EntityType) : null;
    if (!entityType) throw new BadRequestException('Choose business or individual.');
    const contactName = clean(input.contactName, 120);
    if (!contactName) throw new BadRequestException('Enter your name.');
    const email = clean(input.email, 160)?.toLowerCase() ?? null;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BadRequestException('Enter a valid email address.');
    const phone = clean(input.phone, 40);
    if (!phone || phone.replace(/\D/g, '').length < 10) throw new BadRequestException('Enter a mobile number we can call or WhatsApp.');
    const city = clean(input.city, 80);
    if (!city) throw new BadRequestException('Enter your city.');
    const legalName = clean(input.legalName, 160);
    if (entityType === 'business' && !legalName) throw new BadRequestException('Enter the registered business name.');
    if (input.consent !== true) throw new BadRequestException('Please agree to be contacted about the partner programme.');
    const model = entityType === 'individual' ? 'referral' : (['reseller', 'service'].includes(input.model ?? '') ? input.model! : 'reseller');
    const refs = (Array.isArray(input.references) ? input.references : []).slice(0, 3)
      .map((r) => ({ name: clean(r?.name, 120), company: clean(r?.company, 120), phone: clean(r?.phone, 40), email: clean(r?.email, 160) }))
      .filter((r) => r.name && (r.phone || r.email));
    const teamSize = input.teamSize === undefined || input.teamSize === '' ? null : Math.max(0, Math.min(100000, Math.round(Number(input.teamSize)) || 0));

    // One open application per email: a second submission does not create a duplicate.
    const open: any = await this.partners.findOne({ email, stage: { $nin: ['rejected', null] } }).select('_id').lean();
    const thanks = { success: true, message: 'Thank you. We have your application and will contact you within 2 working days.' };
    if (open) return thanks;

    const name = (entityType === 'business' ? legalName : contactName)!;
    const doc: any = await this.partners.create({
      name, kind: entityType === 'business' ? 'reseller' : 'agent', code: await this.freeCode(name), status: 'paused',
      email, phone, city, stage: 'applied', entityType, partnerModel: model, tier: 'registered', appliedAt: new Date(),
      application: {
        contactName, contactRole: clean(input.contactRole, 80), legalName, registrationNo: clean(input.registrationNo, 60),
        ntn: clean(input.ntn, 40), address: clean(input.address, 300), teamSize, salesContact: clean(input.salesContact, 160),
        supportContact: clean(input.supportContact, 160), website: clean(input.website, 200),
        claimedPartnerships: clean(input.claimedPartnerships, 300), segments: clean(input.segments, 500), plan90: clean(input.plan90, 2000),
        heardFrom: clean(input.heardFrom, 120), message: clean(input.message, 2000), references: refs, consentAt: new Date(), ip: ip ?? null,
      },
    });
    void this.capture.notifyManagers('New partner application', `${name} (${city}) applied to the partner programme.`, null);
    void this.email.sendMail(email, 'We received your Solvexo partner application', this.mail(
      `Thank you, ${contactName}`,
      `<p>We have your application to become a Solvexo partner${entityType === 'business' ? ` for <strong>${esc(name)}</strong>` : ''}.</p>
       <p>Our team will contact you within 2 working days. If we take it forward, you will get a login to upload your documents and follow your onboarding.</p>`,
    )).catch(() => false);
    this.logger.log(`Partner application ${String(doc._id)} from ${city}`);
    return thanks;
  }

  // ── Manager actions ──────────────────────────────────────────────────────

  /** Applications and onboarding at a glance, with checklist progress and what needs attention. */
  async board() {
    const rows: any[] = await this.partners.find({}).sort({ appliedAt: -1, createdAt: -1 }).lean();
    const s = await this.settings();
    const out: any[] = [];
    for (const p of rows) {
      const view = await this.onboardingView(p, s, true);
      out.push({
        _id: String(p._id), name: p.name, city: p.city ?? null, entityType: p.entityType ?? null, model: p.partnerModel ?? null,
        tier: p.tier ?? null, territory: p.territory ?? null, stage: view.stage, appliedAt: p.appliedAt ?? null,
        docs: { required: view.docs.required.length, verified: view.docs.verified.length, waiting: view.documents.filter((d: any) => d.status === 'pending').length },
        checklist: { done: view.checklist.filter((c: any) => c.done).length, total: view.checklist.length, overdue: view.checklist.filter((c: any) => c.overdue).length },
        pilotEndsAt: view.agreement?.pilotEndsAt ?? null, noticeBy: view.agreement?.noticeBy ?? null,
        attention: view.attention,
      });
    }
    return { success: true, data: out };
  }

  async detail(id: string) {
    const p = await this.find(id);
    return { success: true, data: await this.onboardingView(p, await this.settings(), true) };
  }

  /** First look passed: give the applicant a partner login so they can upload documents. */
  async invite(actor: SalesActor, id: string) {
    const p = await this.find(id);
    if (p.stage === 'rejected') throw new BadRequestException('Reopen the application first.');
    if (!p.email) throw new BadRequestException('Add the partner’s email first.');
    let adminId = p.adminId as string | null;
    let inviteUrl: string | undefined;
    if (!adminId) {
      const existing: any = await this.db.repositories.adminModel.findOne({ email: p.email, isDelete: { $ne: true } }).select('_id').lean();
      if (existing) {
        const taken: any = await this.partners.findOne({ adminId: String(existing._id), _id: { $ne: p._id } }).select('name').lean();
        if (taken) throw new ConflictException(`That email’s login already belongs to partner ${taken.name}.`);
        adminId = String(existing._id);
      } else {
        const role: any = await this.db.repositories.adminRoleModel.findOne({ presetKey: 'partner', isDelete: false }).select('_id').lean();
        if (!role) throw new BadRequestException('The Partner role is missing. Open Admin team once so the preset roles are created.');
        // The Partner role only grants partner.portal (their own data), so a sales manager may hand it out.
        const res: any = await this.team.invite({ userId: actor.adminId }, {
          name: p.application?.contactName || p.name, email: p.email, roleId: String(role._id),
        });
        adminId = res.data?._id ?? null;
        inviteUrl = res.inviteUrl;
      }
    }
    await this.partners.updateOne({ _id: p._id }, { $set: { adminId, invitedAt: p.invitedAt ?? new Date() } });
    await this.refreshStage(String(p._id));
    return { success: true, message: 'Partner login created. They can now upload their documents.', ...(inviteUrl ? { inviteUrl } : {}), data: (await this.detail(id)).data };
  }

  async reject(actor: SalesActor, id: string, reason: string) {
    const why = clean(reason, 1000);
    if (!why) throw new BadRequestException('Give the reason (it is sent to the applicant).');
    const p = await this.find(id);
    await this.partners.updateOne({ _id: p._id }, { $set: { stage: 'rejected', rejectReason: why, rejectedAt: new Date(), status: 'paused' } });
    if (p.email) void this.email.sendMail(p.email, 'Your Solvexo partner application', this.mail(
      `Thank you for your interest, ${p.application?.contactName || p.name}`,
      `<p>We are not taking your partner application forward at this time.</p><p><strong>Reason:</strong> ${esc(why)}</p><p>You are welcome to reply to this email with any questions.</p>`,
    )).catch(() => false);
    this.logger.log(`Partner ${id} rejected by ${actor.adminId}`);
    return this.detail(id);
  }

  async reopen(id: string) {
    const p = await this.find(id);
    if (p.stage !== 'rejected') throw new BadRequestException('Only a rejected application can be reopened.');
    await this.partners.updateOne({ _id: p._id }, { $set: { stage: 'applied', rejectReason: null, rejectedAt: null } });
    await this.refreshStage(id);
    return this.detail(id);
  }

  async updateProfile(id: string, input: PartnerProfileInput) {
    const p = await this.find(id);
    const set: Record<string, unknown> = {};
    const pick = (k: keyof PartnerProfileInput, allowed: readonly string[]) => {
      if (!(k in input)) return;
      const v = input[k] as string | null;
      if (v !== null && v !== '' && !allowed.includes(v)) throw new BadRequestException(`Unknown ${k}.`);
      set[k === 'model' ? 'partnerModel' : k] = v || null;
    };
    pick('model', PARTNER_MODELS);
    pick('resellerMode', RESELLER_MODES);
    pick('tier', PARTNER_TIERS);
    // B3: a partner moves down a tier only after a written warning and 60 days to recover.
    const rank = (t: string | null | undefined) => (PARTNER_TIERS as readonly string[]).indexOf(t ?? 'registered');
    if ('tier' in input && rank(set.tier as string | null) < rank(p.tier)) {
      const warned: any = await this.logs.findOne({ partnerId: String(p._id), type: { $in: ['warning', 'improvement_plan'] }, at: { $lte: new Date(Date.now() - 60 * 86_400_000) } }).select('_id').lean();
      if (!warned) throw new BadRequestException('A partner moves down a tier only after a written warning and 60 days to recover (B3). Give a warning first.');
    }
    if ('territory' in input) set.territory = clean(input.territory, 160);
    if ('exclusive' in input) set.exclusive = input.exclusive === true;
    for (const k of ['exclusiveFrom', 'exclusiveUntil'] as const) {
      if (!(k in input)) continue;
      const d = input[k] ? new Date(input[k]!) : null;
      if (d && isNaN(d.getTime())) throw new BadRequestException(`${k} is not a date.`);
      set[k] = d;
    }
    if ('houseAccounts' in input) set.houseAccounts = (input.houseAccounts ?? []).map((x) => clean(x, 160)).filter(Boolean).slice(0, 500);
    const exclusive = set.exclusive ?? p.exclusive;
    if (exclusive && !(set.territory ?? p.territory)) throw new BadRequestException('Exclusivity needs a territory.');
    await this.partners.updateOne({ _id: p._id }, { $set: set });
    return this.detail(id);
  }

  async approve(actor: SalesActor, id: string) {
    const p = await this.find(id);
    const s = await this.settings();
    const v = await this.onboardingView(p, s, true);
    if (!v.docs.allVerified) throw new BadRequestException(`Verify every required document first (${v.docs.required.length - v.docs.verified.length} left).`);
    if (p.entityType === 'business' && !p.checklist?.references_checked) throw new BadRequestException('Tick “References and claimed partnerships checked” first.');
    await this.partners.updateOne({ _id: p._id }, { $set: { approvedAt: new Date(), approvedBy: actor.adminId, tier: p.tier ?? 'registered' } });
    await this.refreshStage(id);
    return this.detail(id);
  }

  /** The agreement is signed: dates follow the programme settings, and the partner starts earning. */
  async signAgreement(actor: SalesActor, id: string, input: { signedAt?: string; version?: string; entity?: string; note?: string }) {
    const p = await this.find(id);
    if (!p.approvedAt) throw new BadRequestException('Approve the partner before recording the agreement.');
    const signedAt = input.signedAt ? new Date(input.signedAt) : new Date();
    if (isNaN(signedAt.getTime()) || signedAt.getTime() > Date.now() + 86_400_000) throw new BadRequestException('Enter the date it was signed.');
    const s = await this.settings();
    const dates = agreementDates(signedAt, s);
    const agreement = {
      version: clean(input.version, 20) ?? s.agreementVersion, entity: clean(input.entity, 120) ?? s.signingEntity, signedAt,
      ...dates, note: clean(input.note, 1000),
    };
    await this.partners.updateOne({ _id: p._id }, { $set: { agreement, status: 'active' } });
    await this.refreshStage(id);
    this.logger.log(`Partner ${id} agreement recorded by ${actor.adminId}`);
    return this.detail(id);
  }

  async tick(actor: SalesActor, id: string, key: string, done: boolean) {
    const def = CHECKLIST.find((c) => c.key === key);
    if (!def) throw new BadRequestException('Unknown checklist item.');
    if (def.auto) throw new BadRequestException('This item ticks itself from real data.');
    const p = await this.find(id);
    await this.partners.updateOne({ _id: p._id }, { $set: { [`checklist.${key}`]: done ? { at: new Date(), by: actor.adminId } : null } });
    await this.refreshStage(id);
    return this.detail(id);
  }

  async saveStaff(id: string, staff: { name?: string; phone?: string; email?: string; certified?: boolean; certifiedAt?: string | null }[], actor: SalesActor) {
    const p = await this.find(id);
    const prev = new Map((p.staff ?? []).map((x: any) => [`${x.name}|${x.phone ?? ''}`, x]));
    const next = (staff ?? []).slice(0, 100).map((x) => {
      const name = clean(x.name, 120);
      if (!name) throw new BadRequestException('Each salesperson needs a name.');
      const phone = clean(x.phone, 40);
      const old: any = prev.get(`${name}|${phone ?? ''}`);
      const certifiedAt = x.certified ? (old?.certifiedAt ?? (x.certifiedAt ? new Date(x.certifiedAt) : new Date())) : null;
      return { name, phone, email: clean(x.email, 160), certifiedAt, certifiedBy: certifiedAt ? (old?.certifiedBy ?? actor.adminId) : null };
    });
    await this.partners.updateOne({ _id: p._id }, { $set: { staff: next } });
    await this.refreshStage(id);
    return this.detail(id);
  }

  /** Demo stores (not for resale): store ids or store addresses (slug). */
  async setDemoStores(id: string, refs: string[]) {
    const p = await this.find(id);
    const wanted = [...new Set((refs ?? []).map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean))].slice(0, 20);
    const stores: any[] = wanted.length ? await this.db.repositories.storeModel
      .find({ isDelete: { $ne: true }, $or: [{ _id: { $in: wanted.filter(isId) } }, { slug: { $in: wanted } }] }).select('_id slug').lean() : [];
    const found = new Set(stores.flatMap((x) => [String(x._id), String(x.slug).toLowerCase()]));
    const missing = wanted.filter((w) => !found.has(w));
    if (missing.length) throw new BadRequestException(`Store not found: ${missing.join(', ')}`);
    await this.partners.updateOne({ _id: p._id }, { $set: { demoStoreIds: stores.map((x) => String(x._id)) } });
    await this.refreshStage(id);
    return this.detail(id);
  }

  // ── Documents ────────────────────────────────────────────────────────────

  async uploadDoc(id: string, type: string, file: Express.Multer.File | undefined, by: { adminId: string; role: 'manager' | 'partner' }) {
    if (!(PARTNER_DOC_TYPES as readonly string[]).includes(type)) throw new BadRequestException('Unknown document type.');
    if (type === 'agreement' && by.role !== 'manager') throw new ForbiddenException('Solvexo uploads the signed agreement.');
    if (!file?.buffer) throw new BadRequestException('Choose a file.');
    assertKycDocument(file);
    const p = await this.find(id);
    if (p.stage === 'rejected' && by.role === 'partner') throw new ForbiddenException('This application is closed.');
    const up = await this.upload.uploadPrivateFile(file, `private/partners/${id}`);
    const doc = {
      type, publicId: up.publicId, resourceType: up.resourceType, fileName: (file.originalname || 'document').slice(0, 160),
      mimeType: up.mimeType ?? file.mimetype, fileSize: up.fileSize ?? file.size, uploadedAt: new Date(), uploadedBy: by.adminId,
      uploadedByRole: by.role, status: by.role === 'manager' && type === 'agreement' ? 'verified' : 'pending',
    };
    await this.partners.updateOne({ _id: p._id }, { $push: { documents: doc } });
    await this.refreshStage(id);
    const req = docProgress((p.entityType ?? 'business') as EntityType, [...(p.documents ?? []), doc], { claimsPartnership: !!p.application?.claimedPartnerships });
    if (by.role === 'partner' && req.allUploaded) void this.capture.notifyManagers('Partner documents ready to check', `${p.name} has uploaded every required document.`, null);
    return { success: true, message: 'Document uploaded' };
  }

  async reviewDoc(actor: SalesActor, id: string, docId: string, status: 'verified' | 'rejected', note?: string) {
    if (!['verified', 'rejected'].includes(status)) throw new BadRequestException('Choose verified or rejected.');
    const why = clean(note, 500);
    if (status === 'rejected' && !why) throw new BadRequestException('Say what is wrong so the partner can fix it.');
    const p = await this.find(id);
    const d = (p.documents ?? []).find((x: any) => String(x._id) === docId);
    if (!d) throw new NotFoundException('Document not found.');
    await this.partners.updateOne({ _id: p._id, 'documents._id': d._id }, {
      $set: { 'documents.$.status': status, 'documents.$.reviewNote': why, 'documents.$.reviewedAt': new Date(), 'documents.$.reviewedBy': actor.adminId },
    });
    if (status === 'rejected' && p.email) void this.email.sendMail(p.email, 'A partner document needs replacing', this.mail(
      'Please upload this document again',
      `<p><strong>${esc(PARTNER_DOC_LABELS[d.type as PartnerDocType] ?? d.type)}</strong></p><p>${esc(why!)}</p>
       <p><a href="${ADMIN_APP()}/admin/earnings">Open your partner page</a> to upload a new copy.</p>`,
    )).catch(() => false);
    await this.refreshStage(id);
    return this.detail(id);
  }

  async docUrl(id: string, docId: string, partnerAdminId?: string) {
    const p = await this.find(id);
    if (partnerAdminId && p.adminId !== partnerAdminId) throw new ForbiddenException();
    const d = (p.documents ?? []).find((x: any) => String(x._id) === docId);
    if (!d) throw new NotFoundException('Document not found.');
    return { success: true, data: { url: this.upload.generateExpiringPrivateUrl(d.publicId, d.resourceType, 300, { inline: true }), fileName: d.fileName, expiresInSeconds: 300 } };
  }

  // ── The partner's own onboarding page ────────────────────────────────────

  async mine(actor: SalesActor) {
    const p: any = await this.partners.findOne({ adminId: actor.adminId }).lean();
    if (!p) return { success: true, data: null };
    return { success: true, data: await this.onboardingView(p, await this.settings(), false) };
  }

  async uploadMine(actor: SalesActor, type: string, file: Express.Multer.File | undefined) {
    const p: any = await this.partners.findOne({ adminId: actor.adminId }).select('_id').lean();
    if (!p) throw new ForbiddenException('You are not set up as a partner.');
    return this.uploadDoc(String(p._id), type, file, { adminId: actor.adminId, role: 'partner' });
  }

  async myDocUrl(actor: SalesActor, docId: string) {
    const p: any = await this.partners.findOne({ adminId: actor.adminId }).select('_id').lean();
    if (!p) throw new ForbiddenException('You are not set up as a partner.');
    return this.docUrl(String(p._id), docId, actor.adminId);
  }

  // ── Daily: stages, and what needs a manager ──────────────────────────────

  @Cron('45 5 * * *')
  async dailyJob() {
    await this.redis.withLock('partner-onboarding-daily', 600_000, async () => {
      const rows: any[] = await this.partners.find({ stage: { $in: ['documents', 'review', 'agreement', 'onboarding', 'live'] } }).select('_id').lean();
      for (const r of rows) await this.refreshStage(String(r._id)).catch((e) => this.logger.warn(`stage ${String(r._id)}: ${e?.message}`));
      const board: any[] = (await this.board()).data;
      const due = board.filter((b) => b.attention.length);
      if (due.length) {
        void this.capture.notifyManagers(
          'Partner onboarding needs attention',
          due.slice(0, 5).map((b) => `${b.name}: ${b.attention.join('; ')}`).join(' · ') + (due.length > 5 ? ` · and ${due.length - 5} more` : ''),
          null,
        );
      }
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Recomputes the stage from the facts; never moves a rejected or pre-programme partner. */
  async refreshStage(id: string) {
    const p: any = await this.partners.findById(id).lean();
    if (!p || !p.stage || p.stage === 'rejected') return;
    const view = await this.onboardingView(p, await this.settings(), true);
    if (view.stage !== p.stage) await this.partners.updateOne({ _id: p._id }, { $set: { stage: view.stage } });
  }

  private async facts(p: any) {
    const id = String(p._id);
    const refs: any[] = await this.referrals.find({ partnerId: id }).select('sellerId createdAt').sort({ createdAt: 1 }).lean();
    // Prospects: deal registrations (B7) plus sellers who signed up through the partner.
    const firstDeal: any = await this.deals.findOne({ partnerId: id }).sort({ submittedAt: 1 }).select('submittedAt').lean();
    const dealCount = await this.deals.countDocuments({ partnerId: id });
    const r = this.db.repositories;
    let liveSellers = 0;
    if (refs.length) {
      const stores: any[] = await r.storeModel.find({ sellerId: { $in: refs.map((x) => x.sellerId) }, isDelete: { $ne: true }, status: 'active' }).select('_id sellerId').lean();
      if (stores.length) {
        const counts: any[] = await r.productModel.aggregate([
          { $match: { storeId: { $in: stores.map((s) => String(s._id)) }, isDelete: false, status: 'active' } },
          { $group: { _id: '$storeId', n: { $sum: 1 } } },
        ]);
        const liveStore = new Set(counts.filter((c) => c.n >= 5).map((c) => String(c._id)));
        liveSellers = new Set(stores.filter((s) => liveStore.has(String(s._id))).map((s) => String(s.sellerId))).size;
      }
    }
    let loginActivatedAt: Date | null = null;
    if (p.adminId && isId(p.adminId)) {
      const a: any = await r.adminModel.findById(p.adminId).select('inviteAcceptedAt isVerified createdAt').lean();
      loginActivatedAt = a?.inviteAcceptedAt ?? (a?.isVerified ? a.createdAt : null) ?? null;
    }
    const firstProspectAt = [firstDeal?.submittedAt, refs[0]?.createdAt].filter(Boolean).map((d) => new Date(d)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    return { refs, liveSellers, loginActivatedAt, prospects: refs.length + dealCount, firstProspectAt };
  }

  private async onboardingView(p: any, s: ProgrammeSettings, forManager: boolean) {
    const entityType = (p.entityType ?? 'business') as EntityType;
    const docs = docProgress(entityType, (p.documents ?? []).filter((d: any) => d.type !== 'agreement'), { claimsPartnership: !!p.application?.claimedPartnerships });
    const f = await this.facts(p);
    const manual: Partial<Record<ChecklistKey, Date | null>> = {};
    for (const [k, v] of Object.entries(p.checklist ?? {})) manual[k as ChecklistKey] = (v as any)?.at ?? null;
    const signedAt = p.agreement?.signedAt ? new Date(p.agreement.signedAt) : null;
    const checklist = buildChecklist({
      entityType, stage: (p.stage ?? 'live') as PartnerStage, appliedAt: p.appliedAt ?? null, approvedAt: p.approvedAt ?? null,
      docsAllVerified: docs.allVerified, agreementSignedAt: signedAt, loginActivatedAt: f.loginActivatedAt,
      demoStores: (p.demoStoreIds ?? []).length, certifiedStaff: (p.staff ?? []).filter((x: any) => x.certifiedAt).length,
      prospects: f.prospects, firstProspectAt: f.firstProspectAt, liveSellers: f.liveSellers, firstLiveAt: null, manual,
    });
    const onboardingDone = checklist.filter((c) => c.week > 0).every((c) => c.done);
    const stage: PartnerStage = !p.stage ? 'live' : nextStage(p.stage as PartnerStage, {
      firstLookPassed: !!p.invitedAt, docsAllUploaded: docs.allUploaded, approved: !!p.approvedAt, agreementSigned: !!signedAt, onboardingComplete: onboardingDone,
    });
    const now = Date.now();
    const attention: string[] = [];
    if (stage === 'applied' && p.appliedAt && now - new Date(p.appliedAt).getTime() > 2 * 86_400_000) attention.push('application waiting more than 2 days');
    const waiting = (p.documents ?? []).filter((d: any) => d.status === 'pending').length;
    if (waiting) attention.push(`${waiting} document${waiting === 1 ? '' : 's'} to check`);
    const overdue = checklist.filter((c) => c.overdue).length;
    if (overdue) attention.push(`${overdue} onboarding item${overdue === 1 ? '' : 's'} overdue`);
    const pilotEnds = p.agreement?.pilotEndsAt ? new Date(p.agreement.pilotEndsAt).getTime() : null;
    if (pilotEnds && pilotEnds > now && pilotEnds - now < 14 * 86_400_000) attention.push('pilot review due within 14 days');
    const noticeBy = p.agreement?.noticeBy ? new Date(p.agreement.noticeBy).getTime() : null;
    if (noticeBy && noticeBy > now && noticeBy - now < 30 * 86_400_000) attention.push('renewal notice date within 30 days');
    const tierRule = s.tiers.find((t) => t.key === (p.tier ?? 'registered')) ?? null;
    const demoStores: any[] = (p.demoStoreIds ?? []).length
      ? await this.db.repositories.storeModel.find({ _id: { $in: p.demoStoreIds.filter(isId) } }).select('name slug').lean() : [];

    return {
      _id: String(p._id), name: p.name, code: p.code, email: p.email ?? null, phone: p.phone ?? null, city: p.city ?? null,
      status: p.status, stage, entityType, model: p.partnerModel ?? null, resellerMode: p.resellerMode ?? null, tier: p.tier ?? null,
      tierRule: tierRule ? { ...tierRule, commissionApproved: s.approvedKeys.includes('tiers') } : null,
      territory: p.territory ?? null, exclusive: !!p.exclusive, exclusiveFrom: p.exclusiveFrom ?? null, exclusiveUntil: p.exclusiveUntil ?? null,
      houseAccounts: forManager ? (p.houseAccounts ?? []) : undefined,
      application: forManager ? (p.application ?? null) : undefined,
      appliedAt: p.appliedAt ?? null, invitedAt: p.invitedAt ?? null, approvedAt: p.approvedAt ?? null,
      rejectedAt: p.rejectedAt ?? null, rejectReason: p.rejectReason ?? null, hasLogin: !!p.adminId, loginActivatedAt: f.loginActivatedAt,
      docs: { ...docs, labels: PARTNER_DOC_LABELS },
      documents: (p.documents ?? []).map((d: any) => ({
        _id: String(d._id), type: d.type, label: PARTNER_DOC_LABELS[d.type as PartnerDocType] ?? d.type, fileName: d.fileName,
        uploadedAt: d.uploadedAt, uploadedByRole: d.uploadedByRole, status: d.status, reviewNote: d.reviewNote ?? null, reviewedAt: d.reviewedAt ?? null,
      })),
      agreement: p.agreement ?? null,
      staff: (p.staff ?? []).map((x: any) => ({ name: x.name, phone: x.phone ?? null, email: x.email ?? null, certifiedAt: x.certifiedAt ?? null })),
      demoStores: demoStores.map((x) => ({ _id: String(x._id), name: x.name, slug: x.slug })),
      checklist,
      facts: { prospects: f.prospects, liveSellers: f.liveSellers },
      attention: forManager ? attention : [],
    };
  }

  private async find(id: string): Promise<any> {
    if (!isId(id)) throw new NotFoundException('Partner not found.');
    const p = await this.partners.findById(id).lean();
    if (!p) throw new NotFoundException('Partner not found.');
    return p;
  }

  private async freeCode(name: string) {
    const base = name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'P';
    for (let i = 0; i < 20; i++) {
      const code = `${base}${Math.floor(100 + Math.random() * 900)}`;
      if (!(await this.partners.exists({ code }))) return code;
    }
    return `${base}${Date.now().toString(36).toUpperCase()}`;
  }

  private mail(title: string, body: string) {
    return solvexoEmail(title, body, { note: 'Solvexo Channel Partner Programme · solvexo.store' });
  }
}
