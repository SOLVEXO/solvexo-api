/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

// Buyers (User) and Sellers live in two separate collections — merged here via
// $unionWith so the admin table can page/sort/search across both as one list,
// same way the rest of the app keeps them as distinct schemas everywhere else.
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'customers',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async getStats() {
    const [totalBuyers, activeSellerAccounts, suspendedUsers, suspendedSellers] = await Promise.all([
      this.r.userModel.countDocuments({ isDelete: false }),
      this.r.sellerModel.countDocuments({ isDelete: false, status: 'active' }),
      this.r.userModel.countDocuments({ isDelete: false, status: 'suspended' }),
      this.r.sellerModel.countDocuments({ isDelete: false, status: 'suspended' }),
    ]);

    return {
      success: true,
      data: {
        totalBuyers,
        activeSellerAccounts,
        suspended: suspendedUsers + suspendedSellers,
      },
    };
  }

  private buildMatch(query: AdminUsersQueryDto) {
    const match: Record<string, unknown> = { isDelete: false };
    if (query.status) match.status = query.status;
    if (query.search) {
      const rx = { $regex: query.search, $options: 'i' };
      match.$or = [{ name: rx }, { email: rx }];
    }
    return match;
  }

  async list(query: AdminUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const buyerMatch = this.buildMatch(query);
    const sellerMatch = this.buildMatch(query);

    let rows: any[];
    let total: number;

    if (query.role === 'buyer') {
      [rows, total] = await Promise.all([
        this.r.userModel.aggregate([
          { $match: buyerMatch },
          { $addFields: { roleLabel: 'buyer' } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        this.r.userModel.countDocuments(buyerMatch),
      ]);
    } else if (query.role === 'seller') {
      [rows, total] = await Promise.all([
        this.r.sellerModel.aggregate([
          { $match: sellerMatch },
          { $addFields: { roleLabel: 'seller' } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        this.r.sellerModel.countDocuments(sellerMatch),
      ]);
    } else {
      [rows, total] = await Promise.all([
        this.r.userModel.aggregate([
          { $match: buyerMatch },
          { $addFields: { roleLabel: 'buyer' } },
          { $unionWith: { coll: 'sellers', pipeline: [{ $match: sellerMatch }, { $addFields: { roleLabel: 'seller' } }] } },
          { $sort: { createdAt: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        Promise.all([this.r.userModel.countDocuments(buyerMatch), this.r.sellerModel.countDocuments(sellerMatch)]).then(
          ([a, b]) => a + b,
        ),
      ]);
    }

    const sellerRows = rows.filter((row) => row.roleLabel === 'seller');
    const storeIds = sellerRows.map((row) => row.storeId).filter(Boolean);
    const stores = await this.r.storeModel.find({ _id: { $in: storeIds } }, { plan: 1 });
    const planByStoreId = new Map(stores.map((s) => [String(s._id), s.plan]));

    const items = rows.map((row) => ({
      id: row._id,
      name: row.name,
      email: row.email,
      role: row.roleLabel,
      plan: row.roleLabel === 'seller' ? planByStoreId.get(row.storeId) ?? 'starter' : 'free',
      status: row.status,
      createdAt: row.createdAt,
    }));

    return { success: true, data: { items, total, page, limit } };
  }

  private async findOrThrow(role: 'buyer' | 'seller', id: string) {
    // dynamic model selection: userModel/sellerModel differ in document type,
    // so the union call is widened to `any` here rather than fighting Mongoose's
    // overload resolution for two structurally different models.
    const model: any = role === 'buyer' ? this.r.userModel : this.r.sellerModel;
    const doc = await model.findOne({ _id: id, isDelete: false });
    if (!doc) throw new NotFoundException(`${role} not found`);
    return doc;
  }

  async getById(role: 'buyer' | 'seller', id: string) {
    const doc = await this.findOrThrow(role, id);
    return { success: true, data: doc };
  }

  async suspend(role: 'buyer' | 'seller', id: string, meta: AuditMeta) {
    const doc = await this.findOrThrow(role, id);

    if (role === 'buyer') {
      await this.r.userModel.findByIdAndUpdate(id, {
        $set: { status: 'suspended' },
        $inc: { tokenVersion: 1 }, // invalidates any already-issued session on its next request
      });
      this.log('buyer_suspended', `Buyer "${doc.name ?? doc.email}" set to suspended`, meta, id);
      return { success: true, message: 'Buyer set to suspended' };
    }

    // Seller suspension cascades to every store they own — otherwise their
    // listings/storefronts stay live and purchasable under a suspended
    // seller. Only the stores that were actually active at this moment are
    // recorded, so unsuspend later restores exactly those and never
    // reactivates a store that was independently suspended beforehand.
    const activeStores = await this.r.storeModel.find(
      { sellerId: id, isDelete: false, status: 'active' },
      { _id: 1 },
    );
    const storeIdsToSuspend = activeStores.map((s: any) => String(s._id));

    if (storeIdsToSuspend.length) {
      await this.r.storeModel.updateMany(
        { _id: { $in: storeIdsToSuspend } },
        { $set: { status: 'suspended' } },
      );
    }

    await this.r.sellerModel.findByIdAndUpdate(id, {
      $set: { status: 'suspended', cascadeSuspendedStoreIds: storeIdsToSuspend },
      $inc: { tokenVersion: 1 },
    });

    this.log(
      'seller_suspended',
      `Seller "${doc.name ?? doc.email}" suspended (${storeIdsToSuspend.length} store(s) suspended with it)`,
      meta,
      id,
    );
    return { success: true, message: 'Seller set to suspended' };
  }

  async unsuspend(role: 'buyer' | 'seller', id: string, meta: AuditMeta) {
    const doc = await this.findOrThrow(role, id);

    if (role === 'buyer') {
      await this.r.userModel.findByIdAndUpdate(id, { $set: { status: 'active' } });
      this.log('buyer_unsuspended', `Buyer "${doc.name ?? doc.email}" set to active`, meta, id);
      return { success: true, message: 'Buyer set to active' };
    }

    const storeIdsToRestore: string[] = (doc as any).cascadeSuspendedStoreIds ?? [];
    if (storeIdsToRestore.length) {
      // Extra `status: 'suspended'` filter guards against restoring a store
      // that got independently suspended (e.g. by moderation) while the
      // seller-level suspension was in effect.
      await this.r.storeModel.updateMany(
        { _id: { $in: storeIdsToRestore }, status: 'suspended' },
        { $set: { status: 'active' } },
      );
    }

    await this.r.sellerModel.findByIdAndUpdate(id, {
      $set: { status: 'active', cascadeSuspendedStoreIds: [] },
    });

    this.log(
      'seller_unsuspended',
      `Seller "${doc.name ?? doc.email}" unsuspended (${storeIdsToRestore.length} store(s) restored)`,
      meta,
      id,
    );
    return { success: true, message: 'Seller set to active' };
  }
}
