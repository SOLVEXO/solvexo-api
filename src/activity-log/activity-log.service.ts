/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ACTIVITY_LOG_CATEGORIES, ACTIVITY_LOG_KEEP_FOREVER, ActivityLogCategory } from './schemas/activity-log.schema';
import { ActivityLogGateway } from './activity-log.gateway';
import { resolveLocationFromIp } from '../common/geo-locate.util';
import { describeUserAgent } from '../common/user-agent.util';
import { requestActor, resolveActor } from './activity-actor.context';
import { actionTitle, categoryTitle, cleanDescription, describeChanges, formatInTimezone, orderIdsIn, safeTimezone, toCsv } from './activity-log-format.util';

export interface LogActivityInput {
  /** Omit for a platform-level action with no single store (e.g. admin managing a PlatformPlan) — stored as the 'platform' sentinel. */
  storeId?: string;
  category: ActivityLogCategory;
  action: string;
  description?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  isSecurityAlert?: boolean;
  /** Write even inside a bulk import (used for the import's own summary entry). */
  force?: boolean;
  /** Free-form extras. `metadata.changes` = [{ field, from, to }] is rendered as a before → after diff in the UI and the export. */
  metadata?: object | null;
}

/** Most rows one export may contain. Beyond this the response is flagged `truncated` instead of silently cut. */
export const EXPORT_MAX_ROWS = 50000;

/** Days a routine entry is kept (env ACTIVITY_LOG_RETENTION_DAYS, default 730 = 2 years; 0 = keep everything). */
const retentionDays = () => { const n = Number(process.env.ACTIVITY_LOG_RETENTION_DAYS ?? 730); return Number.isFinite(n) && n >= 0 ? n : 730; };

const escapeRegex = (s: string) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly gateway: ActivityLogGateway,
  ) {}

  /** Fire-and-forget write — never let logging break the caller's main flow. */
  async log(input: LogActivityInput): Promise<void> {
    // A bulk import writes ONE summary entry; the per-row entries its row handlers would add are dropped.
    if (requestActor.getStore()?.bulkImport && !input.force) return;
    const data = resolveActor(input); // staff acting for an owner is recorded as the staff member, not the owner
    try {
      // An unknown category used to make the schema enum reject the row, so the event vanished. Keep it under 'settings' and remember the original.
      let category = data.category;
      let metadata = data.metadata ?? null;
      if (!(ACTIVITY_LOG_CATEGORIES as readonly string[]).includes(category)) {
        this.logger.warn(`Unknown activity category '${category}' for action '${data.action}' — stored under 'settings'. Add it to ACTIVITY_LOG_CATEGORIES.`);
        metadata = { ...(metadata ?? {}), originalCategory: category };
        category = 'settings';
      }
      const entry = await this.databaseService.repositories.activityLogModel.create({
        storeId: data.storeId ?? 'platform',
        actorId: data.actorId ?? null,
        actorName: data.actorName ?? null,
        actorRole: data.actorRole ?? null,
        category,
        action: data.action,
        description: data.description ?? null,
        targetId: data.targetId ?? null,
        targetType: data.targetType ?? null,
        ip: data.ip ?? null,
        userAgent: data.userAgent ?? null,
        isSecurityAlert: data.isSecurityAlert ?? false,
        metadata,
        expireAt: !data.isSecurityAlert && !ACTIVITY_LOG_KEEP_FOREVER.includes(category) && retentionDays() > 0 ? new Date(Date.now() + retentionDays() * 86400000) : undefined,
      });

      this.gateway.emitNewActivity(data.storeId ?? 'platform', (await this.enrich([entry.toObject() as any]))[0]);
    } catch (err) {
      // logging must never break the operation that triggered it — but we
      // still want visibility that an entry was lost, so it's not silent.
      this.logger.error(`Failed to write activity log (${data.category}/${data.action}): ${err?.message}`);
    }
  }

  /**
   * Read-time enrichment — never persisted, so old rows benefit too: readable IP/device, the actor's real name (callers mostly store only the id),
   * "System" for automated events, a human title, and customer-facing order numbers instead of internal ids.
   */
  private async enrich<T extends { ip?: string | null; userAgent?: string | null; actorId?: string | null; actorName?: string | null; actorRole?: string | null; action?: string; description?: string | null }>(logs: T[]) {
    const { userModel, staffMemberModel, orderModel, storeModel } = this.databaseService.repositories as any;
    const isId = (v: any) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
    const actorIds = [...new Set(logs.filter((l) => !l.actorName && isId(l.actorId)).map((l) => String(l.actorId)))];
    const names = new Map<string, string>();
    try {
      if (actorIds.length) {
        const [users, staff] = await Promise.all([
          userModel.find({ _id: { $in: actorIds } }).select('name').lean(),
          staffMemberModel.find({ _id: { $in: actorIds } }).select('name').lean(),
        ]);
        for (const u of [...users, ...staff]) if (u?.name) names.set(String(u._id), u.name);
      }
    } catch (e: any) { this.logger.warn(`Actor name lookup failed: ${e?.message}`); }

    const orderIds = [...new Set(logs.flatMap((l) => orderIdsIn(l.description)))];
    const orderNumbers = new Map<string, string>();
    try {
      if (orderIds.length) {
        const orders = await orderModel.find({ _id: { $in: orderIds } }).select('orderNumber').lean();
        for (const o of orders) if (o?.orderNumber) orderNumbers.set(String(o._id), o.orderNumber);
      }
    } catch (e: any) { this.logger.warn(`Order number lookup failed: ${e?.message}`); }

    // The store's own currency / timezone, so a value in the log (a price, an amount) and its time read in that store's terms — even in the admin view.
    const storeIds = [...new Set(logs.map((l: any) => l.storeId).filter(isId).map(String))];
    const stores = new Map<string, { currency: string | null; timezone: string | null }>();
    try {
      if (storeIds.length) {
        const rows = await storeModel.find({ _id: { $in: storeIds } }).select('baseCurrency timezone').lean();
        for (const st of rows) stores.set(String(st._id), { currency: st.baseCurrency ?? null, timezone: st.timezone ?? null });
      }
    } catch (e: any) { this.logger.warn(`Store lookup failed: ${e?.message}`); }

    return logs.map((l) => {
      const system = !l.actorId && !l.actorName;
      const st = stores.get(String((l as any).storeId));
      return {
        ...l,
        actorName: l.actorName ?? (system ? 'System' : names.get(String(l.actorId)) ?? null),
        actorRole: l.actorRole || (system ? 'system' : null),
        isSystem: system,
        storeCurrency: st?.currency ?? null,
        storeTimezone: st?.timezone ?? null,
        title: actionTitle(l.action ?? ''),
        description: cleanDescription(l.description, orderNumbers),
        location: resolveLocationFromIp(l.ip),
        device: describeUserAgent(l.userAgent),
      };
    });
  }

  /** Chronological audit trail for one entity (e.g. a StoreBanner or PromotionRequest) — no separate timeline schema, this just reads ActivityLog.
   *  `storeId` narrows it to one store — always pass it for a seller caller (see `getTimelineForSeller` below) so one store's targetId guess can never surface another's timeline; omitted only by the admin (platform-wide) route. */
  async getTimeline(targetId: string, storeId?: string) {
    const logs = await this.databaseService.repositories.activityLogModel
      .find({ targetId, ...(storeId ? { storeId } : {}) })
      .sort({ createdAt: 1 })
      .lean();
    return { success: true, data: await this.enrich(logs as any[]) };
  }

  /** Seller-facing wrapper — same ownership check every other seller-facing method here does before touching this store's data. */
  async getTimelineForSeller(sellerId: string, storeId: string, targetId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    return this.getTimeline(targetId, storeId);
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  /**
   * ONE filter builder for the list, the export and both the seller and admin views — the export used to honour only category + date,
   * so what you downloaded differed from what you saw. `storeId` is forced for sellers and optional for admin.
   */
  private buildFilter(query: any, forcedStoreId?: string): Record<string, any> {
    const filter: Record<string, any> = {};
    if (forcedStoreId) filter.storeId = forcedStoreId;
    else if (query.storeId) filter.storeId = String(query.storeId);
    if (query.category) filter.category = String(query.category);
    if (query.actorId) filter.actorId = String(query.actorId);
    if (query.actorRole) filter.actorRole = String(query.actorRole);
    if (query.action) filter.action = String(query.action);
    if (query.targetType) filter.targetType = String(query.targetType);
    if (query.targetId) filter.targetId = String(query.targetId);
    if (query.isSecurityAlert !== undefined && query.isSecurityAlert !== '') filter.isSecurityAlert = query.isSecurityAlert === 'true' || query.isSecurityAlert === true;
    // Hide automated noise (daily SEO audit, recovery emails…) — everything with no human actor.
    if (query.excludeSystem === 'true' || query.excludeSystem === true) filter.actorId = filter.actorId ?? { $ne: null };
    if (query.search) {
      const rx = { $regex: escapeRegex(String(query.search).slice(0, 100)), $options: 'i' };
      filter.$or = [{ action: rx }, { description: rx }, { actorName: rx }];
    }
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      const from = query.from ? new Date(query.from) : null;
      const to = query.to ? new Date(query.to) : null;
      if (from && !Number.isNaN(from.getTime())) range.$gte = from;
      if (to && !Number.isNaN(to.getTime())) {
        // A bare date ("2026-11-20") means the whole day; a full timestamp is taken as given.
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) to.setUTCHours(23, 59, 59, 999);
        range.$lte = to;
      }
      if (Object.keys(range).length) filter.createdAt = range;
    }
    return filter;
  }

  async findAll(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 20));
    const skip = (page - 1) * limit;
    const filter = this.buildFilter(query, storeId);

    const { activityLogModel } = this.databaseService.repositories;
    const [total, logs] = await Promise.all([
      activityLogModel.countDocuments(filter),
      activityLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        logs: await this.enrich(logs as any[]),
      },
    };
  }

  async getStats(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const { activityLogModel } = this.databaseService.repositories;

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [totalEvents, staffActionsToday, activeStaffToday, securityAlerts, lastLogin] = await Promise.all([
      activityLogModel.countDocuments({ storeId, createdAt: { $gte: ninetyDaysAgo } }),
      activityLogModel.countDocuments({ storeId, createdAt: { $gte: startOfToday } }),
      activityLogModel.distinct('actorId', { storeId, createdAt: { $gte: startOfToday }, actorId: { $ne: null } }),
      activityLogModel.countDocuments({ storeId, isSecurityAlert: true, createdAt: { $gte: ninetyDaysAgo } }),
      activityLogModel
        .findOne({ storeId, category: 'security', action: 'login_success' })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    return {
      success: true,
      data: {
        totalEvents,
        staffActionsToday,
        activeStaffToday: activeStaffToday.length,
        securityAlerts,
        lastLogin: lastLogin
          ? {
              at: (lastLogin as any).createdAt,
              actorName: (await this.enrich([lastLogin as any]))[0].actorName,
              ip: (lastLogin as any).ip,
              location: resolveLocationFromIp((lastLogin as any).ip),
              device: describeUserAgent((lastLogin as any).userAgent),
            }
          : null,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — platform-wide (unscoped by storeId) equivalents. Every
  // financially-sensitive admin action across this codebase (commission-rate
  // changes, payout approve/reject/retry, manual-payment approve/reject,
  // payout-method verification) already writes here via `log()` — this is
  // simply the first read-side surface an admin can use to actually see
  // that audit trail platform-wide, rather than only per-store as a seller.
  // ═══════════════════════════════════════════════════════════════════════

  async adminFindAll(query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 50));
    const skip = (page - 1) * limit;

    const { activityLogModel } = this.databaseService.repositories;
    const filter = this.buildFilter(query);

    const [total, logs] = await Promise.all([
      activityLogModel.countDocuments(filter),
      activityLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        logs: await this.enrich(logs as any[]),
      },
    };
  }

  /** Platform-wide equivalent of getStats() above — same shape, no storeId scope. */
  async adminGetStats() {
    const { activityLogModel } = this.databaseService.repositories;

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [totalEvents, actionsToday, activeActorsToday, securityAlerts, lastLogin] = await Promise.all([
      activityLogModel.countDocuments({ createdAt: { $gte: ninetyDaysAgo } }),
      activityLogModel.countDocuments({ createdAt: { $gte: startOfToday } }),
      activityLogModel.distinct('actorId', { createdAt: { $gte: startOfToday }, actorId: { $ne: null } }),
      activityLogModel.countDocuments({ isSecurityAlert: true, createdAt: { $gte: ninetyDaysAgo } }),
      activityLogModel
        .findOne({ category: 'security', action: 'login_success' })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    return {
      success: true,
      data: {
        totalEvents,
        actionsToday,
        activeActorsToday: activeActorsToday.length,
        securityAlerts,
        lastLogin: lastLogin
          ? {
              at: (lastLogin as any).createdAt,
              actorName: (await this.enrich([lastLogin as any]))[0].actorName,
              ip: (lastLogin as any).ip,
              location: resolveLocationFromIp((lastLogin as any).ip),
              device: describeUserAgent((lastLogin as any).userAgent),
            }
          : null,
      },
    };
  }

  // ── CSV export ─────────────────────────────────────────────────────────

  private async buildCsv(filter: Record<string, any>, opts: { withStore: boolean; timeZone?: string | null }) {
    const { activityLogModel } = this.databaseService.repositories;
    const tz = safeTimezone(opts.timeZone);

    // Read in chunks (keeps memory flat) and fetch one extra row to know whether the cap cut anything off.
    const raw: any[] = [];
    let lastId: any = null;
    while (raw.length < EXPORT_MAX_ROWS + 1) {
      const chunk: any[] = await activityLogModel
        .find(lastId ? { ...filter, _id: { $lt: lastId } } : filter)
        .sort({ _id: -1 })
        .limit(Math.min(2000, EXPORT_MAX_ROWS + 1 - raw.length))
        .lean();
      if (!chunk.length) break;
      raw.push(...chunk);
      lastId = chunk[chunk.length - 1]._id;
    }
    const truncated = raw.length > EXPORT_MAX_ROWS;
    const logs = (truncated ? raw.slice(0, EXPORT_MAX_ROWS) : raw).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const rows = await this.enrich(logs);

    const header = [
      `Date & time (${tz})`, ...(opts.withStore ? ['Store'] : []), 'Category', 'Event', 'Actor', 'Role', 'Description', 'Changes (before → after)',
      'Target type', 'Target ID', 'IP', 'Location', 'Device', 'Security alert',
    ];
    const body = rows.map((l: any) => [
      formatInTimezone(l.createdAt, tz),
      ...(opts.withStore ? [l.storeId] : []),
      categoryTitle(l.category),
      l.title,
      l.actorName ?? '',
      l.actorRole ? categoryTitle(l.actorRole) : '',
      l.description ?? '',
      describeChanges(l.metadata?.changes),
      l.targetType ?? '',
      l.targetId ?? '',
      l.ip ?? '',
      [l.location?.city, l.location?.country].filter(Boolean).join(', '),
      l.device ?? '',
      l.isSecurityAlert ? 'Yes' : 'No',
    ]);
    return { csv: toCsv(header, body), count: rows.length, truncated };
  }

  async adminExportCsv(query: any) {
    return this.buildCsv(this.buildFilter(query), { withStore: true, timeZone: 'UTC' });
  }

  async exportCsv(sellerId: string, storeId: string, query: any) {
    const store: any = await this.verifyStoreOwnership(storeId, sellerId);
    return this.buildCsv(this.buildFilter(query, storeId), { withStore: false, timeZone: store.timezone });
  }
}
