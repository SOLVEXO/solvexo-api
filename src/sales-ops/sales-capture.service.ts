/* eslint-disable prettier/prettier */
import {
  Optional,
  BadRequestException,
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
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { notificationEmailShell } from '../notifications/templates/notification-email.template';
import { escapeHtml } from '../newsletter/marketing-email.util';
import { ActivationFunnelService } from '../admin-analytics/activation-funnel.service';
import { STEP_LABEL } from '../admin-analytics/activation-funnel.util';
import {
  ContactSubmission,
  ContactSubmissionDocument,
} from '../contact/schemas/contact-submission.schema';
import { SalesLead, SalesLeadDocument } from './schemas/sales-lead.schema';
import {
  SalesActivity,
  SalesActivityDocument,
} from './schemas/sales-activity.schema';
import { SOURCE_LABELS, type LeadSource } from './sales-ops.constants';
import { SalesOpsService } from './sales-ops.service';
import { SalesGrowthService } from './sales-growth.service';
import { type SalesActor, normalizeEmail, phoneKey } from './sales-ops.util';

export interface CaptureInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  businessName?: string | null;
  city?: string | null;
  businessType?: string | null;
  source: LeadSource;
  sourceDetail?: string | null;
  /** What they wrote (the form message, the contact message): goes on the timeline. */
  note?: string | null;
  utm?: {
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
  } | null;
  sellerId?: string | null;
  ownerAdminId?: string | null;
  createdByAdminId?: string | null;
}
export interface CaptureResult {
  leadId: string;
  created: boolean;
}

export interface ImportRow {
  name?: string;
  email?: string;
  phone?: string;
  businessName?: string;
  city?: string;
  businessType?: string;
  dealValuePKR?: number | string | null;
  note?: string;
}
export interface ImportOptions {
  ownerAdminId?: string | null;
  sourceDetail?: string | null;
  tags?: string[];
}

const MAX_IMPORT = 2000;
const STALLED_PER_RUN = 300;
const trimOrNull = (v: unknown, max = 200) => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s || null;
};

/**
 * Leads that arrive on their own: the Book-a-demo form, Contact Us messages about selling, CSV imports and
 * merchants who signed up but stalled. Someone who is already in the pipeline is never duplicated: a form or
 * message from them lands on their existing lead's timeline (and reopens it if it was lost).
 */
@Injectable()
export class SalesCaptureService {
  private readonly logger = new Logger(SalesCaptureService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly funnel: ActivationFunnelService,
    private readonly sales: SalesOpsService,
    @InjectModel(SalesLead.name)
    private readonly leads: Model<SalesLeadDocument>,
    @InjectModel(SalesActivity.name)
    private readonly activities: Model<SalesActivityDocument>,
    @InjectModel(ContactSubmission.name)
    private readonly contacts: Model<ContactSubmissionDocument>,
    @Optional() private readonly growth?: SalesGrowthService,
  ) {}

  // ── One lead at a time ───────────────────────────────────────────────────

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Name is required.');
    const email = normalizeEmail(input.email);
    const pk = phoneKey(input.phone);
    if (!email && !pk && !input.sellerId)
      throw new BadRequestException('Add an email or a phone number.');
    const label = SOURCE_LABELS[input.source] ?? input.source;
    const note = trimOrNull(input.note, 5000);

    const existing: any = await this.findExisting(
      email,
      pk,
      input.sellerId ?? null,
    );
    if (existing) {
      const fill: Record<string, unknown> = { lastActivityAt: new Date() };
      const maybe = (k: string, v: unknown) => {
        if (v && !existing[k]) fill[k] = v;
      };
      maybe('email', email);
      if (pk && !existing.phoneKey) {
        fill.phone = trimOrNull(input.phone, 40);
        fill.phoneKey = pk;
      }
      maybe('businessName', trimOrNull(input.businessName, 160));
      maybe('city', trimOrNull(input.city, 80));
      maybe('businessType', trimOrNull(input.businessType, 80));
      await this.leads.updateOne({ _id: existing._id }, { $set: fill });
      const id = String(existing._id);
      await this.sales.log(
        id,
        'system',
        `Got in touch again via ${label}.${note ? `\n\n${note}` : ''}`,
        null,
        { source: input.source },
      );
      if (existing.stage === 'lost')
        await this.sales.setStage(
          existing,
          'new',
          null,
          { lostReason: null, lostNote: null },
          `Reopened: came back via ${label}.`,
        );
      return { leadId: id, created: false };
    }

    // Leads nobody added by hand go to the next rep in turn, when auto-assign is on.
    const autoOwner =
      !input.ownerAdminId && !input.createdByAdminId && this.growth
        ? await this.growth.nextAssignee().catch(() => null)
        : null;
    const lead: any = await this.leads.create({
      name: name.slice(0, 120),
      email,
      phone: trimOrNull(input.phone, 40),
      phoneKey: pk,
      businessName: trimOrNull(input.businessName, 160),
      city: trimOrNull(input.city, 80),
      businessType: trimOrNull(input.businessType, 80),
      source: input.source,
      sourceDetail: trimOrNull(input.sourceDetail),
      utm: this.cleanUtm(input.utm),
      sellerId: input.sellerId ?? null,
      linkedAt: input.sellerId ? new Date() : null,
      ownerAdminId: input.ownerAdminId ?? autoOwner,
      createdByAdminId: input.createdByAdminId ?? null,
      stage: 'new',
      stageChangedAt: new Date(),
      lastActivityAt: new Date(),
    });
    const id = String(lead._id);
    await this.sales.log(
      id,
      'system',
      `Lead added from ${label}.${note ? `\n\n${note}` : ''}`,
      input.createdByAdminId ?? null,
      { source: input.source },
    );
    if (autoOwner && this.growth) {
      const names = (await this.sales.owners()).data;
      await this.sales.log(
        id,
        'owner_change',
        `Assigned automatically to ${names.find((o) => o._id === autoOwner)?.name ?? 'a rep'}.`,
        null,
      );
      void this.growth.notifyAssigned(autoOwner, id, name, label);
    }
    await this.sales.linkLead(lead).catch(() => false);
    return { leadId: id, created: true };
  }

  /** The public Book-a-demo form on solvexo.store. */
  async demoRequest(dto: {
    name: string;
    phone: string;
    email?: string | null;
    businessName?: string | null;
    city?: string | null;
    businessType?: string | null;
    message?: string | null;
    preferredTime?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    page?: string | null;
  }) {
    if (!phoneKey(dto.phone))
      throw new BadRequestException(
        'Enter a phone number we can call or WhatsApp.',
      );
    const lines = [
      dto.message?.trim(),
      dto.preferredTime ? `Best time to call: ${dto.preferredTime}.` : null,
      dto.page ? `Sent from ${dto.page}.` : null,
    ].filter(Boolean);
    const r = await this.capture({
      name: dto.name,
      phone: dto.phone,
      email: dto.email,
      businessName: dto.businessName,
      city: dto.city,
      businessType: dto.businessType,
      source: 'website_form',
      sourceDetail: dto.utmCampaign
        ? `Campaign: ${dto.utmCampaign}`
        : 'Book a demo',
      note: lines.join('\n'),
      utm: {
        source: dto.utmSource,
        medium: dto.utmMedium,
        campaign: dto.utmCampaign,
      },
    });
    void this.notifyManagers(
      `${r.created ? 'New demo request' : 'Demo request (returning lead)'}: ${dto.name.trim()}`,
      [dto.businessName, dto.city, dto.phone].filter(Boolean).join(' · '),
      r.leadId,
    );
    const to = normalizeEmail(dto.email);
    if (to) {
      void this.email
        .sendMail(
          to,
          'We got your demo request — Solvexo',
          notificationEmailShell(
            'Thanks — we’ll be in touch',
            `<p>Hi ${escapeHtml(dto.name.trim())},</p><p>Thank you for booking a Solvexo demo. Someone from our team will call or WhatsApp you on <strong>${escapeHtml(dto.phone.trim())}</strong> within one working day to find a time that suits you.</p><p>In the meantime you can start a free trial and look around.</p>`,
            {
              label: 'Start your free trial',
              url: 'https://solvexo.store/register?role=seller',
            },
          ),
        )
        .catch(() => undefined);
    }
    return {
      success: true,
      message: 'Thank you! We’ll call or WhatsApp you within one working day.',
    };
  }

  /** A Contact Us message about selling on Solvexo becomes (or lands on) a lead. */
  async fromContactMessage(c: {
    name: string;
    email: string;
    topic: string;
    message: string;
  }) {
    const r = await this.capture({
      name: c.name,
      email: c.email,
      source: 'contact_message',
      sourceDetail: c.topic,
      note: c.message,
    });
    void this.notifyManagers(
      `${r.created ? 'New lead' : 'Returning lead'} from Contact Us: ${c.name.trim()}`,
      c.email,
      r.leadId,
    );
    return r;
  }

  /** "Add to pipeline" on any Contact Us message in Super Admin. */
  async addContactToPipeline(actor: SalesActor, contactId: string) {
    if (!/^[a-f0-9]{24}$/i.test(contactId))
      throw new NotFoundException('Message not found.');
    const c: any = await this.contacts.findById(contactId).lean();
    if (!c) throw new NotFoundException('Message not found.');
    const r = await this.capture({
      name: c.name,
      email: c.email,
      source: 'contact_message',
      sourceDetail: c.topic,
      note: c.message,
      ownerAdminId: actor.canSeeAll ? null : actor.adminId,
      createdByAdminId: actor.adminId,
    });
    const lead: any = await this.leads
      .findById(r.leadId)
      .select('ownerAdminId')
      .lean();
    const visible = actor.canSeeAll || lead?.ownerAdminId === actor.adminId;
    return {
      success: true,
      message: r.created
        ? 'Added to the pipeline.'
        : 'Already in the pipeline: the message was added to their timeline.',
      data: { ...r, visible },
    };
  }

  // ── CSV import ───────────────────────────────────────────────────────────

  /**
   * Adds every valid, new row. Rows already in the pipeline (or repeated in the file) are reported, not merged:
   * an imported list is not a sign the person got in touch again. `dryRun` checks without saving.
   */
  async importLeads(
    actor: SalesActor,
    rows: ImportRow[],
    opts: ImportOptions = {},
    dryRun = false,
  ) {
    if (!Array.isArray(rows) || rows.length === 0)
      throw new BadRequestException('The file has no rows.');
    if (rows.length > MAX_IMPORT)
      throw new BadRequestException(
        `Import up to ${MAX_IMPORT} leads at a time.`,
      );
    if (opts.ownerAdminId && !actor.canSeeAll)
      throw new ForbiddenException(
        'Only a sales manager can import leads for someone else.',
      );
    const owner = actor.canSeeAll ? (opts.ownerAdminId ?? null) : actor.adminId;

    const invalid: { row: number; reason: string }[] = [];
    const duplicates: {
      row: number;
      name: string;
      existingLeadId: string | null;
      inFile?: boolean;
    }[] = [];
    const seen = new Map<string, number>();
    const ready: {
      row: number;
      doc: Record<string, unknown>;
      note: string | null;
    }[] = [];

    rows.forEach((raw, i) => {
      const row = i + 2; // spreadsheet row number (row 1 is the header)
      const name = trimOrNull(raw?.name, 120);
      const email = normalizeEmail(trimOrNull(raw?.email, 160));
      const pk = phoneKey(trimOrNull(raw?.phone, 40));
      if (!name) return invalid.push({ row, reason: 'Missing name' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return invalid.push({ row, reason: 'Email looks wrong' });
      if (!email && !pk)
        return invalid.push({
          row,
          reason: 'Needs an email or a phone number',
        });
      let value: number | null = null;
      if (
        raw.dealValuePKR !== undefined &&
        raw.dealValuePKR !== null &&
        String(raw.dealValuePKR).trim() !== ''
      ) {
        value = Number(String(raw.dealValuePKR).replace(/[^\d.]/g, ''));
        if (!Number.isFinite(value))
          return invalid.push({ row, reason: 'Deal value is not a number' });
      }
      const keys = [email && `e:${email}`, pk && `p:${pk}`].filter(
        Boolean,
      ) as string[];
      const firstRow = keys
        .map((k) => seen.get(k))
        .find((x) => x !== undefined);
      if (firstRow !== undefined)
        return duplicates.push({
          row,
          name,
          existingLeadId: null,
          inFile: true,
        });
      keys.forEach((k) => seen.set(k, row));
      ready.push({
        row,
        note: trimOrNull(raw.note, 2000),
        doc: {
          name,
          email,
          phone: trimOrNull(raw.phone, 40),
          phoneKey: pk,
          businessName: trimOrNull(raw.businessName, 160),
          city: trimOrNull(raw.city, 80),
          businessType: trimOrNull(raw.businessType, 80),
          dealValuePKR: value,
        },
      });
    });

    // Against the pipeline (deleted leads included: someone removed them on purpose).
    const emails = ready
      .map((r) => r.doc.email as string | null)
      .filter((x): x is string => !!x);
    const pks = ready
      .map((r) => r.doc.phoneKey as string | null)
      .filter((x): x is string => !!x);
    const existing: any[] =
      emails.length || pks.length
        ? await this.leads
            .find({
              $or: [{ email: { $in: emails } }, { phoneKey: { $in: pks } }],
            })
            .select('email phoneKey isDelete')
            .lean()
        : [];
    const byKey = new Map<string, string>();
    for (const l of existing) {
      if (l.email) byKey.set(`e:${l.email}`, String(l._id));
      if (l.phoneKey) byKey.set(`p:${l.phoneKey}`, String(l._id));
    }
    const fresh = ready.filter((r) => {
      const hit =
        byKey.get(`e:${r.doc.email}`) ?? byKey.get(`p:${r.doc.phoneKey}`);
      if (hit)
        duplicates.push({
          row: r.row,
          name: r.doc.name as string,
          existingLeadId: hit,
        });
      return !hit;
    });

    let created = 0;
    if (!dryRun && fresh.length) {
      const now = new Date();
      const docs = await this.leads.insertMany(
        fresh.map((r) => ({
          ...r.doc,
          source: 'import',
          sourceDetail: trimOrNull(opts.sourceDetail),
          tags: (opts.tags ?? []).slice(0, 20),
          ownerAdminId: owner,
          createdByAdminId: actor.adminId,
          stage: 'new',
          stageChangedAt: now,
        })),
      );
      created = docs.length;
      await this.activities.insertMany(
        docs.map((d: any, i) => ({
          leadId: String(d._id),
          type: 'system',
          adminId: actor.adminId,
          body: `Imported${opts.sourceDetail ? ` (${opts.sourceDetail})` : ''}.${fresh[i].note ? `\n\n${fresh[i].note}` : ''}`,
        })),
      );
      // Linking checks each lead against merchant accounts; do it after answering.
      void (async () => {
        for (const d of docs)
          await this.sales.linkLead(d.toObject()).catch(() => false);
      })();
    }
    duplicates.sort((a, b) => a.row - b.row);
    return {
      success: true,
      data: {
        total: rows.length,
        created,
        wouldCreate: fresh.length,
        duplicates,
        invalid,
        dryRun,
      },
    };
  }

  // ── Stalled sign-ups ─────────────────────────────────────────────────────

  @Cron('0 5 * * *') // 10:00 in Pakistan
  async stalledJob() {
    await this.redis.withLock(
      'cron-lock:sales-stalled-signups',
      20 * 60_000,
      async () => {
        const r = await this.syncStalled();
        if (r.added)
          this.logger.log(
            `Sales Ops: ${r.added} stalled sign-up(s) added as leads`,
          );
      },
    );
  }

  /**
   * Merchants who signed up in the last 30 days and have been stuck on one step for 3+ days (not paying yet)
   * become leads, unless they are already in the pipeline (deleted leads count: never re-add someone removed).
   */
  async syncStalled(now = Date.now()) {
    const stuck = await this.funnel.stuck(30, 3, now);
    if (!stuck.length) return { success: true, checked: 0, added: 0 };
    const ids = stuck.map((s) => s.sellerId);
    const sellers: any[] = await this.db.repositories.sellerModel
      .find({ _id: { $in: ids } })
      .select('name email phone')
      .lean();
    const sellerById = new Map(sellers.map((s) => [String(s._id), s]));
    const emails = sellers
      .map((s) => normalizeEmail(s.email))
      .filter((x): x is string => !!x);
    const pks = sellers
      .map((s) => phoneKey(s.phone))
      .filter((x): x is string => !!x);
    const known: any[] = await this.leads
      .find({
        $or: [
          { sellerId: { $in: ids } },
          { email: { $in: emails } },
          { phoneKey: { $in: pks } },
        ],
      })
      .select('sellerId email phoneKey')
      .lean();
    const knownSet = new Set(
      known.flatMap((l) =>
        [
          l.sellerId && `s:${l.sellerId}`,
          l.email && `e:${l.email}`,
          l.phoneKey && `p:${l.phoneKey}`,
        ].filter(Boolean),
      ),
    );

    let added = 0;
    for (const s of stuck) {
      if (added >= STALLED_PER_RUN) break;
      const seller = sellerById.get(s.sellerId);
      if (!seller) continue;
      const email = normalizeEmail(seller.email),
        pk = phoneKey(seller.phone);
      if (
        knownSet.has(`s:${s.sellerId}`) ||
        (email && knownSet.has(`e:${email}`)) ||
        (pk && knownSet.has(`p:${pk}`))
      )
        continue;
      await this.capture({
        name: seller.name || email || 'Merchant',
        email,
        phone: seller.phone,
        sellerId: s.sellerId,
        source: 'stalled_signup',
        sourceDetail: `Stuck at “${STEP_LABEL[s.stuckAt]}”`,
        note: `Signed up ${s.signedUpDaysAgo} days ago. Reached “${STEP_LABEL[s.stuckAt]}” and has not done “${STEP_LABEL[s.nextStep]}” for ${s.daysStuck} days.`,
      });
      added++;
    }
    if (added)
      void this.notifyManagers(
        `${added} stalled sign-up${added === 1 ? '' : 's'} added to the pipeline`,
        'Merchants who signed up but stopped before paying. Give them a call.',
        null,
      );
    return { success: true, checked: stuck.length, added };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async findExisting(
    email: string | null,
    pk: string | null,
    sellerId: string | null,
  ) {
    const or: Record<string, unknown>[] = [];
    if (email) or.push({ email });
    if (pk) or.push({ phoneKey: pk });
    if (sellerId) or.push({ sellerId });
    if (!or.length) return null;
    return this.leads
      .findOne({ isDelete: false, $or: or })
      .sort({ createdAt: 1 })
      .lean();
  }

  private cleanUtm(u: CaptureInput['utm']) {
    if (!u) return null;
    const out = {
      source: trimOrNull(u.source, 100),
      medium: trimOrNull(u.medium, 100),
      campaign: trimOrNull(u.campaign, 100),
    };
    return out.source || out.medium || out.campaign ? out : null;
  }

  /** In-app (and email) alert to whoever can see every lead: Super Admins, unrestricted admins, sales managers. */
  private async notifyManagers(
    title: string,
    body: string,
    leadId: string | null,
  ) {
    try {
      const r = this.db.repositories;
      const roles: any[] = await r.adminRoleModel
        .find({ isDelete: false, permissions: 'sales.manage' })
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
        .select('_id')
        .lean();
      const link = leadId ? `/admin/sales/leads/${leadId}` : '/admin/sales';
      await Promise.all(
        admins.map((a) =>
          this.notifications.notify({
            recipientId: String(a._id),
            recipientRole: 'admin',
            type: NOTIFICATION_TYPES.ADMIN_SALES_LEAD,
            title,
            body,
            data: { link },
          }),
        ),
      );
    } catch (e: any) {
      this.logger.warn(`Sales lead notification failed: ${e?.message}`);
    }
  }
}
