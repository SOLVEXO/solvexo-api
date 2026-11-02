/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../otp/services/email.service';
import { notificationEmailShell } from '../notifications/templates/notification-email.template';
import { SalesLead, SalesLeadDocument } from './schemas/sales-lead.schema';
import {
  SalesActivity,
  SalesActivityDocument,
} from './schemas/sales-activity.schema';
import { SalesTask, SalesTaskDocument } from './schemas/sales-task.schema';
import {
  SalesEmailTemplate,
  SalesEmailTemplateDocument,
} from './schemas/sales-email-template.schema';
import { LEAD_STAGES } from './sales-ops.constants';
import {
  type MerchantState,
  type SalesActor,
  autoStage,
  bodyToHtml,
  fillTemplate,
  leadScope,
  normalizeEmail,
  phoneKey,
  stageTotals,
} from './sales-ops.util';

const CONTACT_TYPES = new Set(['call', 'whatsapp', 'meeting', 'email']);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Starter templates, created the first time templates are listed. */
const DEFAULT_TEMPLATES = [
  {
    name: 'First follow-up',
    subject: 'Your online store with Solvexo',
    body: 'Assalamu Alaikum {{name}},\n\nThank you for your interest in Solvexo. We help businesses like {{businessName}} open an online store in a day: products, payments (Cash on Delivery, bank transfer, Safepay) and delivery all in one place.\n\nWould you like a short demo this week? Reply with a time that suits you.\n\nRegards,\n{{senderName}}\nSolvexo',
  },
  {
    name: 'Demo confirmation',
    subject: 'Your Solvexo demo',
    body: 'Hi {{name}},\n\nThank you for your time. As promised, you can start your free trial at https://solvexo.store/register and set up {{businessName}} in a few minutes.\n\nI will check in after a few days to help with anything you need.\n\nRegards,\n{{senderName}}',
  },
  {
    name: 'Trial check-in',
    subject: 'How is your Solvexo store going?',
    body: 'Hi {{name}},\n\nI wanted to check how your store setup is going. If you need help adding products, connecting payments or choosing a plan, just reply to this email.\n\nRegards,\n{{senderName}}',
  },
];

export interface LeadInput {
  name?: string;
  businessName?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
  businessType?: string | null;
  source?: string;
  sourceDetail?: string | null;
  ownerAdminId?: string | null;
  dealValuePKR?: number | null;
  tags?: string[];
}
export interface LeadListQuery {
  stage?: string;
  owner?: string;
  source?: string;
  q?: string;
  due?: 'overdue' | 'today';
  page?: number;
  limit?: number;
}

/**
 * Sales Ops: Solvexo's own sales pipeline (prospective merchants, not a store's customers). Reps see the leads they
 * own; the owner, Super Admins and `sales.manage` admins see all. Leads link themselves to the merchant account once
 * the email or phone signs up, and move to Trial / Won as that merchant starts a trial or pays.
 */
@Injectable()
export class SalesOpsService {
  private readonly logger = new Logger(SalesOpsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    @InjectModel(SalesLead.name)
    private readonly leads: Model<SalesLeadDocument>,
    @InjectModel(SalesActivity.name)
    private readonly activities: Model<SalesActivityDocument>,
    @InjectModel(SalesTask.name)
    private readonly tasks: Model<SalesTaskDocument>,
    @InjectModel(SalesEmailTemplate.name)
    private readonly templates: Model<SalesEmailTemplateDocument>,
  ) {}

  // ── Leads ────────────────────────────────────────────────────────────────

  async list(actor: SalesActor, q: LeadListQuery, now = new Date()) {
    const scope = { isDelete: false, ...leadScope(actor) };
    const filter: Record<string, unknown> = { ...scope };
    if (q.stage) filter.stage = q.stage;
    if (q.source) filter.source = q.source;
    if (q.owner && actor.canSeeAll)
      filter.ownerAdminId =
        q.owner === 'unassigned'
          ? null
          : q.owner === 'me'
            ? actor.adminId
            : q.owner;
    if (q.q?.trim()) {
      const rx = new RegExp(esc(q.q.trim()), 'i');
      filter.$or = [
        { name: rx },
        { businessName: rx },
        { email: rx },
        { phone: rx },
        { city: rx },
      ];
    }
    if (q.due === 'overdue') filter.nextFollowUpAt = { $lt: now };
    if (q.due === 'today') {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      filter.nextFollowUpAt = { $lte: end };
    }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200),
      page = Math.max(Number(q.page) || 1, 1);
    const [items, total, all] = await Promise.all([
      this.leads
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.leads.countDocuments(filter),
      this.leads
        .find(scope)
        .select('stage dealValuePKR nextFollowUpAt wonAt')
        .lean(),
    ]);
    const owners = await this.ownerNames(items.map((l: any) => l.ownerAdminId));
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const open = all.filter((l: any) => !['won', 'lost'].includes(l.stage));
    return {
      success: true,
      data: {
        items: items.map((l: any) => ({
          ...this.view(l),
          ownerName: l.ownerAdminId
            ? (owners.get(l.ownerAdminId) ?? null)
            : null,
        })),
        total,
        page,
        limit,
        summary: {
          stages: stageTotals(all as any[], LEAD_STAGES),
          openLeads: open.length,
          openValuePKR: open.reduce(
            (s: number, l: any) => s + (l.dealValuePKR ?? 0),
            0,
          ),
          overdueFollowUps: open.filter(
            (l: any) => l.nextFollowUpAt && new Date(l.nextFollowUpAt) < now,
          ).length,
          wonThisMonth: all.filter(
            (l: any) => l.wonAt && new Date(l.wonAt) >= monthStart,
          ).length,
        },
      },
    };
  }

  async create(actor: SalesActor, input: LeadInput) {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Name is required.');
    const email = normalizeEmail(input.email),
      pk = phoneKey(input.phone);
    if (!email && !pk)
      throw new BadRequestException(
        'Add an email or a phone number so you can reach this lead.',
      );
    await this.assertNotDuplicate(email, pk);
    const ownerAdminId = actor.canSeeAll
      ? input.ownerAdminId === undefined
        ? actor.adminId
        : input.ownerAdminId
      : actor.adminId;
    const lead: any = await this.leads.create({
      ...this.clean(input),
      name,
      email,
      phoneKey: pk,
      ownerAdminId,
      createdByAdminId: actor.adminId,
      stage: 'new',
      stageChangedAt: new Date(),
    });
    await this.log(
      String(lead._id),
      'system',
      `Lead added${input.source ? ` (source: ${input.source.replace(/_/g, ' ')})` : ''}.`,
      actor.adminId,
    );
    await this.linkLead(lead);
    return this.get(actor, String(lead._id));
  }

  async get(actor: SalesActor, id: string) {
    const lead: any = await this.mustFind(actor, id);
    const [activities, tasks, owners, merchant] = await Promise.all([
      this.activities
        .find({ leadId: id })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      this.tasks.find({ leadId: id }).sort({ doneAt: 1, dueAt: 1 }).lean(),
      this.ownerNames([lead.ownerAdminId]),
      this.merchantSummary(lead.sellerId),
    ]);
    const authors = await this.ownerNames(
      activities.map((a: any) => a.adminId),
    );
    return {
      success: true,
      data: {
        lead: {
          ...this.view(lead),
          ownerName: lead.ownerAdminId
            ? (owners.get(lead.ownerAdminId) ?? null)
            : null,
        },
        activities: activities.map((a: any) => ({
          ...a,
          _id: String(a._id),
          adminName: a.adminId ? (authors.get(a.adminId) ?? null) : null,
        })),
        tasks: tasks.map((t: any) => ({ ...t, _id: String(t._id) })),
        merchant,
      },
    };
  }

  async update(actor: SalesActor, id: string, input: LeadInput) {
    const lead: any = await this.mustFind(actor, id);
    const set: Record<string, unknown> = this.clean(input);
    if (input.name !== undefined) {
      if (!input.name?.trim())
        throw new BadRequestException('Name is required.');
      set.name = input.name.trim();
    }
    if (input.email !== undefined || input.phone !== undefined) {
      const email =
        input.email !== undefined ? normalizeEmail(input.email) : lead.email;
      const pk =
        input.phone !== undefined ? phoneKey(input.phone) : lead.phoneKey;
      if (!email && !pk)
        throw new BadRequestException(
          'Keep an email or a phone number on the lead.',
        );
      await this.assertNotDuplicate(email, pk, id);
      set.email = email;
      set.phoneKey = pk;
    }
    if (
      input.ownerAdminId !== undefined &&
      input.ownerAdminId !== lead.ownerAdminId
    ) {
      if (!actor.canSeeAll)
        throw new ForbiddenException(
          'Only a sales manager can reassign leads.',
        );
      set.ownerAdminId = input.ownerAdminId;
      const names = await this.ownerNames([input.ownerAdminId]);
      await this.log(
        id,
        'owner_change',
        input.ownerAdminId
          ? `Assigned to ${names.get(input.ownerAdminId) ?? 'another admin'}.`
          : 'Unassigned.',
        actor.adminId,
      );
    }
    await this.leads.updateOne({ _id: id }, { $set: set });
    if (set.email !== undefined) await this.linkLead({ ...lead, ...set });
    return this.get(actor, id);
  }

  async changeStage(
    actor: SalesActor,
    id: string,
    stage: string,
    lostReason?: string | null,
    note?: string | null,
  ) {
    if (!(LEAD_STAGES as readonly string[]).includes(stage))
      throw new BadRequestException('Unknown stage.');
    const lead: any = await this.mustFind(actor, id);
    if (lead.stage === stage) return this.get(actor, id);
    if (stage === 'lost' && !lostReason)
      throw new BadRequestException('Choose why the lead was lost.');
    await this.setStage(lead, stage, actor.adminId, {
      lostReason: stage === 'lost' ? (lostReason ?? null) : null,
      lostNote: stage === 'lost' ? (note ?? null) : null,
    });
    return this.get(actor, id);
  }

  async remove(actor: SalesActor, id: string) {
    await this.mustFind(actor, id);
    await this.leads.updateOne({ _id: id }, { $set: { isDelete: true } });
    return { success: true, data: { id } };
  }

  // ── Timeline, tasks, email ─────────────────────────────────────────────────

  async addActivity(
    actor: SalesActor,
    id: string,
    type: string,
    body: string,
    outcome?: string | null,
  ) {
    if (!['note', 'call', 'whatsapp', 'meeting'].includes(type))
      throw new BadRequestException('Unknown activity type.');
    if (!body?.trim()) throw new BadRequestException('Write what happened.');
    const lead: any = await this.mustFind(actor, id);
    // `outcome` is its own field on the activity: the lead timeline shows it next to the type.
    await this.activities.create({
      leadId: id,
      type,
      body: body.trim(),
      outcome: outcome?.trim() || null,
      adminId: actor.adminId,
      meta: null,
    });
    await this.touch(lead, type, actor.adminId);
    return this.get(actor, id);
  }

  async sendEmail(
    actor: SalesActor,
    id: string,
    subject: string,
    body: string,
  ) {
    const lead: any = await this.mustFind(actor, id);
    if (!lead.email)
      throw new BadRequestException('This lead has no email address.');
    if (!subject?.trim() || !body?.trim())
      throw new BadRequestException('Add a subject and a message.');
    const sender: any = await this.db.repositories.adminModel
      .findById(actor.adminId)
      .select('name email')
      .lean();
    const vars = {
      name: lead.name,
      businessName: lead.businessName ?? lead.name,
      senderName: sender?.name ?? 'The Solvexo team',
    };
    const subj = fillTemplate(subject.trim(), vars),
      text = fillTemplate(body.trim(), vars);
    const sent = await this.email
      .sendMail(
        lead.email,
        subj,
        notificationEmailShell(subj, bodyToHtml(text)),
        sender?.email ?? null,
      )
      .catch(() => false);
    if (!sent)
      throw new BadRequestException(
        'The email could not be sent. Check the email settings and try again.',
      );
    await this.activities.create({
      leadId: id,
      type: 'email',
      subject: subj,
      body: text,
      adminId: actor.adminId,
      meta: { to: lead.email },
    });
    await this.touch(lead, 'email', actor.adminId);
    return this.get(actor, id);
  }

  async listTasks(
    actor: SalesActor,
    q: { scope?: 'mine' | 'all'; status?: 'open' | 'done' },
  ) {
    const visible = await this.leads
      .find({ isDelete: false, ...leadScope(actor) })
      .select('_id name businessName stage')
      .lean();
    const byId = new Map(visible.map((l: any) => [String(l._id), l]));
    const filter: Record<string, unknown> = {
      leadId: { $in: [...byId.keys()] },
      doneAt: q.status === 'done' ? { $ne: null } : null,
    };
    if (q.scope !== 'all' || !actor.canSeeAll)
      filter.assigneeAdminId = actor.adminId;
    const rows: any[] = await this.tasks
      .find(filter)
      .sort(q.status === 'done' ? { doneAt: -1 } : { dueAt: 1 })
      .limit(300)
      .lean();
    const names = await this.ownerNames(rows.map((t) => t.assigneeAdminId));
    return {
      success: true,
      data: rows.map((t) => {
        const l: any = byId.get(t.leadId);
        return {
          ...t,
          _id: String(t._id),
          leadName: l?.name ?? '',
          leadBusiness: l?.businessName ?? null,
          leadStage: l?.stage ?? null,
          assigneeName: t.assigneeAdminId
            ? (names.get(t.assigneeAdminId) ?? null)
            : null,
        };
      }),
    };
  }

  async createTask(
    actor: SalesActor,
    leadId: string,
    title: string,
    dueAt: string,
    assigneeAdminId?: string | null,
  ) {
    const lead: any = await this.mustFind(actor, leadId);
    const due = new Date(dueAt);
    if (!title?.trim() || Number.isNaN(due.getTime()))
      throw new BadRequestException('Add a title and a due date.');
    const assignee = actor.canSeeAll
      ? (assigneeAdminId ?? lead.ownerAdminId ?? actor.adminId)
      : actor.adminId;
    await this.tasks.create({
      leadId,
      title: title.trim(),
      dueAt: due,
      assigneeAdminId: assignee,
      createdByAdminId: actor.adminId,
    });
    await this.refreshFollowUp(leadId);
    return this.get(actor, leadId);
  }

  async updateTask(
    actor: SalesActor,
    taskId: string,
    patch: { done?: boolean; title?: string; dueAt?: string },
  ) {
    const task: any = await this.tasks.findById(taskId).lean();
    if (!task) throw new NotFoundException('Task not found.');
    await this.mustFind(actor, task.leadId);
    const set: Record<string, unknown> = {};
    if (patch.done !== undefined) set.doneAt = patch.done ? new Date() : null;
    if (patch.title?.trim()) set.title = patch.title.trim();
    if (patch.dueAt) {
      const d = new Date(patch.dueAt);
      if (Number.isNaN(d.getTime()))
        throw new BadRequestException('Invalid due date.');
      set.dueAt = d;
    }
    await this.tasks.updateOne({ _id: taskId }, { $set: set });
    if (patch.done)
      await this.log(
        task.leadId,
        'system',
        `Task done: ${task.title}`,
        actor.adminId,
      );
    await this.refreshFollowUp(task.leadId);
    return { success: true, data: { id: taskId } };
  }

  async deleteTask(actor: SalesActor, taskId: string) {
    const task: any = await this.tasks.findById(taskId).lean();
    if (!task) throw new NotFoundException('Task not found.');
    await this.mustFind(actor, task.leadId);
    await this.tasks.deleteOne({ _id: taskId });
    await this.refreshFollowUp(task.leadId);
    return { success: true, data: { id: taskId } };
  }

  // ── Templates & owners ───────────────────────────────────────────────────

  async listTemplates() {
    if ((await this.templates.countDocuments({})) === 0)
      await this.templates.insertMany(DEFAULT_TEMPLATES);
    const rows = await this.templates
      .find({ isDelete: false })
      .sort({ createdAt: 1 })
      .lean();
    return {
      success: true,
      data: rows.map((t: any) => ({
        _id: String(t._id),
        name: t.name,
        subject: t.subject,
        body: t.body,
      })),
    };
  }

  async saveTemplate(
    id: string | null,
    input: { name: string; subject: string; body: string },
  ) {
    if (!input.name?.trim() || !input.subject?.trim() || !input.body?.trim())
      throw new BadRequestException('Name, subject and message are required.');
    const doc = {
      name: input.name.trim(),
      subject: input.subject.trim(),
      body: input.body.trim(),
    };
    if (id) {
      const r = await this.templates.updateOne(
        { _id: id, isDelete: false },
        { $set: doc },
      );
      if (!r.matchedCount) throw new NotFoundException('Template not found.');
    } else await this.templates.create(doc);
    return this.listTemplates();
  }

  async deleteTemplate(id: string) {
    await this.templates.updateOne({ _id: id }, { $set: { isDelete: true } });
    return this.listTemplates();
  }

  /** Admins a lead can be assigned to: Super Admins / the owner, and team admins whose role has a sales permission. */
  async owners() {
    const r = this.db.repositories;
    const roles: any[] = await r.adminRoleModel
      .find({
        isDelete: false,
        permissions: { $in: ['sales.access', 'sales.manage'] },
      })
      .select('_id')
      .lean();
    const admins: any[] = await r.adminModel
      .find({
        isDelete: { $ne: true },
        status: 'active',
        $or: [
          { isSuperAdmin: true },
          { roleId: null },
          { roleId: { $exists: false } },
          { roleId: { $in: roles.map((x) => x._id) } },
        ],
      })
      .select('name email')
      .sort({ name: 1 })
      .lean();
    return {
      success: true,
      data: admins.map((a) => ({
        _id: String(a._id),
        name: a.name,
        email: a.email,
      })),
    };
  }

  // ── Linking to merchants ─────────────────────────────────────────────────

  @Cron('*/15 * * * *')
  async linkJob() {
    await this.redis.withLock(
      'cron-lock:sales-lead-link',
      10 * 60_000,
      async () => {
        const n = await this.linkAll();
        if (n > 0) this.logger.log(`Sales Ops: ${n} lead(s) linked or moved`);
      },
    );
  }

  /** Links every open lead to its merchant account and moves it to Trial / Won when that account trials or pays. */
  async linkAll(): Promise<number> {
    const open: any[] = await this.leads
      .find({
        isDelete: false,
        stage: { $ne: 'won' },
        $or: [{ email: { $ne: null } }, { phoneKey: { $ne: null } }],
      })
      .lean();
    let changed = 0;
    for (const lead of open) if (await this.linkLead(lead)) changed++;
    return changed;
  }

  /** Returns true when the lead was linked or moved. */
  async linkLead(lead: any): Promise<boolean> {
    const r = this.db.repositories;
    let sellerId: string | null = lead.sellerId ?? null;
    if (!sellerId) {
      const or: Record<string, unknown>[] = [];
      if (lead.email)
        or.push({ email: new RegExp(`^${esc(lead.email)}$`, 'i') });
      // Digits may be separated by spaces or dashes in the merchant's saved number.
      if (lead.phoneKey)
        or.push({
          phone: new RegExp(
            `${String(lead.phoneKey).split('').join('\\D*')}\\D*$`,
          ),
        });
      if (!or.length) return false;
      const seller: any = await r.sellerModel
        .findOne({ isDelete: { $ne: true }, $or: or })
        .select('_id')
        .lean();
      if (!seller) return false;
      sellerId = String(seller._id);
    }
    const { state, storeId } = await this.merchantState(sellerId);
    const linkedNow = !lead.sellerId;
    if (linkedNow) {
      await this.leads.updateOne(
        { _id: lead._id },
        { $set: { sellerId, storeId, linkedAt: new Date() } },
      );
      await this.log(
        String(lead._id),
        'system',
        'Linked to their Solvexo merchant account (they signed up).',
        null,
      );
    }
    const next = autoStage(lead.stage, state);
    if (next)
      await this.setStage(
        lead,
        next,
        null,
        {},
        next === 'won'
          ? 'They chose a paid plan.'
          : 'They started a free trial.',
      );
    return linkedNow || !!next;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async merchantState(
    sellerId: string,
  ): Promise<{ state: MerchantState; storeId: string | null }> {
    const r = this.db.repositories;
    const stores: any[] = await r.storeModel
      .find({ sellerId, isDelete: false })
      .select('_id')
      .lean();
    if (!stores.length) return { state: 'signed_up', storeId: null };
    const subs: any[] = await r.sellerPlatformSubscriptionModel
      .find({
        storeId: { $in: stores.map((s) => String(s._id)) },
        isDelete: { $ne: true },
      })
      .select('storeId status amountUSD')
      .lean();
    const paying = subs.find(
      (s) => ['active', 'past_due'].includes(s.status) && s.amountUSD > 0,
    );
    if (paying) return { state: 'paying', storeId: String(paying.storeId) };
    const trial = subs.find((s) => s.status === 'trialing');
    return {
      state: trial ? 'trial' : 'not_paying',
      storeId: String((trial ?? stores[0]).storeId ?? stores[0]._id),
    };
  }

  private async merchantSummary(sellerId: string | null) {
    if (!sellerId) return null;
    const r = this.db.repositories;
    const [seller, stores]: [any, any[]] = await Promise.all([
      r.sellerModel.findById(sellerId).select('name email createdAt').lean(),
      r.storeModel
        .find({ sellerId, isDelete: false })
        .select('name slug createdAt')
        .lean(),
    ]);
    if (!seller) return null;
    const { state } = await this.merchantState(sellerId);
    return {
      sellerId,
      name: seller.name,
      email: seller.email,
      signedUpAt: seller.createdAt,
      state,
      stores: stores.map((s) => ({
        _id: String(s._id),
        name: s.name,
        slug: s.slug,
      })),
    };
  }

  /** Moves a lead and logs it. Used by SalesCaptureService too. */
  async setStage(
    lead: any,
    stage: string,
    adminId: string | null,
    extra: Record<string, unknown>,
    reason?: string,
  ) {
    const now = new Date();
    await this.leads.updateOne(
      { _id: lead._id },
      {
        $set: {
          stage,
          stageChangedAt: now,
          ...(stage === 'won' ? { wonAt: now } : {}),
          ...extra,
        },
      },
    );
    await this.log(
      String(lead._id),
      'stage_change',
      `${this.label(lead.stage)} → ${this.label(stage)}${reason ? `. ${reason}` : ''}`,
      adminId,
      { from: lead.stage, to: stage },
    );
  }

  /** First contact moves a New lead to Contacted. */
  private async touch(lead: any, type: string, adminId: string) {
    await this.leads.updateOne(
      { _id: lead._id },
      { $set: { lastActivityAt: new Date() } },
    );
    if (lead.stage === 'new' && CONTACT_TYPES.has(type))
      await this.setStage(
        lead,
        'contacted',
        adminId,
        {},
        'First contact made.',
      );
  }

  private async refreshFollowUp(leadId: string) {
    const next: any = await this.tasks
      .findOne({ leadId, doneAt: null })
      .sort({ dueAt: 1 })
      .select('dueAt')
      .lean();
    await this.leads.updateOne(
      { _id: leadId },
      { $set: { nextFollowUpAt: next?.dueAt ?? null } },
    );
  }

  /** Adds a timeline entry. Used by SalesCaptureService too. */
  log(
    leadId: string,
    type: string,
    body: string,
    adminId: string | null,
    meta: Record<string, unknown> | null = null,
  ) {
    return this.activities.create({ leadId, type, body, adminId, meta });
  }

  private async mustFind(actor: SalesActor, id: string) {
    if (!/^[a-f0-9]{24}$/i.test(id))
      throw new NotFoundException('Lead not found.');
    const lead = await this.leads
      .findOne({ _id: id, isDelete: false, ...leadScope(actor) })
      .lean();
    if (!lead) throw new NotFoundException('Lead not found.');
    return lead;
  }

  private async assertNotDuplicate(
    email: string | null,
    pk: string | null,
    exceptId?: string,
  ) {
    const or: Record<string, unknown>[] = [];
    if (email) or.push({ email });
    if (pk) or.push({ phoneKey: pk });
    if (!or.length) return;
    const dup: any = await this.leads
      .findOne({
        isDelete: false,
        $or: or,
        ...(exceptId ? { _id: { $ne: exceptId } } : {}),
      })
      .select('_id name')
      .lean();
    if (dup)
      throw new ConflictException({
        message: `A lead with this email or phone already exists (${dup.name}).`,
        existingLeadId: String(dup._id),
      });
  }

  private clean(input: LeadInput) {
    const out: Record<string, unknown> = {};
    for (const k of [
      'businessName',
      'phone',
      'city',
      'country',
      'businessType',
      'source',
      'sourceDetail',
      'dealValuePKR',
      'tags',
    ] as const) {
      if (input[k] !== undefined)
        out[k] =
          typeof input[k] === 'string'
            ? (input[k] as string).trim() || null
            : input[k];
    }
    if (out.source === null) delete out.source;
    return out;
  }

  private async ownerNames(ids: (string | null | undefined)[]) {
    const uniq = [
      ...new Set(
        ids.filter((x): x is string => !!x && /^[a-f0-9]{24}$/i.test(x)),
      ),
    ];
    if (!uniq.length) return new Map<string, string>();
    const rows: any[] = await this.db.repositories.adminModel
      .find({ _id: { $in: uniq } })
      .select('name')
      .lean();
    return new Map(rows.map((a) => [String(a._id), a.name as string]));
  }

  private view(l: any) {
    const { phoneKey: _pk, isDelete: _d, __v, ...rest } = l;
    return { ...rest, _id: String(l._id) };
  }

  private label(stage: string) {
    return stage.charAt(0).toUpperCase() + stage.slice(1);
  }
}
