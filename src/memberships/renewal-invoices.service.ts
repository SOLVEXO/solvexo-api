import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { assertFileSignature } from '../upload/upload-file-validation';
import { DigitalMailerService } from '../digital-access/digital-mailer.service';
import { AccessPlan, AccessPlanDocument, MemberSubscription, MemberSubscriptionDocument } from './membership.schema';
import { OPEN_INVOICE, RenewalInvoice, RenewalInvoiceDocument } from './renewal-invoice.schema';
import { MembershipsService } from './memberships.service';

const DAY = 86_400_000;
export const INVOICE_WINDOW_DAYS = 7;
export const FIRST_PAYMENT_DAYS = 3;
export const MAX_PROOF_SUBMISSIONS = 5;
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const PROOF_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const PROOF_EXT = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
const PROOF_URL_SECONDS = 300;
const MANUAL_REMIND_GAP_MS = 12 * 3_600_000;

const audit = (action: string, by: string, note = '') => ({ at: new Date(), action, by, note });

export interface Pg { page: number; limit: number; skip: number }

@Injectable()
export class RenewalInvoicesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly upload: UploadService,
    private readonly memberships: MembershipsService,
    @InjectModel(RenewalInvoice.name) readonly invoiceModel: Model<RenewalInvoiceDocument>,
    @InjectModel(MemberSubscription.name) private readonly subModel: Model<MemberSubscriptionDocument>,
    @InjectModel(AccessPlan.name) private readonly planModel: Model<AccessPlanDocument>,
    @Optional() private readonly mailer?: DigitalMailerService,
  ) {}

  // ---------------- instructions (the seller's own payment details) ----------------

  /** Bank / JazzCash / EasyPaisa details of the store's Bank Transfer integration + its custom manual methods. */
  async snapshotInstructions(storeId: string): Promise<{ label: string; details: string }[]> {
    const r: any = this.db.repositories;
    const out: { label: string; details: string }[] = [];
    const bank: any = await r.storeIntegrationModel.findOne({ storeId, type: 'payment', provider: 'bank_transfer' }).lean();
    const c = bank?.config ?? {};
    const lines = (...pairs: [string, any][]) => pairs.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
    const bankText = lines(['Bank', c.bankName], ['Account title', c.accountTitle], ['Account number', c.accountNumber], ['IBAN', c.iban]);
    if (bankText) out.push({ label: 'Bank transfer', details: bankText });
    if (c.jazzcashNumber) out.push({ label: 'JazzCash', details: `Number: ${c.jazzcashNumber}${c.accountTitle ? `\nAccount title: ${c.accountTitle}` : ''}` });
    if (c.easypaisaNumber) out.push({ label: 'EasyPaisa', details: `Number: ${c.easypaisaNumber}${c.accountTitle ? `\nAccount title: ${c.accountTitle}` : ''}` });
    if (c.instructions) out.push({ label: 'Instructions', details: String(c.instructions).slice(0, 2000) });
    const custom: any[] = await r.manualPaymentMethodModel.find({ storeId, isDelete: false, isActive: true }).sort({ sortOrder: 1 }).limit(10).lean();
    for (const m of custom) out.push({ label: String(m.name).slice(0, 60), details: String(m.instructions ?? '').slice(0, 2000) });
    return out;
  }

  // ---------------- invoice creation (job) ----------------

  /**
   * One invoice per manual membership per cycle: 7 days before the period ends (or right after joining a paid plan).
   * Idempotent: the unique (subscription, cycle) key means a re-run or a parallel worker creates nothing twice.
   */
  async ensureInvoices(now = new Date()): Promise<number> {
    const subs = await this.subModel.find({
      provider: { $ne: 'stripe' }, cancelAtPeriodEnd: false, status: { $in: ['trialing', 'active', 'past_due'] },
      $or: [{ awaitingFirstPayment: true }, { currentPeriodEnd: { $ne: null, $lte: new Date(now.getTime() + INVOICE_WINDOW_DAYS * DAY) } }],
    }).limit(500);
    let created = 0;
    for (const s of subs) {
      const first = s.awaitingFirstPayment || !s.currentPeriodEnd;
      const planId = !first && s.pendingPlanId ? s.pendingPlanId : s.planId;
      const plan: any = await this.planModel.findOne({ _id: planId, storeId: s.storeId }).lean();
      if (!plan || plan.type === 'free' || !(plan.amount > 0)) continue;
      if (!first && plan.type !== 'recurring') continue;
      if (!first && plan.fixedLength && s.periodsPaid >= plan.fixedLength) continue;
      const cycleKey = first ? 'first' : `renew:${(s.currentPeriodEnd as Date).toISOString().slice(0, 10)}`;
      const dueAt = first ? new Date((s as any).createdAt?.getTime?.() ? (s as any).createdAt.getTime() + FIRST_PAYMENT_DAYS * DAY : now.getTime() + FIRST_PAYMENT_DAYS * DAY) : (s.currentPeriodEnd as Date);
      const res = await this.invoiceModel.updateOne(
        { subscriptionId: String(s._id), cycleKey },
        { $setOnInsert: { storeId: s.storeId, customerId: s.customerId, planId: String(plan._id), amount: plan.amount, currency: plan.currency, dueAt, status: dueAt < now ? 'overdue' : 'awaiting', instructions: await this.snapshotInstructions(s.storeId), audit: [audit('created', 'system', cycleKey)] } },
        { upsert: true },
      );
      if (res.upsertedCount) created++;
    }
    return created;
  }

  /** awaiting -> overdue once the due date passed; invoices of ended memberships are voided. */
  async sweep(now = new Date()): Promise<{ overdue: number; voided: number }> {
    const o = await this.invoiceModel.updateMany({ status: 'awaiting', dueAt: { $lt: now } }, { $set: { status: 'overdue' }, $push: { audit: audit('overdue', 'system') } });
    const open = await this.invoiceModel.find({ status: { $in: OPEN_INVOICE } }).select('subscriptionId').limit(1000).lean();
    let voided = 0;
    for (const inv of open) {
      const s = await this.subModel.findOne({ _id: inv.subscriptionId }).select('status').lean();
      if (!s || ['cancelled', 'expired'].includes(s.status)) {
        const r = await this.invoiceModel.updateOne({ _id: inv._id, status: { $in: OPEN_INVOICE } }, { $set: { status: 'void' }, $push: { audit: audit('void', 'system', 'membership ended') } });
        if (r.modifiedCount) voided++;
      }
    }
    return { overdue: o.modifiedCount, voided };
  }

  /** Reminders 7 days before, 3 days before and on the due day: each at most once per invoice (conditional claim). */
  async sendReminders(now = new Date()): Promise<number> {
    const rows = await this.invoiceModel.find({ status: { $in: ['awaiting', 'overdue'] }, dueAt: { $lte: new Date(now.getTime() + 7 * DAY) } }).limit(500);
    let sent = 0;
    for (const inv of rows) {
      const days = (inv.dueAt.getTime() - now.getTime()) / DAY;
      const slot = days <= 0 ? 'd0' : days <= 3 ? 'd3' : 'd7';
      // catch up: a slot that was skipped is not sent after a later one already went out
      if ((slot === 'd7' && (inv.remindersSent?.d7 || inv.remindersSent?.d3 || inv.remindersSent?.d0)) || (slot === 'd3' && (inv.remindersSent?.d3 || inv.remindersSent?.d0)) || (slot === 'd0' && inv.remindersSent?.d0)) continue;
      const claim = await this.invoiceModel.updateOne({ _id: inv._id, [`remindersSent.${slot}`]: { $exists: false }, status: { $in: ['awaiting', 'overdue'] } }, { $set: { [`remindersSent.${slot}`]: now } });
      if (!claim.modifiedCount) continue;
      await this.mailInvoice('membership_renewal_reminder', inv);
      sent++;
    }
    return sent;
  }

  async runAll(now = new Date()) {
    const created = await this.ensureInvoices(now);
    const swept = await this.sweep(now);
    const reminders = await this.sendReminders(now);
    return { created, ...swept, reminders };
  }

  private async mailInvoice(event: 'membership_renewal_reminder' | 'membership_proof_rejected' | 'membership_renewal_approved', inv: RenewalInvoiceDocument, extra: Record<string, any> = {}) {
    const plan: any = await this.planModel.findOne({ _id: inv.planId, storeId: inv.storeId }).select('name').lean();
    void this.mailer?.membership(event, inv.storeId, inv.customerId, plan?.name ?? 'your plan', inv.dueAt, { amount: `${inv.currency} ${inv.amount}`, ...extra });
  }

  // ---------------- buyer ----------------

  private shape(i: any, withProof = false) {
    return {
      id: String(i._id), subscriptionId: i.subscriptionId, planId: i.planId, amount: i.amount, currency: i.currency, dueAt: i.dueAt, status: i.status,
      instructions: i.instructions ?? [], reference: i.reference, senderName: i.senderName, submittedAt: i.submittedAt, rejectionReason: i.status === 'paid' ? null : i.rejectionReason,
      submissionsLeft: Math.max(0, MAX_PROOF_SUBMISSIONS - (i.submissionCount ?? 0)), hasProof: !!i.proof, paidAt: i.paidAt,
      ...(withProof ? { proofName: i.proof?.fileName ?? null } : {}),
    };
  }

  /** The buyer's open invoices and the last few settled ones. Never contains the proof file itself. */
  async listMine(storeId: string, customerId: string) {
    const rows = await this.invoiceModel.find({ storeId, customerId, status: { $in: ['awaiting', 'submitted', 'overdue', 'paid'] } }).sort({ dueAt: -1 }).limit(20).lean();
    const plans: any[] = await this.planModel.find({ storeId, _id: { $in: rows.map((r) => r.planId) } }).select('name').lean();
    const name = new Map(plans.map((p) => [String(p._id), p.name]));
    return rows.map((r) => ({ ...this.shape(r), planName: name.get(String(r.planId)) ?? 'Plan' }));
  }

  private async mine(storeId: string, customerId: string, id: string) {
    const inv = await this.invoiceModel.findOne({ _id: id, storeId, customerId }).catch(() => null);
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  /** Buyer uploads the transfer receipt (private storage) + reference. Allowed again after a rejection, up to 5 times. */
  async submitProof(storeId: string, customerId: string, id: string, file: Express.Multer.File | undefined, body: { reference?: string; senderName?: string }) {
    const inv = await this.mine(storeId, customerId, id);
    if (!['awaiting', 'overdue'].includes(inv.status)) throw new ConflictException(inv.status === 'submitted' ? 'Your proof is already being reviewed' : 'This invoice is closed');
    if ((inv.submissionCount ?? 0) >= MAX_PROOF_SUBMISSIONS) throw new BadRequestException('Too many attempts. Contact the store.');
    const reference = String(body?.reference ?? '').trim().slice(0, 100);
    if (!file && !reference) throw new BadRequestException('Add a receipt image or a transaction reference');
    let proof: any = null;
    if (file) {
      const ext = String(file.originalname ?? '').split('.').pop()?.toLowerCase() ?? '';
      if (!PROOF_MIME.includes(file.mimetype) || !PROOF_EXT.includes(ext)) throw new BadRequestException('The receipt must be a JPG, PNG, WebP or PDF file');
      if (file.size > MAX_PROOF_BYTES) throw new BadRequestException('The receipt is larger than 10 MB');
      assertFileSignature(file); // the bytes must really be that type
      const up = await this.upload.uploadPrivateFile(file, `private/renewal-proofs/${storeId}`);
      proof = { publicId: up.publicId, fileName: String(file.originalname).slice(0, 120), mimeType: up.mimeType, size: up.fileSize, uploadedAt: new Date() };
    }
    // conditional move to 'submitted': a double click or a replay cannot submit twice
    const r = await this.invoiceModel.updateOne(
      { _id: inv._id, status: { $in: ['awaiting', 'overdue'] }, submissionCount: inv.submissionCount ?? 0 },
      { $set: { status: 'submitted', proof: proof ?? inv.proof, reference: reference || null, senderName: String(body?.senderName ?? '').trim().slice(0, 100) || null, submittedAt: new Date(), rejectionReason: null }, $inc: { submissionCount: 1 }, $push: { audit: audit('proof_submitted', customerId, reference) } },
    );
    if (!r.modifiedCount) throw new ConflictException('This invoice changed, please reload');
    return this.shape(await this.invoiceModel.findById(inv._id).lean());
  }

  /** Short-lived signed link to the buyer's OWN receipt. */
  async proofUrlForBuyer(storeId: string, customerId: string, id: string) {
    return this.signedProof(await this.mine(storeId, customerId, id));
  }

  private signedProof(inv: RenewalInvoiceDocument) {
    if (!inv.proof) throw new NotFoundException('No receipt uploaded');
    const type = inv.proof.mimeType?.startsWith('image/') ? 'image' : 'raw';
    return { url: this.upload.generateSignedUrl(inv.proof.publicId, type, PROOF_URL_SECONDS, inv.proof.fileName), expiresInSeconds: PROOF_URL_SECONDS };
  }

  // ---------------- seller ----------------

  async list(storeId: string, f: { status?: string; planId?: string; dueBefore?: string }, pg: Pg) {
    const filter: any = { storeId };
    if (f.status && ['awaiting', 'submitted', 'overdue', 'paid', 'void'].includes(f.status)) filter.status = f.status;
    else filter.status = { $in: OPEN_INVOICE }; // default queue: everything that needs attention
    if (f.planId) filter.planId = f.planId;
    if (f.dueBefore && !isNaN(new Date(f.dueBefore).getTime())) filter.dueAt = { $lte: new Date(f.dueBefore) };
    const [rows, total, counts] = await Promise.all([
      this.invoiceModel.find(filter).sort({ status: 1, dueAt: 1 }).skip(pg.skip).limit(pg.limit).lean(),
      this.invoiceModel.countDocuments(filter),
      this.invoiceModel.find({ storeId, status: { $in: OPEN_INVOICE } }).select('status').lean(),
    ]);
    const [plans, users]: any[] = await Promise.all([
      this.planModel.find({ storeId, _id: { $in: rows.map((r) => r.planId) } }).select('name').lean(),
      (this.db.repositories as any).userModel.find({ _id: { $in: rows.map((r) => r.customerId) } }).select('name email contactEmail').lean(),
    ]);
    const planName = new Map(plans.map((p: any) => [String(p._id), p.name]));
    const user = new Map(users.map((u: any) => [String(u._id), u]));
    const items = rows.map((r) => ({ ...this.shape(r, true), planName: planName.get(String(r.planId)) ?? 'Deleted plan', customerName: (user.get(String(r.customerId)) as any)?.name ?? null, customerEmail: (user.get(String(r.customerId)) as any)?.contactEmail || (user.get(String(r.customerId)) as any)?.email || null }));
    const summary = { awaiting: 0, submitted: 0, overdue: 0 } as Record<string, number>;
    for (const c of counts) summary[c.status] = (summary[c.status] ?? 0) + 1;
    return { items, total, page: pg.page, limit: pg.limit, summary };
  }

  private async forStore(storeId: string, id: string) {
    const inv = await this.invoiceModel.findOne({ _id: id, storeId }).catch(() => null);
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  async proofUrlForSeller(storeId: string, id: string) {
    return this.signedProof(await this.forStore(storeId, id));
  }

  /**
   * Approve: the invoice is claimed as paid (conditional), then the membership period is extended ONCE through the
   * `invoice:<id>` key. Calling approve again (double click, retry after a crash between the two steps) is safe:
   * the second step is idempotent, so the period is never extended twice.
   */
  async approve(storeId: string, id: string, by: string) {
    const inv = await this.forStore(storeId, id);
    if (inv.status === 'void') throw new ConflictException('This invoice was cancelled');
    if (inv.status !== 'paid') {
      const claim = await this.invoiceModel.updateOne({ _id: inv._id, status: { $in: OPEN_INVOICE } }, { $set: { status: 'paid', paidAt: new Date(), reviewedBy: by, reviewedAt: new Date(), rejectionReason: null }, $push: { audit: audit('approved', by) } });
      if (!claim.modifiedCount && (await this.invoiceModel.findById(inv._id).lean())?.status !== 'paid') throw new ConflictException('This invoice changed, please reload');
    }
    const sub = await this.memberships.markPaid(storeId, inv.subscriptionId, by, `invoice:${inv._id}`);
    const fresh = await this.invoiceModel.findById(inv._id);
    if (fresh) await this.mailInvoice('membership_renewal_approved', fresh, { periodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString().slice(0, 10) : '' });
    return this.shape(fresh?.toObject?.() ?? fresh);
  }

  async reject(storeId: string, id: string, by: string, reason: string) {
    const text = String(reason ?? '').trim().slice(0, 300);
    if (!text) throw new BadRequestException('Give the buyer a reason');
    const inv = await this.forStore(storeId, id);
    const now = new Date();
    const r = await this.invoiceModel.updateOne(
      { _id: inv._id, status: 'submitted' },
      { $set: { status: inv.dueAt < now ? 'overdue' : 'awaiting', rejectionReason: text, reviewedBy: by, reviewedAt: now }, $inc: { rejectionCount: 1 }, $push: { audit: audit('rejected', by, text) } },
    );
    if (!r.modifiedCount) throw new ConflictException('Only a submitted proof can be rejected');
    const fresh = await this.invoiceModel.findById(inv._id);
    if (fresh) await this.mailInvoice('membership_proof_rejected', fresh, { rejectionReason: text });
    return this.shape(fresh?.toObject?.() ?? fresh);
  }

  async voidInvoice(storeId: string, id: string, by: string) {
    const inv = await this.forStore(storeId, id);
    const r = await this.invoiceModel.updateOne({ _id: inv._id, status: { $in: OPEN_INVOICE } }, { $set: { status: 'void' }, $push: { audit: audit('void', by) } });
    if (!r.modifiedCount) throw new ConflictException('Only an open invoice can be cancelled');
    return { success: true };
  }

  /** Bulk reminder from the queue: at most one manual reminder per invoice per 12 hours. */
  async remind(storeId: string, ids: string[], by: string) {
    const list = (Array.isArray(ids) ? ids : []).slice(0, 200).map(String);
    if (!list.length) throw new BadRequestException('Select at least one invoice');
    const cutoff = new Date(Date.now() - MANUAL_REMIND_GAP_MS);
    const rows = await this.invoiceModel.find({ storeId, _id: { $in: list }, status: { $in: ['awaiting', 'overdue'] } });
    let sent = 0;
    for (const inv of rows) {
      const claim = await this.invoiceModel.updateOne(
        { _id: inv._id, status: { $in: ['awaiting', 'overdue'] }, $or: [{ 'remindersSent.manual': { $exists: false } }, { 'remindersSent.manual': { $lt: cutoff } }] },
        { $set: { 'remindersSent.manual': new Date() }, $push: { audit: audit('reminded', by) } },
      );
      if (!claim.modifiedCount) continue;
      await this.mailInvoice('membership_renewal_reminder', inv);
      sent++;
    }
    return { sent, skipped: list.length - sent };
  }
}
