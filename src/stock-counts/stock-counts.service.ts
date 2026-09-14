/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';

@Injectable()
export class StockCountsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  /** Snapshots every active physical variant's current on-hand `stock`
   *  (location-scoped via `VariantLocationStock` if `locationId` is given,
   *  store-aggregate otherwise) — this is the "book" quantity the session
   *  verifies against. Only one OPEN count per store at a time — starting a
   *  second one while another is still open would make it ambiguous which
   *  session's `finish()` should win. */
  async start(storeId: string, sellerId: string, locationId?: string) {
    const { storeModel, productModel, productVariantModel, variantLocationStockModel, storeLocationModel, stockCountModel } = this.repos;
    await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);

    const existingOpen = await stockCountModel.findOne({ storeId, status: 'open' }).lean();
    if (existingOpen) {
      throw new BadRequestException('A stock count is already open for this store — finish or cancel it before starting another.');
    }

    if (locationId) {
      const location = await storeLocationModel.findOne({ _id: locationId, storeId, isDelete: false });
      if (!location) throw new NotFoundException('Location not found');
    }

    const products = await productModel
      .find({ storeId, sellerId, isDelete: false, status: 'active', type: { $ne: 'digital' } })
      .select('name images')
      .lean();
    const productIds = products.map((p: any) => p._id.toString());
    const productById = new Map<string, any>(products.map((p: any) => [p._id.toString(), p]));

    const variants = productIds.length
      ? await productVariantModel.find({ productId: { $in: productIds }, isDelete: false, unlimitedStock: { $ne: true } }).lean()
      : [];

    let qtyByVariant = new Map<string, number>();
    if (locationId) {
      const rows = await variantLocationStockModel.find({ storeId, locationId }).lean();
      qtyByVariant = new Map(rows.map((r: any) => [r.variantId, r.stock || 0]));
    }

    const items = variants.map((v: any) => {
      const product = productById.get(v.productId);
      return {
        variantId: v._id.toString(), productId: v.productId,
        sku: v.sku ?? null, productName: product?.name ?? '(deleted product)', image: product?.images?.[0] ?? null,
        systemQty: locationId ? (qtyByVariant.get(v._id.toString()) ?? 0) : (v.stock || 0),
        countedQty: null,
      };
    });

    const count = await stockCountModel.create({
      storeId, sellerId, locationId: locationId ?? null, items, status: 'open', startedBy: sellerId, startedAt: new Date(),
    });

    await this.activityLogService.log({
      storeId, category: 'inventory', action: 'stock_count_started',
      description: `Stock count started — ${items.length} SKU(s)`,
      actorId: sellerId, actorRole: 'seller', targetId: count._id.toString(), targetType: 'stock_count',
    });

    return count.toObject();
  }

  async list(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    return this.repos.stockCountModel.find({ storeId }).sort({ createdAt: -1 }).limit(50).lean();
  }

  private async getOwned(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    const count = await this.repos.stockCountModel.findOne({ _id: id, storeId });
    if (!count) throw new NotFoundException('Stock count not found');
    return count;
  }

  async getById(storeId: string, sellerId: string, id: string) {
    const count = await this.getOwned(storeId, sellerId, id);
    return count.toObject();
  }

  /** Repeatable per-line — the whole point of a real counting session is
   *  entering one SKU at a time (scan/search → type count → move on),
   *  never one big bulk submit. */
  async submitCount(storeId: string, sellerId: string, id: string, itemId: string, countedQty: number) {
    if (!Number.isFinite(countedQty) || countedQty < 0) {
      throw new BadRequestException('Counted quantity must be a non-negative number');
    }
    const count = await this.getOwned(storeId, sellerId, id);
    if (count.status !== 'open') throw new BadRequestException('This stock count is no longer open.');
    const item = (count.items as any).id(itemId);
    if (!item) throw new NotFoundException('Line item not found on this stock count');
    item.countedQty = countedQty;
    await count.save();
    return count.toObject();
  }

  async cancel(storeId: string, sellerId: string, id: string) {
    const count = await this.getOwned(storeId, sellerId, id);
    if (count.status !== 'open') throw new BadRequestException('Only an open stock count can be cancelled.');
    count.status = 'cancelled';
    count.cancelledAt = new Date();
    await count.save();
    return count.toObject();
  }

  /** Applies every counted, discrepant line to real stock in one go —
   *  never partial/silent. Each write is a real, atomic, floor-guarded
   *  `$set` plus a `StockAdjustment(reason:'correction')` audit row,
   *  reusing the exact same reason this codebase's adjustment schema
   *  already uses for a manual count fix. Uncounted lines (`countedQty ===
   *  null`) are left completely untouched — a partial count never zeroes
   *  out whatever the seller didn't get to. */
  async finish(storeId: string, sellerId: string, id: string) {
    const count = await this.getOwned(storeId, sellerId, id);
    if (count.status !== 'open') throw new BadRequestException('This stock count is no longer open.');

    const { productVariantModel, stockAdjustmentModel, sellerModel, variantLocationStockModel } = this.repos;
    const seller = await sellerModel.findOne({ _id: sellerId }).select('name');
    let applied = 0;

    for (const item of count.items as any[]) {
      if (item.countedQty == null || item.countedQty === item.systemQty) continue;
      const variant = await productVariantModel.findOne({ _id: item.variantId, isDelete: false });
      if (!variant || variant.unlimitedStock) continue;

      const previousStock = variant.stock;
      const delta = item.countedQty - item.systemQty;

      if (count.locationId) {
        await variantLocationStockModel.updateOne(
          { variantId: item.variantId, locationId: count.locationId },
          { $set: { storeId, productId: item.productId, stock: item.countedQty } },
          { upsert: true },
        );
        const rows = await variantLocationStockModel.find({ variantId: item.variantId }).lean();
        const newTotal = rows.reduce((s: number, r: any) => s + (r.stock || 0), 0);
        await productVariantModel.updateOne({ _id: item.variantId }, { $set: { stock: newTotal } });
      } else {
        await productVariantModel.updateOne({ _id: item.variantId }, { $set: { stock: Math.max(0, item.countedQty) } });
      }

      await stockAdjustmentModel.create({
        storeId, productId: item.productId, variantId: item.variantId, locationId: count.locationId,
        productName: item.productName, sku: item.sku,
        previousStock, newStock: item.countedQty, delta,
        reason: 'correction', note: `Stock count #${count._id.toString().slice(-6).toUpperCase()}`,
        adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
      });
      applied++;
    }

    count.status = 'completed';
    count.completedAt = new Date();
    await count.save();

    await this.activityLogService.log({
      storeId, category: 'inventory', action: 'stock_count_completed',
      description: `Stock count completed — ${applied} discrepant SKU(s) adjusted`,
      actorId: sellerId, actorRole: 'seller', targetId: id, targetType: 'stock_count',
    });

    return { count: count.toObject(), applied };
  }
}
