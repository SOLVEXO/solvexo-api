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

// This page lists SELLER ACCOUNTS only (`sellerModel`) — a buyer has no
// store of their own (they're a global identity who can order from any
// store), so they don't belong in a per-account admin list the way a seller
// does. Buyers are instead reached per-store, via a store's own customers
// list (StoreService.getStoreCustomersAdmin / setCustomerBlockedAdmin,
// exposed through AdminUsersController's `stores/:storeId/customers`
// routes) — matching how a real per-store admin (Shopify) shows customers,
// and how a real marketplace's platform-wide fraud ban still needs to exist
// (this service's own suspend/unsuspend below, callable with role:'buyer'
// once a buyer id is known from that per-store list).
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
    const match = this.buildMatch(query);

    const [rows, total] = await Promise.all([
      this.r.sellerModel
        .find(match)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.r.sellerModel.countDocuments(match),
    ]);

    // A seller can own MORE THAN ONE store (confirmed against Store.sellerId,
    // which has no unique constraint — same as a real Shopify account can run
    // several independent stores). `Seller.storeId` is a legacy single-store
    // field that predates that and is unreliable once a seller has more than
    // one, so store count/plan here is always computed fresh from the real
    // Store collection, never read off that field.
    const sellerIds = rows.map((row) => String(row._id));
    const stores = sellerIds.length
      ? await this.r.storeModel.find({ sellerId: { $in: sellerIds }, isDelete: false }, { sellerId: 1 }).lean()
      : [];
    const storeCountBySellerId = new Map<string, number>();
    for (const s of stores) {
      const key = String((s as any).sellerId);
      storeCountBySellerId.set(key, (storeCountBySellerId.get(key) ?? 0) + 1);
    }

    const items = rows.map((row: any) => ({
      id: row._id,
      name: row.name,
      email: row.email,
      status: row.status,
      createdAt: row.createdAt,
      storeCount: storeCountBySellerId.get(String(row._id)) ?? 0,
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

    if (role === 'seller') {
      // The seller's own stores, fetched fresh (see `list()`'s comment above
      // on why — never off the legacy single-store `Seller.storeId` field).
      const stores = await this.r.storeModel
        .find({ sellerId: id, isDelete: false }, { name: 1, slug: 1, status: 1, plan: 1 })
        .lean();
      return { success: true, data: { ...(doc as any).toObject(), stores } };
    }

    return { success: true, data: doc };
  }

  async suspend(role: 'buyer' | 'seller', id: string, meta: AuditMeta) {
    const doc = await this.findOrThrow(role, id);

    if (role === 'buyer') {
      await this.r.userModel.findByIdAndUpdate(id, {
        $set: { status: 'suspended' },
        $inc: { tokenVersion: 1 }, // invalidates any already-issued session on its next request
      });
      this.log('buyer_suspended', `Buyer "${doc.name ?? doc.email}" set to suspended (platform-wide)`, meta, id);
      return { success: true, message: 'Buyer set to suspended' };
    }

    // Seller suspension cascades to EVERY store they own — otherwise their
    // listings/storefronts stay live and purchasable under a suspended
    // seller. Only the stores that were actually active at this moment are
    // recorded, so unsuspend later restores exactly those and never
    // reactivates a store that was independently suspended beforehand (e.g.
    // via the single-store suspendStore/unsuspendStore below).
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
      this.log('buyer_unsuspended', `Buyer "${doc.name ?? doc.email}" set to active (platform-wide)`, meta, id);
      return { success: true, message: 'Buyer set to active' };
    }

    const storeIdsToRestore: string[] = (doc as any).cascadeSuspendedStoreIds ?? [];
    if (storeIdsToRestore.length) {
      // Extra `status: 'suspended'` filter guards against restoring a store
      // that got independently suspended (e.g. via suspendStore below) while
      // the seller-level suspension was in effect.
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

  // ── Single-store suspend/unsuspend — independent of the seller account,
  // for the "one of my 40 stores is doing something wrong" case where
  // suspending the whole seller (and their 39 other, fine stores) would be
  // disproportionate. Reuses the exact same Store.status field the
  // seller-level cascade above already uses, so every existing "is this
  // store live" check (storefront browse, checkout) already respects it with
  // no further changes needed. ──

  async suspendStore(storeId: string, meta: AuditMeta) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.status !== 'active') {
      throw new BadRequestException(`Only an active store can be suspended (current status: ${store.status})`);
    }

    await this.r.storeModel.findByIdAndUpdate(storeId, { $set: { status: 'suspended' } });
    this.log(
      'store_suspended',
      `Store "${store.name}" suspended individually (seller account and their other store(s) left untouched)`,
      meta,
      storeId,
    );
    return { success: true, message: 'Store suspended' };
  }

  async unsuspendStore(storeId: string, meta: AuditMeta) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.status !== 'suspended') {
      throw new BadRequestException(`Store is not suspended (current status: ${store.status})`);
    }

    await this.r.storeModel.findByIdAndUpdate(storeId, { $set: { status: 'active' } });
    this.log('store_unsuspended', `Store "${store.name}" restored individually`, meta, storeId);
    return { success: true, message: 'Store restored' };
  }
}
