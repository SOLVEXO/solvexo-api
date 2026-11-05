/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { StoreService } from '../store/store.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { toCsv } from '../analytics/utils/csv.util';
import { compileSegmentFilter, normalizeSegmentFilter, SegmentFilter } from './segment-filter.util';

/** Max saved segments per store (Shopify also caps segments). */
export const MAX_SEGMENTS_PER_STORE = 50;

@Injectable()
export class CustomerSegmentsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get repos() { return this.databaseService.repositories; }
  private get model() { return this.repos.customerSegmentModel; }

  /** Store ownership is ALWAYS re-verified here (the storeId comes from the URL, never trusted on its own). */
  private async assertOwned(storeId: string, sellerId: string) {
    return verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
  }

  private view(s: any) {
    return { id: String(s._id), name: s.name, description: s.description ?? '', filter: s.filter, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }

  private async owned(storeId: string, segmentId: string) {
    if (!isValidObjectId(segmentId)) throw new NotFoundException('Segment not found');
    const s = await this.model.findOne({ _id: segmentId, storeId }).lean();
    if (!s) throw new NotFoundException('Segment not found');
    return s;
  }

  private cleanName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || name.length > 80) throw new BadRequestException('Name is required (max 80 characters)');
    return name;
  }

  private async assertNameFree(storeId: string, name: string, exceptId?: string) {
    const clash = await this.model.findOne({ storeId, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('_id').lean();
    if (clash) throw new BadRequestException('A segment with this name already exists');
  }

  private log(storeId: string, actorId: string, action: string, description: string, targetId: string) {
    this.activityLogService.log({ storeId, category: 'customers', action, description, actorId, actorRole: 'seller', targetId, targetType: 'CustomerSegment' }).catch(() => undefined);
  }

  async list(storeId: string, sellerId: string) {
    await this.assertOwned(storeId, sellerId);
    const rows = await this.model.find({ storeId }).sort({ createdAt: -1 }).limit(MAX_SEGMENTS_PER_STORE).lean();
    return { success: true, data: { segments: rows.map((r) => this.view(r)), limit: MAX_SEGMENTS_PER_STORE } };
  }

  async get(storeId: string, sellerId: string, segmentId: string) {
    await this.assertOwned(storeId, sellerId);
    return { success: true, data: this.view(await this.owned(storeId, segmentId)) };
  }

  async create(storeId: string, sellerId: string, body: { name?: unknown; description?: unknown; filter?: unknown }) {
    await this.assertOwned(storeId, sellerId);
    const name = this.cleanName(body.name);
    const filter = normalizeSegmentFilter(body.filter);
    if ((await this.model.countDocuments({ storeId })) >= MAX_SEGMENTS_PER_STORE) {
      throw new BadRequestException(`You can save up to ${MAX_SEGMENTS_PER_STORE} segments — delete one first`);
    }
    await this.assertNameFree(storeId, name);
    const doc = await this.model.create({ storeId, name, description: this.cleanDescription(body.description), filter, createdBy: sellerId });
    this.log(storeId, sellerId, 'segment_created', `Customer segment "${name}" created`, String(doc._id));
    return { success: true, data: this.view(doc.toObject()) };
  }

  private cleanDescription(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().slice(0, 300) : '';
  }

  async update(storeId: string, sellerId: string, segmentId: string, body: { name?: unknown; description?: unknown; filter?: unknown }) {
    await this.assertOwned(storeId, sellerId);
    const existing = await this.owned(storeId, segmentId);
    const $set: Record<string, unknown> = {};
    if (body.name !== undefined) { $set.name = this.cleanName(body.name); await this.assertNameFree(storeId, $set.name as string, segmentId); }
    if (body.description !== undefined) $set.description = this.cleanDescription(body.description);
    if (body.filter !== undefined) $set.filter = normalizeSegmentFilter(body.filter);
    const doc = await this.model.findOneAndUpdate({ _id: segmentId, storeId }, { $set }, { new: true }).lean();
    this.log(storeId, sellerId, 'segment_updated', `Customer segment "${(doc as any)?.name ?? existing.name}" updated`, segmentId);
    return { success: true, data: this.view(doc) };
  }

  async remove(storeId: string, sellerId: string, segmentId: string) {
    await this.assertOwned(storeId, sellerId);
    const existing = await this.owned(storeId, segmentId);
    await this.model.deleteOne({ _id: segmentId, storeId });
    this.log(storeId, sellerId, 'segment_deleted', `Customer segment "${existing.name}" deleted`, segmentId);
    return { success: true, message: 'Segment deleted' };
  }

  async duplicate(storeId: string, sellerId: string, segmentId: string) {
    await this.assertOwned(storeId, sellerId);
    const existing = await this.owned(storeId, segmentId);
    if ((await this.model.countDocuments({ storeId })) >= MAX_SEGMENTS_PER_STORE) {
      throw new BadRequestException(`You can save up to ${MAX_SEGMENTS_PER_STORE} segments — delete one first`);
    }
    let name = `${existing.name} (copy)`.slice(0, 80);
    for (let i = 2; await this.model.exists({ storeId, name }); i++) name = `${existing.name} (copy ${i})`.slice(0, 80);
    const doc = await this.model.create({ storeId, name, description: existing.description, filter: existing.filter, createdBy: sellerId });
    this.log(storeId, sellerId, 'segment_created', `Customer segment "${name}" duplicated`, String(doc._id));
    return { success: true, data: this.view(doc.toObject()) };
  }

  /** Live count for an UNSAVED filter (the builder's preview). */
  async preview(storeId: string, sellerId: string, rawFilter: unknown) {
    await this.assertOwned(storeId, sellerId);
    const filter = normalizeSegmentFilter(rawFilter);
    const count = await this.storeService.querySegmentMembers(storeId, compileSegmentFilter(filter), { mode: 'count' });
    return { success: true, data: { count } };
  }

  async count(storeId: string, sellerId: string, segmentId: string) {
    await this.assertOwned(storeId, sellerId);
    const s = await this.owned(storeId, segmentId);
    const count = await this.storeService.querySegmentMembers(storeId, compileSegmentFilter(s.filter), { mode: 'count' });
    return { success: true, data: { count } };
  }

  async members(storeId: string, sellerId: string, segmentId: string, query: { page?: string; limit?: string; search?: string }) {
    await this.assertOwned(storeId, sellerId);
    const s = await this.owned(storeId, segmentId);
    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : undefined;
    const data = await this.storeService.querySegmentMembers(storeId, compileSegmentFilter(s.filter), {
      mode: 'list', page: parseInt(query.page ?? '1', 10) || 1, limit: parseInt(query.limit ?? '20', 10) || 20, search,
    });
    return { success: true, data };
  }

  async exportCsv(storeId: string, sellerId: string, segmentId: string): Promise<{ filename: string; csv: string }> {
    await this.assertOwned(storeId, sellerId);
    const s = await this.owned(storeId, segmentId);
    const rows: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const { customers, pagination } = await this.storeService.querySegmentMembers(storeId, compileSegmentFilter(s.filter), { mode: 'list', page, limit: 100 });
      rows.push(...customers);
      if (page >= pagination.totalPages) break;
    }
    const csv = toCsv(
      ['Name', 'Email', 'Phone', 'Orders', 'Total spent', 'Last order', 'Marketing', 'Tags'],
      rows.map((c) => [c.name ?? '', c.email ?? '', c.phone ?? '', c.orderCount ?? 0, c.totalSpent ?? 0, c.lastOrderAt ? new Date(c.lastOrderAt).toISOString().slice(0, 10) : '', c.marketingStatus ?? '', (c.tags ?? []).join('; ')]),
    );
    this.log(storeId, sellerId, 'segment_exported', `Customer segment "${s.name}" exported (${rows.length} rows)`, segmentId);
    return { filename: `segment-${s.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`, csv };
  }

  // ── Internal: audience resolution for campaigns / discounts (evaluated at send/redeem time, never snapshotted) ──

  /** Loads a segment's filter for a store WITHOUT a seller check — callers pass a storeId they already authorized. */
  async loadFilter(storeId: string, segmentId: string): Promise<SegmentFilter | null> {
    if (!isValidObjectId(segmentId)) return null;
    const s: any = await this.model.findOne({ _id: segmentId, storeId }).select('filter').lean();
    return s?.filter ?? null;
  }

  /** User ids (and emails) of the segment's current members. Empty when the segment no longer exists for this store. */
  async resolveMembers(storeId: string, segmentId: string): Promise<{ ids: Set<string>; emails: Set<string> } | null> {
    const filter = await this.loadFilter(storeId, segmentId);
    if (!filter) return null;
    const rows: any[] = await this.storeService.querySegmentMembers(storeId, compileSegmentFilter(normalizeSegmentFilter(filter)), { mode: 'ids' });
    return { ids: new Set(rows.map((r) => String(r._id))), emails: new Set(rows.map((r) => String(r.email ?? '').toLowerCase()).filter(Boolean)) };
  }

  /** Whether ONE customer is currently in the segment (discount eligibility at redeem time). */
  async isMember(storeId: string, segmentId: string, customerId: string): Promise<boolean> {
    const filter = await this.loadFilter(storeId, segmentId);
    if (!filter || !customerId) return false;
    const n = await this.storeService.querySegmentMembers(storeId, compileSegmentFilter(normalizeSegmentFilter(filter)), { mode: 'count', onlyCustomerId: String(customerId) });
    return n > 0;
  }
}
