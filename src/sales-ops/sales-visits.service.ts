/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { UploadService } from '../upload/upload.service';
import { assertFileSignature } from '../upload/upload-file-validation';
import { SalesLead, SalesLeadDocument } from './schemas/sales-lead.schema';
import { SalesTask, SalesTaskDocument } from './schemas/sales-task.schema';
import { SalesVisit, SalesVisitDocument } from './schemas/sales-visit.schema';
import { SalesOpsService } from './sales-ops.service';
import { INTEREST_TAGS, VISIT_PHOTO_MAX_BYTES, optionLabel } from './field-visit.constants';
import { type VisitAnswers, followUpTitle, parsePhotoDataUrl, stageAfterVisit, storeKey, visitSummary } from './field-visit.util';
import { type SalesActor, phoneKey } from './sales-ops.util';

export interface VisitInput extends VisitAnswers {
  clientId: string;
  visitedAt?: string | null;
  location?: { lat: number; lng: number; accuracyM?: number | null } | null;
  photoDataUrl?: string | null;
}
export interface VisitListQuery {
  from?: string;
  to?: string;
  rep?: string;
  area?: string;
  interest?: string;
  q?: string;
  page?: number;
  limit?: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const txt = (v?: string | null) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/**
 * What a rep types when they have no answer ("Not found", "N/A", "-", "nahi mila"). The visit keeps it as typed, but
 * it is not a name for the lead: the lead is then named after the shop.
 */
const NO_ANSWER = /^(not\s*found|n\s*\/?\s*a|none|no|nil|null|unknown|not\s*(given|available|shared|known)|nahi(\s*mila)?|-+|\.+|\?+|x+)$/i;
const realName = (v?: string | null) => { const t = txt(v); return t && !NO_ANSWER.test(t) ? t : null; };
/** Answer fields copied from the form onto the visit as they are (already validated by VisitDto). */
const ANSWER_FIELDS = [
  'unit', 'floor', 'area', 'category', 'categoryOther', 'priceRange', 'wholesale', 'contactName', 'contactRole', 'whatsapp',
  'bestTime', 'instagram', 'facebook', 'website', 'ordersPerMonth', 'courierBooking', 'billing', 'billingSoftware', 'khata',
  'bestSellers', 'problem',
] as const;
const LIST_FIELDS = ['sellsOn', 'payments', 'couriers', 'seasons', 'problemTags', 'objections'] as const;

/**
 * Field visits: a rep visits a shop and fills the visit form on their phone (offline-capable; the phone retries with the
 * same clientId). Saving a visit creates or joins the shop's lead, writes the answers to its timeline, moves its stage
 * and turns the next step into a follow-up task. Reps see their own visits; sales managers see everyone's.
 */
@Injectable()
export class SalesVisitsService {
  private readonly logger = new Logger(SalesVisitsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sales: SalesOpsService,
    private readonly upload: UploadService,
    @InjectModel(SalesVisit.name) private readonly visits: Model<SalesVisitDocument>,
    @InjectModel(SalesLead.name) private readonly leads: Model<SalesLeadDocument>,
    @InjectModel(SalesTask.name) private readonly tasks: Model<SalesTaskDocument>,
  ) {}

  async create(actor: SalesActor, input: VisitInput, now = new Date()) {
    const clientId = txt(input.clientId);
    if (!clientId) throw new BadRequestException('This visit has no id. Reload the page and save it again.');
    const already: any = await this.visits.findOne({ clientId }).lean();
    if (already) {
      if (already.adminId !== actor.adminId) throw new BadRequestException('This visit id is already used. Reload the page and save it again.');
      return this.result(already, true);
    }

    const storeName = txt(input.storeName);
    if (!storeName) throw new BadRequestException('Enter the store name.');
    const nextStepAt = input.nextStepAt ? new Date(input.nextStepAt) : null;
    if (nextStepAt && Number.isNaN(nextStepAt.getTime())) throw new BadRequestException('The next-step date is not valid.');
    if (input.nextStep !== 'none' && !nextStepAt) throw new BadRequestException('Choose a date for the next step.');
    const visitedAtRaw = input.visitedAt ? new Date(input.visitedAt) : now;
    // A phone's clock can be off; a visit is never dated in the future or more than 30 days back.
    const visitedAt =
      Number.isNaN(visitedAtRaw.getTime()) || visitedAtRaw > now || now.getTime() - visitedAtRaw.getTime() > 30 * 86_400_000 ? now : visitedAtRaw;

    const answers: Record<string, unknown> = { storeName, interest: input.interest, nextStep: input.nextStep, nextStepAt };
    for (const k of ANSWER_FIELDS) answers[k] = txt(input[k] as string | null | undefined);
    for (const k of LIST_FIELDS) answers[k] = [...new Set((input[k] ?? []).filter(Boolean))];
    if (answers.category !== 'other') answers.categoryOther = null;
    if (answers.billing !== 'software') answers.billingSoftware = null;
    const waKey = phoneKey(answers.whatsapp as string | null);
    // Permission to message needs a number to message.
    answers.waPermission = !!input.waPermission && !!waKey;

    const photo = await this.storePhoto(input.photoDataUrl);
    const lead = await this.findOrCreateLead(actor, answers as unknown as VisitAnswers, waKey);
    const leadId = String(lead._id);

    let visit: any;
    try {
      visit = await this.visits.create({
        ...answers,
        clientId,
        leadId,
        adminId: actor.adminId,
        visitedAt,
        storeKey: storeKey(storeName),
        whatsappKey: waKey,
        location: this.cleanLocation(input.location),
        photoUrl: photo?.url ?? null,
        photoPublicId: photo?.publicId ?? null,
      });
    } catch (e: any) {
      // Two syncs of the same visit at once: the other one won.
      if (e?.code === 11000) return this.result(await this.visits.findOne({ clientId }).lean(), true);
      throw e;
    }
    const visitId = String(visit._id);

    await this.sales.log(leadId, 'visit', visitSummary(answers as unknown as VisitAnswers), actor.adminId, {
      visitId,
      interest: input.interest,
      ...(photo ? { photoUrl: photo.url } : {}),
    });

    const set: Record<string, unknown> = {
      lastActivityAt: now,
      tags: [...(lead.tags ?? []).filter((t: string) => !(INTEREST_TAGS as readonly string[]).includes(t)), optionLabel('interest', input.interest).toLowerCase()],
    };
    // Fill gaps on the lead from what the rep learnt, never overwriting what is already there.
    if (!lead.phone && waKey) Object.assign(set, { phone: answers.whatsapp, phoneKey: waKey });
    if (!lead.businessName) set.businessName = storeName;
    if (!lead.city && answers.area) set.city = answers.area;
    if (!lead.businessType && answers.category) set.businessType = optionLabel('category', answers.category as string);
    await this.leads.updateOne({ _id: leadId }, { $set: set });

    const move = stageAfterVisit(lead.stage, input.interest);
    if (move)
      await this.sales.setStage(
        lead,
        move.stage,
        actor.adminId,
        move.lost ? { lostReason: 'not_a_fit', lostNote: 'Not interested at a field visit.' } : { lostReason: null, lostNote: null },
        move.lost ? 'Not interested at a field visit.' : 'Field visit.',
      );

    const title = followUpTitle(input.nextStep, storeName);
    if (title && nextStepAt) {
      const task: any = await this.tasks.create({
        leadId,
        title,
        dueAt: nextStepAt,
        // The lead's owner follows up; a rep visiting someone else's lead hands the next step to them.
        assigneeAdminId: lead.ownerAdminId ?? actor.adminId,
        createdByAdminId: actor.adminId,
      });
      await this.visits.updateOne({ _id: visitId }, { $set: { taskId: String(task._id) } });
      visit.taskId = String(task._id);
    }
    await this.sales.refreshFollowUp(leadId);
    return this.result(visit.toObject ? visit.toObject() : visit, false, lead);
  }

  async list(actor: SalesActor, q: VisitListQuery) {
    const filter: Record<string, unknown> = { isDelete: false };
    if (!actor.canSeeAll) filter.adminId = actor.adminId;
    else if (q.rep) filter.adminId = q.rep === 'me' ? actor.adminId : q.rep;
    const range: Record<string, Date> = {};
    if (q.from && !Number.isNaN(new Date(q.from).getTime())) range.$gte = new Date(q.from);
    if (q.to && !Number.isNaN(new Date(q.to).getTime())) range.$lt = new Date(q.to);
    if (Object.keys(range).length) filter.visitedAt = range;
    if (q.area) filter.area = q.area;
    if (q.interest) filter.interest = q.interest;
    if (q.q?.trim()) {
      const rx = new RegExp(esc(q.q.trim()), 'i');
      filter.$or = [{ storeName: rx }, { contactName: rx }, { whatsapp: rx }, { area: rx }];
    }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 2000),
      page = Math.max(Number(q.page) || 1, 1);
    const [items, total, all] = await Promise.all([
      this.visits.find(filter).sort({ visitedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.visits.countDocuments(filter),
      this.visits.find(filter).select('interest nextStep leadId').lean(),
    ]);
    const names = await this.adminNames(items.map((v: any) => v.adminId));
    return {
      success: true,
      data: {
        items: items.map((v: any) => this.view(v, names)),
        total,
        page,
        limit,
        summary: {
          visits: all.length,
          shops: new Set(all.map((v: any) => v.leadId)).size,
          hot: all.filter((v: any) => v.interest === 'hot').length,
          demos: all.filter((v: any) => v.nextStep === 'demo').length,
          signups: all.filter((v: any) => v.nextStep === 'signup').length,
        },
      },
    };
  }

  async get(actor: SalesActor, id: string) {
    const v: any = await this.mustFind(actor, id);
    return { success: true, data: this.view(v, await this.adminNames([v.adminId])) };
  }

  /** Corrects a saved visit's answers. The lead, its stage and the follow-up task are not changed again. */
  async update(actor: SalesActor, id: string, input: Partial<VisitInput>) {
    const v: any = await this.mustFind(actor, id);
    const set: Record<string, unknown> = {};
    if (input.storeName !== undefined) {
      const name = txt(input.storeName);
      if (!name) throw new BadRequestException('Enter the store name.');
      Object.assign(set, { storeName: name, storeKey: storeKey(name) });
    }
    for (const k of ANSWER_FIELDS) if (input[k] !== undefined) set[k] = txt(input[k] as string | null);
    for (const k of LIST_FIELDS) if (input[k] !== undefined) set[k] = [...new Set((input[k] ?? []).filter(Boolean))];
    if (input.interest !== undefined) set.interest = input.interest;
    if (input.nextStep !== undefined) set.nextStep = input.nextStep;
    if (input.waPermission !== undefined) set.waPermission = !!input.waPermission;
    if (set.whatsapp !== undefined) set.whatsappKey = phoneKey(set.whatsapp as string | null);
    if (set.category !== undefined && set.category !== 'other') set.categoryOther = null;
    if (set.billing !== undefined && set.billing !== 'software') set.billingSoftware = null;
    await this.visits.updateOne({ _id: v._id }, { $set: set });
    return this.get(actor, id);
  }

  /** Earlier visits to the same shop (same WhatsApp number, or same name in the same area), newest first. */
  async check(phone?: string, storeName?: string, area?: string) {
    const or: Record<string, unknown>[] = [];
    const pk = phoneKey(phone);
    if (pk) or.push({ whatsappKey: pk });
    const sk = storeKey(storeName);
    if (sk.length >= 3) or.push(area?.trim() ? { storeKey: sk, area: area.trim() } : { storeKey: sk });
    if (!or.length) return { success: true, data: [] };
    const rows: any[] = await this.visits.find({ isDelete: false, $or: or }).sort({ visitedAt: -1 }).limit(5).lean();
    const names = await this.adminNames(rows.map((r) => r.adminId));
    return {
      success: true,
      data: rows.map((r) => ({
        _id: String(r._id),
        leadId: r.leadId,
        storeName: r.storeName,
        area: r.area,
        visitedAt: r.visitedAt,
        adminName: names.get(r.adminId) ?? null,
        interest: r.interest,
        nextStep: r.nextStep,
        nextStepAt: r.nextStepAt,
        samePhone: !!pk && r.whatsappKey === pk,
      })),
    };
  }

  /** Markets / areas the team has visited, most-used first, for the form's area chips. */
  async areas() {
    const rows: any[] = await this.visits.aggregate([
      { $match: { isDelete: false, area: { $ne: null } } },
      { $group: { _id: '$area', n: { $sum: 1 }, last: { $max: '$visitedAt' } } },
      { $sort: { n: -1, last: -1 } },
      { $limit: 200 },
    ]);
    return { success: true, data: rows.map((r) => r._id as string) };
  }

  /** Visits per rep in a date range (Team targets). */
  async countByRep(from: Date, to: Date): Promise<Map<string, number>> {
    const rows: any[] = await this.visits.aggregate([
      { $match: { isDelete: false, visitedAt: { $gte: from, $lt: to } } },
      { $group: { _id: '$adminId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.n as number]));
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async findOrCreateLead(actor: SalesActor, v: VisitAnswers, waKey: string | null): Promise<any> {
    if (waKey) {
      const existing = await this.leads.findOne({ isDelete: false, phoneKey: waKey }).lean();
      if (existing) {
        // A lead nobody owns goes to the rep who visited it.
        if (!existing.ownerAdminId) {
          await this.leads.updateOne({ _id: existing._id }, { $set: { ownerAdminId: actor.adminId } });
          (existing as any).ownerAdminId = actor.adminId;
        }
        return existing;
      }
    }
    const lead: any = await this.leads.create({
      name: realName(v.contactName) ?? v.storeName,
      businessName: v.storeName,
      // Only a real number (7+ digits) becomes the lead's phone; "Not found" stays on the visit only.
      phone: waKey ? txt(v.whatsapp) : null,
      phoneKey: waKey,
      city: txt(v.area),
      businessType: v.category ? (v.category === 'other' ? txt(v.categoryOther) : optionLabel('category', v.category)) : null,
      source: 'field_visit',
      ownerAdminId: actor.adminId,
      createdByAdminId: actor.adminId,
      stage: 'new',
      stageChangedAt: new Date(),
    });
    await this.sales.log(String(lead._id), 'system', 'Lead added (source: field visit).', actor.adminId);
    await this.sales.linkLead(lead).catch(() => false);
    return lead.toObject ? lead.toObject() : lead;
  }

  /** Uploads the shop photo. A photo that cannot be stored never loses the visit: it is saved without it. */
  private async storePhoto(dataUrl?: string | null) {
    if (!dataUrl) return null;
    const parsed = parsePhotoDataUrl(dataUrl);
    if (!parsed) throw new BadRequestException('The shop photo must be a JPEG, PNG or WebP image.');
    if (parsed.buffer.length > VISIT_PHOTO_MAX_BYTES) throw new BadRequestException('The shop photo is too large. Take it again (it should be under 700 KB).');
    assertFileSignature({ originalname: `shop.${parsed.ext}`, mimetype: parsed.mimetype, buffer: parsed.buffer, size: parsed.buffer.length });
    try {
      return await this.upload.uploadFile(
        { buffer: parsed.buffer, mimetype: parsed.mimetype, originalname: `shop.${parsed.ext}`, size: parsed.buffer.length } as Express.Multer.File,
        { folder: 'sales/visits', maxDimension: 1600 },
      );
    } catch (e) {
      this.logger.warn(`Visit photo upload failed: ${(e as Error)?.message}`);
      return null;
    }
  }

  private cleanLocation(loc?: VisitInput['location']) {
    if (!loc) return null;
    const lat = Number(loc.lat),
      lng = Number(loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const acc = Number(loc.accuracyM);
    return { lat, lng, accuracyM: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
  }

  private async mustFind(actor: SalesActor, id: string) {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new NotFoundException('Visit not found.');
    const v = await this.visits.findOne({ _id: id, isDelete: false, ...(actor.canSeeAll ? {} : { adminId: actor.adminId }) }).lean();
    if (!v) throw new NotFoundException('Visit not found.');
    return v;
  }

  private async result(visit: any, duplicate: boolean, lead?: any) {
    const l: any = lead ?? (await this.leads.findById(visit.leadId).select('ownerAdminId').lean());
    const names = await this.adminNames([visit.adminId, l?.ownerAdminId]);
    return {
      success: true,
      data: {
        visit: this.view(visit, names),
        leadId: visit.leadId,
        alreadySaved: duplicate,
        followUpOwner: visit.taskId && l?.ownerAdminId ? (names.get(l.ownerAdminId) ?? null) : null,
      },
    };
  }

  private view(v: any, names: Map<string, string>) {
    const { storeKey: _sk, whatsappKey: _wk, photoPublicId: _p, isDelete: _d, __v, ...rest } = v;
    return { ...rest, _id: String(v._id), adminName: names.get(v.adminId) ?? null };
  }

  private async adminNames(ids: (string | null | undefined)[]) {
    const uniq = [...new Set(ids.filter((x): x is string => !!x && /^[a-f0-9]{24}$/i.test(x)))];
    if (!uniq.length) return new Map<string, string>();
    const rows: any[] = await this.db.repositories.adminModel.find({ _id: { $in: uniq } }).select('name').lean();
    return new Map(rows.map((a) => [String(a._id), a.name as string]));
  }
}
