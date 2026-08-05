/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { UploadService } from '../upload/upload.service';
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
    private readonly uploadService: UploadService,
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
   *  rejects it. List view is deliberately light (no documents/signed URLs
   *  — those are only ever generated on-demand in `getLeadDetail`, one lead
   *  at a time, so this list load never fans out a batch of Cloudinary
   *  signed-URL calls it doesn't need). */
  async getLeads(query: LeadsQueryDto) {
    const filter: Record<string, unknown> = { status: { $in: ['pending', 'under_review'] }, isDelete: false };
    if (query.search) filter.name = { $regex: query.search, $options: 'i' };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [stores, total] = await Promise.all([
      this.r.storeModel.find(filter).select('+verification').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
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
        status: s.status,
        verificationSubmitted: s.verification?.submitted ?? false,
        businessType: s.verification?.businessType ?? null,
        documentCount: (s.verification?.documents ?? []).length,
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

  /** Full review view for one lead — business info, every uploaded document
   *  (with a fresh signed URL each, never a permanent one), and the
   *  submission/review history trail. */
  async getLeadDetail(id: string) {
    const store = await this.r.storeModel.findOne({ _id: id, isDelete: false }).select('+verification');
    if (!store) throw new NotFoundException('Lead not found');

    const seller = await this.r.sellerModel.findById(store.sellerId, { name: 1, email: 1, phone: 1, address: 1 }).lean();
    const category = store.categoryId ? await this.r.categoryModel.findById(store.categoryId, { name: 1 }).lean() : null;
    const v: any = store.verification ?? {};

    return {
      success: true,
      data: {
        id: store._id,
        storeName: store.name,
        logo: store.logo,
        description: store.description,
        categoryName: (category as any)?.name ?? null,
        sellerType: store.sellerType,
        productTypes: store.productTypes,
        status: store.status,
        rejectionReason: store.rejectionReason,
        submittedAt: (store as any).createdAt,
        seller: {
          id: store.sellerId,
          name: seller?.name ?? 'Unknown',
          email: seller?.email ?? null,
          phone: seller?.phone ?? null,
          address: seller?.address ?? null,
        },
        businessType: v.businessType ?? null,
        legalBusinessName: v.legalBusinessName ?? null,
        registrationNumber: v.registrationNumber ?? null,
        taxId: v.taxId ?? null,
        businessAddress: v.businessAddress ?? null,
        idDocumentType: v.idDocumentType ?? null,
        authorizedContact: v.authorizedContact ?? null,
        submitted: v.submitted ?? false,
        documents: (v.documents ?? []).map((d: any) => ({
          type: d.type,
          fileName: d.fileName,
          uploadedAt: d.uploadedAt,
          viewUrl: this.uploadService.generateSignedUrl(d.publicId, d.resourceType, 600, d.fileName),
        })),
        history: v.history ?? [],
      },
    };
  }

  private async findReviewableStoreOrThrow(id: string) {
    const store = await this.r.storeModel.findOne({ _id: id, isDelete: false }).select('+verification');
    if (!store) throw new NotFoundException('Lead not found');
    if (!['pending', 'under_review'].includes(store.status)) {
      throw new BadRequestException('This lead has already been reviewed');
    }
    if (!store.verification?.submitted) {
      throw new BadRequestException('Seller has not submitted their verification documents yet');
    }
    return store;
  }

  private pushVerificationHistory(action: string, note: string | null, meta: AuditMeta) {
    return { action, note, actorId: meta.adminId, actorRole: 'admin', at: new Date() };
  }

  /** Optional intermediate state — purely a "someone's actively looking at
   *  this" signal for the admin team; approve/reject work the same whether
   *  a lead passed through here or not. */
  async markUnderReview(id: string, meta: AuditMeta) {
    const store = await this.findReviewableStoreOrThrow(id);
    if (store.status === 'under_review') return { success: true, message: 'Already under review' };

    await this.r.storeModel.findByIdAndUpdate(id, {
      $set: { status: 'under_review' },
      $push: { 'verification.history': this.pushVerificationHistory('under_review', null, meta) },
    });
    this.log('lead_under_review', `Store "${store.name}" marked under review`, meta, id, 'store');
    return { success: true, message: 'Marked as under review' };
  }

  async approveLead(id: string, meta: AuditMeta) {
    const store = await this.findReviewableStoreOrThrow(id);
    await this.r.storeModel.findByIdAndUpdate(id, {
      $set: { status: 'active', reviewedAt: new Date() },
      $push: { 'verification.history': this.pushVerificationHistory('approved', null, meta) },
    });

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

  /** `reason` is mandatory here (enforced by `RejectLeadDto`) — a rejection
   *  without an explanation leaves the seller with no way to fix and
   *  resubmit. */
  async rejectLead(id: string, reason: string, meta: AuditMeta) {
    const store = await this.findReviewableStoreOrThrow(id);
    await this.r.storeModel.findByIdAndUpdate(id, {
      $set: { status: 'rejected', rejectionReason: reason, reviewedAt: new Date() },
      $push: { 'verification.history': this.pushVerificationHistory('rejected', reason, meta) },
    });

    this.log('lead_rejected', `Store "${store.name}" rejected: ${reason}`, meta, id, 'store');
    this.notificationsService.notify({
      recipientId: store.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.STORE_REJECTED,
      title: 'Your store application was rejected',
      body: `"${store.name}" was rejected: ${reason}. You can correct the details and resubmit.`,
      data: { storeId: id },
    }).catch(() => {});

    return { success: true, message: 'Lead rejected' };
  }
}
