/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogCategory } from './schemas/activity-log.schema';
import { ActivityLogGateway } from './activity-log.gateway';

export interface LogActivityInput {
  storeId: string;
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
  metadata?: object | null;
}

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly gateway: ActivityLogGateway,
  ) {}

  /** Fire-and-forget write — never let logging break the caller's main flow. */
  async log(data: LogActivityInput): Promise<void> {
    try {
      const entry = await this.databaseService.repositories.activityLogModel.create({
        storeId: data.storeId,
        actorId: data.actorId ?? null,
        actorName: data.actorName ?? null,
        actorRole: data.actorRole ?? null,
        category: data.category,
        action: data.action,
        description: data.description ?? null,
        targetId: data.targetId ?? null,
        targetType: data.targetType ?? null,
        ip: data.ip ?? null,
        userAgent: data.userAgent ?? null,
        isSecurityAlert: data.isSecurityAlert ?? false,
        metadata: data.metadata ?? null,
      });

      this.gateway.emitNewActivity(data.storeId, entry.toObject());
    } catch (err) {
      // logging must never break the operation that triggered it — but we
      // still want visibility that an entry was lost, so it's not silent.
      this.logger.error(`Failed to write activity log (${data.category}/${data.action}): ${err?.message}`);
    }
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  async findAll(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter: any = { storeId };
    if (query.category) filter.category = query.category;
    if (query.actorId) filter.actorId = query.actorId;
    if (query.action) filter.action = query.action;
    if (query.search) {
      filter.$or = [
        { action: { $regex: query.search, $options: 'i' } },
        { description: { $regex: query.search, $options: 'i' } },
        { actorName: { $regex: query.search, $options: 'i' } },
      ];
    }
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) {
        const t = new Date(query.to);
        t.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = t;
      }
    }

    const { activityLogModel } = this.databaseService.repositories;
    const total = await activityLogModel.countDocuments(filter);
    const logs = await activityLogModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        logs,
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
          ? { at: (lastLogin as any).createdAt, actorName: (lastLogin as any).actorName, ip: (lastLogin as any).ip, userAgent: (lastLogin as any).userAgent }
          : null,
      },
    };
  }

  async exportCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(storeId, sellerId);

    const { activityLogModel } = this.databaseService.repositories;

    const filter: any = { storeId };
    if (query.category) filter.category = query.category;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) filter.createdAt.$lte = new Date(query.to);
    }

    const logs = await activityLogModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const header = ['Date', 'Category', 'Action', 'Actor', 'Role', 'Description', 'IP'];
    const rows = logs.map((l: any) => [
      new Date(l.createdAt).toISOString(),
      l.category,
      l.action,
      l.actorName ?? l.actorId ?? '',
      l.actorRole ?? '',
      (l.description ?? '').replace(/"/g, "'"),
      l.ip ?? '',
    ]);

    const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
    return [header, ...rows].map((r) => r.map(escape).join(',')).join('\n');
  }
}
