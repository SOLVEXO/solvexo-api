/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { HAS_NTN_FILTER, storeTrustSnapshot } from '../seller-trust/seller-trust.service';

// "Worst" = furthest from verified — a seller row shows the store that needs attention most.
const VERIFICATION_WORST_FIRST = ['rejected', 'needs_info', 'not_started', 'pending', 'under_review', 'verified'];
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
const STORE_TRUST_FIELDS = { sellerId: 1, categoryId: 1, country: 1, createdAt: 1, taxId: 1, 'verification.taxId': 1, verificationStatus: 1, verificationDueAt: 1, riskLevel: 1, riskReasons: 1, payoutHold: 1 };
const csvEsc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

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

  private async buildMatch(query: AdminUsersQueryDto) {
    const match: Record<string, unknown> = { isDelete: false };
    if (query.status) match.status = query.status;
    if (query.search) {
      const rx = { $regex: query.search, $options: 'i' };
      match.$or = [{ name: rx }, { email: rx }];
    }
    // Store-level seller-trust filters → the sellers owning at least one matching store.
    const storeAnd: Record<string, unknown>[] = [];
    if (query.country) {
      const c = query.country.trim().toUpperCase();
      storeAnd.push(c === 'PK' ? { country: { $in: ['PK', null] } } : { country: c });
    }
    if (query.ntn === 'yes') storeAnd.push(HAS_NTN_FILTER);
    if (query.ntn === 'no') storeAnd.push({ $nor: HAS_NTN_FILTER.$or });
    if (query.verification) storeAnd.push(query.verification === 'not_started' ? { verificationStatus: { $in: ['not_started', null] } } : { verificationStatus: query.verification });
    if (query.risk) storeAnd.push(query.risk === 'low' ? { riskLevel: { $in: ['low', null] } } : { riskLevel: query.risk });
    if (storeAnd.length) {
      const sellerIds: string[] = await this.r.storeModel.distinct('sellerId', { isDelete: false, $and: storeAnd });
      match._id = { $in: sellerIds.filter(Boolean) };
    }
    return match;
  }

  /** Per-seller trust columns from their stores (primary store = the oldest). */
  private async trustBySeller(sellerIds: string[]) {
    const stores: any[] = sellerIds.length
      ? await this.r.storeModel.find({ sellerId: { $in: sellerIds }, isDelete: false }, STORE_TRUST_FIELDS).sort({ createdAt: 1 }).lean()
      : [];
    const categoryIds = [...new Set(stores.map((s) => s.categoryId).filter(Boolean))];
    const categories: any[] = categoryIds.length ? await this.r.categoryModel.find({ _id: { $in: categoryIds } }, { name: 1 }).lean() : [];
    const categoryById = new Map(categories.map((c) => [String(c._id), c.name as string]));
    const out = new Map<string, { storeCount: number; country: string | null; hasNtn: boolean; ntn: string | null; verificationStatus: string | null; riskLevel: string | null; dueAt: Date | null; sells: string | null }>();
    for (const s of stores) {
      const key = String(s.sellerId);
      const t = storeTrustSnapshot(s);
      const cur = out.get(key);
      // Earliest deadline among the seller's not-yet-verified stores.
      const due = t.verificationStatus !== 'verified' ? t.dueAt : null;
      if (!cur) {
        out.set(key, { storeCount: 1, country: s.country ?? 'PK', hasNtn: t.hasNtn, ntn: t.ntn, verificationStatus: t.verificationStatus, riskLevel: t.riskLevel, dueAt: due, sells: s.categoryId ? categoryById.get(String(s.categoryId)) ?? null : null });
        continue;
      }
      if (due && (!cur.dueAt || due < cur.dueAt)) cur.dueAt = due;
      if (!cur.sells && s.categoryId) cur.sells = categoryById.get(String(s.categoryId)) ?? null;
      cur.storeCount++;
      cur.hasNtn = cur.hasNtn || t.hasNtn;
      cur.ntn = cur.ntn ?? t.ntn;
      if (VERIFICATION_WORST_FIRST.indexOf(t.verificationStatus) < VERIFICATION_WORST_FIRST.indexOf(cur.verificationStatus ?? 'verified')) cur.verificationStatus = t.verificationStatus;
      if ((RISK_RANK[t.riskLevel] ?? 0) > (RISK_RANK[cur.riskLevel ?? 'low'] ?? 0)) cur.riskLevel = t.riskLevel;
    }
    return out;
  }

  /** CSV of the seller list (same filters, every page). */
  async exportCsv(query: AdminUsersQueryDto): Promise<string> {
    const match = await this.buildMatch(query);
    const rows: any[] = await this.r.sellerModel.find(match, { name: 1, email: 1, phone: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(20_000).lean();
    const trust = await this.trustBySeller(rows.map((row) => String(row._id)));
    const head = ['name', 'email', 'phone', 'status', 'stores', 'country', 'ntn', 'verification', 'risk', 'due_date', 'sells', 'created_at'];
    const lines = rows.map((row) => {
      const t = trust.get(String(row._id));
      return [row.name, row.email, row.phone, row.status, t?.storeCount ?? 0, t?.country, t?.ntn ?? '', t?.verificationStatus, t?.riskLevel,
        t?.dueAt ? new Date(t.dueAt).toISOString().slice(0, 10) : '', t?.sells ?? '',
        row.createdAt ? new Date(row.createdAt).toISOString().slice(0, 10) : ''].map(csvEsc).join(',');
    });
    return [head.join(','), ...lines].join('\n');
  }

  async list(query: AdminUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const match = await this.buildMatch(query);

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
    const trust = await this.trustBySeller(sellerIds);

    const items = rows.map((row: any) => {
      const t = trust.get(String(row._id));
      return {
        id: row._id,
        name: row.name,
        email: row.email,
        status: row.status,
        createdAt: row.createdAt,
        storeCount: t?.storeCount ?? 0,
        // Seller trust columns (additive): primary store country, NTN on any store, worst verification, max risk.
        phone: row.phone ?? null,
        country: t?.country ?? null,
        hasNtn: t?.hasNtn ?? false,
        ntn: t?.ntn ?? null,
        verificationStatus: t?.verificationStatus ?? null,
        riskLevel: t?.riskLevel ?? null,
        dueAt: t?.dueAt ?? null,
        // Primary store's category name.
        sells: t?.sells ?? null,
      };
    });

    return { success: true, data: { items, total, page, limit } };
  }

  private async findOrThrow(role: 'buyer' | 'seller', id: string) {
    // dynamic model selection: userModel/sellerModel differ in document type,
    // so the union call is widened to `any` here rather than fighting Mongoose's
    // overload resolution for two structurally different models.
    const model: any = role === 'buyer' ? this.r.userModel : this.r.sellerModel;
    // Credentials/OTP state never leave this service (the doc is returned
    // as-is by getById) — kept off the query itself rather than stripped later.
    const doc = await model.findOne({ _id: id, isDelete: false }).select('-password -otp -otpExpiresAt -otpAttempts');
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
      const { password: _p, otp: _o, otpExpiresAt: _e, otpAttempts: _a, ...safe } = (doc as any).toObject();
      return { success: true, data: { ...safe, stores } };
    }

    const { password: _p, otp: _o, otpExpiresAt: _e, otpAttempts: _a, ...safe } = (doc as any).toObject();
    return { success: true, data: safe };
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
