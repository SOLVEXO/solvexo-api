/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { AVAILABLE_STOCK_EXPR } from '@/common/stock-availability.util';

export type StoreBadgeCounts = Partial<Record<'returns' | 'disputes' | 'payment-proofs' | 'messages' | 'online-store-contact' | 'reviews' | 'inventory', number>>;

const REVIEW_REPLY_WINDOW_DAYS = 14;

/**
 * Real "needs your attention" numbers for the dashboard sidebar (Shopify shows the same kind of counts), taken from
 * the data itself so they stay right even when no notification was created. A staff caller only gets the counts for
 * areas their role may open; one failing count never breaks the others.
 */
@Injectable()
export class StoreBadgesService {
  constructor(private readonly db: DatabaseService) {}

  async get(user: { role?: string; permissions?: string[] }, sellerId: string, storeId: string): Promise<{ success: true; data: StoreBadgeCounts }> {
    const r = this.db.repositories;
    const store: any = await verifyStoreOwnershipStrict(r.storeModel, storeId, sellerId);
    const lowStockThreshold = typeof store?.lowStockThreshold === 'number' ? store.lowStockThreshold : 10;
    const can = (...perms: string[]) => user.role !== 'staff' || perms.some(p => (user.permissions ?? []).includes(p));
    const since = new Date(Date.now() - REVIEW_REPLY_WINDOW_DAYS * 24 * 3600 * 1000);

    const jobs: [keyof StoreBadgeCounts, boolean, () => Promise<number>][] = [
      ['returns', can('orders.return', 'orders.view'), () => r.orderModel.countDocuments({
        isDelete: false,
        sellerOrders: { $elemMatch: { storeId, items: { $elemMatch: { returnStatus: 'requested' } } } },
      })],
      ['disputes', can('orders.disputes_manage'), () => r.paymentTransactionModel.countDocuments({
        disputes: { $elemMatch: { storeIds: storeId, status: { $in: ['needs_response', 'warning_needs_response'] } } },
      })],
      ['payment-proofs', can('orders.record_payment'), () => r.manualPaymentProofModel.countDocuments({ storeIds: storeId, status: 'pending' })],
      ['messages', can('messaging.view', 'messaging.manage'), () => r.conversationModel.countDocuments({ storeId, deletedBySeller: false, sellerUnread: { $gt: 0 } })],
      ['online-store-contact', can('onlinestore.content.manage'), () => r.storeContactMessageModel.countDocuments({ storeId, status: 'new' })],
      // Products with a variant that is out of stock or at/below its reorder point (the same rule as the Inventory screen).
      ['inventory', can('inventory.view', 'inventory.adjust'), async () => {
        const rows = await r.productVariantModel.aggregate([
          { $match: { storeId, isDelete: false, unlimitedStock: { $ne: true } } },
          { $match: { $expr: { $lte: [{ $max: [0, AVAILABLE_STOCK_EXPR] }, { $ifNull: ['$reorderPoint', lowStockThreshold] }] } } },
          { $addFields: { productObjId: { $toObjectId: '$productId' } } },
          { $lookup: { from: 'products', localField: 'productObjId', foreignField: '_id', as: 'product' } },
          { $unwind: '$product' },
          { $match: { 'product.isDelete': false, 'product.type': { $ne: 'digital' }, 'product.status': { $ne: 'archived' } } },
          { $group: { _id: '$productId' } },
          { $count: 'n' },
        ]);
        return rows[0]?.n ?? 0;
      }],
      ['reviews', can('customers.view', 'reviews.manage'), () => r.ratingModel.countDocuments({
        storeId,
        $or: [{ status: 'pending' }, { status: 'published', sellerReply: null, createdAt: { $gte: since } }],
      })],
    ];

    const data: StoreBadgeCounts = {};
    await Promise.all(jobs.map(async ([key, allowed, run]) => {
      if (!allowed) return;
      try {
        const n = await run();
        if (n > 0) data[key] = n;
      } catch {
        /* a failing count is just left out */
      }
    }));
    return { success: true, data };
  }
}
