/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { MarketplaceListingQueryDto } from './dto/marketplace-listing-query.dto';
import { LeadsQueryDto } from './dto/leads-query.dto';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AdminMarketplaceService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string, targetType: 'product' | 'store' = 'product') {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'products',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      targetType,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async getStats() {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [total, active, flagged, gmvRows] = await Promise.all([
      this.r.productModel.countDocuments({ isDelete: false }),
      this.r.productModel.countDocuments({ isDelete: false, status: 'active' }),
      this.r.reportModel.countDocuments({ targetType: 'listing', status: { $ne: 'resolved' } }),
      this.r.orderModel.aggregate([
        { $match: { isPaid: true, createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, gmv: { $sum: '$totalAmount' } } },
      ]),
    ]);

    return {
      success: true,
      data: {
        totalListings: total,
        active,
        flagged,
        gmvThisMonth: gmvRows[0]?.gmv ?? 0,
      },
    };
  }

  async getListings(query: MarketplaceListingQueryDto) {
    const filter: Record<string, unknown> = { isDelete: false };

    if (query.categoryId) filter.categoryId = query.categoryId;
    if (query.search) filter.name = { $regex: query.search, $options: 'i' };

    let flaggedProductIds: string[] | null = null;
    if (query.status === 'flagged') {
      const reports = await this.r.reportModel.find({ targetType: 'listing', status: { $ne: 'resolved' } }, { targetId: 1 });
      flaggedProductIds = reports.map((r) => r.targetId);
      filter._id = { $in: flaggedProductIds };
    } else if (query.status) {
      filter.status = query.status;
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [products, total] = await Promise.all([
      this.r.productModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      this.r.productModel.countDocuments(filter),
    ]);

    const productIds = products.map((p) => String(p._id));
    const sellerIds = [...new Set(products.map((p) => p.sellerId))];
    const storeIds = [...new Set(products.map((p) => p.storeId).filter(Boolean))];
    const [sellers, stores, openReports, priceRows] = await Promise.all([
      this.r.sellerModel.find({ _id: { $in: sellerIds } }, { name: 1 }),
      this.r.storeModel.find({ _id: { $in: storeIds } }, { badges: 1 }),
      this.r.reportModel.find(
        { targetType: 'listing', status: { $ne: 'resolved' }, targetId: { $in: productIds } },
        { targetId: 1 },
      ),
      this.r.productVariantModel.aggregate([
        { $match: { productId: { $in: productIds } } },
        { $group: { _id: '$productId', minPrice: { $min: '$price' } } },
      ]),
    ]);
    const sellerNameById = new Map(sellers.map((s) => [String(s._id), s.name]));
    const badgesByStoreId = new Map(stores.map((s) => [String(s._id), s.badges ?? []]));
    const flaggedIdSet = new Set(openReports.map((r) => r.targetId));
    const priceByProductId = new Map(priceRows.map((row) => [row._id, row.minPrice]));

    const items = products.map((p) => ({
      id: p._id,
      title: p.name,
      sellerId: p.sellerId,
      sellerName: sellerNameById.get(p.sellerId) ?? 'Unknown',
      storeId: p.storeId,
      storeBadges: badgesByStoreId.get(p.storeId) ?? [],
      categoryId: p.categoryId,
      price: priceByProductId.get(String(p._id)) ?? null,
      purchaseCount: p.purchaseCount,
      status: flaggedIdSet.has(String(p._id)) ? 'flagged' : p.status,
      isFeatured: p.isFeatured,
    }));

    return { success: true, data: { items, total, page, limit } };
  }

  private async findProductOrThrow(id: string) {
    const product = await this.r.productModel.findOne({ _id: id, isDelete: false });
    if (!product) throw new NotFoundException('Listing not found');
    return product;
  }

  async setFeatured(id: string, isFeatured: boolean, meta: AuditMeta) {
    const product = await this.findProductOrThrow(id);
    await this.r.productModel.findByIdAndUpdate(id, { $set: { isFeatured } });
    this.log(
      isFeatured ? 'listing_featured' : 'listing_unfeatured',
      `Listing "${product.name}" ${isFeatured ? 'featured' : 'unfeatured'}`,
      meta,
      id,
    );
    return { success: true, message: isFeatured ? 'Listing featured' : 'Listing unfeatured' };
  }

  async remove(id: string, meta: AuditMeta) {
    const product = await this.findProductOrThrow(id);
    await this.r.productModel.findByIdAndUpdate(id, { $set: { isDelete: true, status: 'inactive' } });
    this.log('listing_removed', `Listing "${product.name}" removed by admin`, meta, id);
    return { success: true, message: 'Listing removed' };
  }

  /** Grants/revokes a trust badge (e.g. 'verified_educator') on a store — reuses
   *  the existing `Store.badges: string[]` field the marketplace listing/store
   *  UI already reads; this is just the first admin action that writes it. */
  async setStoreBadge(storeId: string, badge: string, grant: boolean, meta: AuditMeta) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');

    const current: string[] = store.badges ?? [];
    const next = grant
      ? (current.includes(badge) ? current : [...current, badge])
      : current.filter((b) => b !== badge);

    await this.r.storeModel.findByIdAndUpdate(storeId, { $set: { badges: next } });
    this.log(
      grant ? 'store_badge_granted' : 'store_badge_revoked',
      `Badge "${badge}" ${grant ? 'granted to' : 'revoked from'} store "${store.name}"`,
      meta,
      storeId,
      'store',
    );
    return { success: true, message: grant ? 'Badge granted' : 'Badge revoked', data: { badges: next } };
  }

  /** New-store Leads queue — every store starts `status: 'pending'`
   *  (StoreService.createStore) and sits here until an admin approves or
   *  rejects it. Returns the full onboarding submission (store fields +
   *  the seller's contact info) so the admin can review it without a
   *  separate lookup. */
  async getLeads(query: LeadsQueryDto) {
    const filter: Record<string, unknown> = { status: 'pending', isDelete: false };
    if (query.search) filter.name = { $regex: query.search, $options: 'i' };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [stores, total] = await Promise.all([
      this.r.storeModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.storeModel.countDocuments(filter),
    ]);

    const sellerIds = [...new Set(stores.map((s: any) => s.sellerId))];
    const categoryIds = [...new Set(stores.map((s: any) => s.categoryId).filter(Boolean))];
    const [sellers, categories] = await Promise.all([
      this.r.sellerModel.find({ _id: { $in: sellerIds } }, { name: 1, email: 1, phone: 1, address: 1 }).lean(),
      this.r.categoryModel.find({ _id: { $in: categoryIds } }, { name: 1 }).lean(),
    ]);
    const sellerById = new Map(sellers.map((s: any) => [String(s._id), s]));
    const categoryNameById = new Map(categories.map((c: any) => [String(c._id), c.name]));

    const items = stores.map((s: any) => {
      const seller = sellerById.get(s.sellerId);
      return {
        id: s._id,
        storeName: s.name,
        logo: s.logo,
        description: s.description,
        categoryId: s.categoryId,
        categoryName: s.categoryId ? categoryNameById.get(s.categoryId) ?? null : null,
        sellerType: s.sellerType,
        productTypes: s.productTypes,
        baseCurrency: s.baseCurrency,
        submittedAt: s.createdAt,
        seller: {
          id: s.sellerId,
          name: seller?.name ?? 'Unknown',
          email: seller?.email ?? null,
          phone: seller?.phone ?? null,
          address: seller?.address ?? null,
        },
      };
    });

    return { success: true, data: { items, total, page, limit } };
  }

  private async findPendingStoreOrThrow(id: string) {
    const store = await this.r.storeModel.findOne({ _id: id, isDelete: false });
    if (!store) throw new NotFoundException('Lead not found');
    if (store.status !== 'pending') throw new BadRequestException('This lead has already been reviewed');
    return store;
  }

  async approveLead(id: string, meta: AuditMeta) {
    const store = await this.findPendingStoreOrThrow(id);
    await this.r.storeModel.findByIdAndUpdate(id, { $set: { status: 'active', reviewedAt: new Date() } });

    this.log('lead_approved', `Store "${store.name}" approved and is now live`, meta, id, 'store');
    this.notificationsService.notify({
      recipientId: store.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.STORE_APPROVED,
      title: 'Your store is live!',
      body: `"${store.name}" has been approved and is now visible on the marketplace.`,
      data: { storeId: id },
    }).catch(() => {});

    return { success: true, message: 'Lead approved — store is now live' };
  }

  async rejectLead(id: string, reason: string | undefined, meta: AuditMeta) {
    const store = await this.findPendingStoreOrThrow(id);
    await this.r.storeModel.findByIdAndUpdate(id, {
      $set: { status: 'rejected', rejectionReason: reason ?? null, reviewedAt: new Date() },
    });

    this.log('lead_rejected', `Store "${store.name}" rejected${reason ? `: ${reason}` : ''}`, meta, id, 'store');
    this.notificationsService.notify({
      recipientId: store.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.STORE_REJECTED,
      title: 'Your store application was rejected',
      body: reason ? `"${store.name}" was rejected: ${reason}` : `"${store.name}" was rejected by our review team.`,
      data: { storeId: id },
    }).catch(() => {});

    return { success: true, message: 'Lead rejected' };
  }
}
