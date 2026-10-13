/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';

@Injectable()
export class StockCountsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    @InjectConnection() private readonly connection: Connection,
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

    let count: any;
    try {
      count = await stockCountModel.create({
        storeId, sellerId, locationId: locationId ?? null, items, status: 'open', startedBy: sellerId, startedAt: new Date(),
      });
    } catch (err: any) {
      // the partial unique index {storeId, status:'open'} caught a concurrent start
      if (err?.code === 11000) throw new BadRequestException('A stock count is already open for this store — finish or cancel it before starting another.');
      throw err;
    }

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
    if (!Number.isInteger(countedQty) || countedQty < 0) {
      throw new BadRequestException('Counted quantity must be a whole number that is 0 or more');
    }
    await this.getOwned(storeId, sellerId, id);
    // Single atomic positional write — two people counting different lines at once can no longer overwrite each other
    // (the old load-modify-save replaced the whole document), and a count that closed meanwhile is refused.
    const updated = await this.repos.stockCountModel.findOneAndUpdate(
      { _id: id, storeId, status: 'open', 'items._id': itemId },
      { $set: { 'items.$.countedQty': countedQty } },
      { new: true },
    );
    if (!updated) {
      const still: any = await this.repos.stockCountModel.findOne({ _id: id, storeId }).select('status').lean();
      if (still && still.status !== 'open') throw new BadRequestException('This stock count is no longer open.');
      throw new NotFoundException('Line item not found on this stock count');
    }
    return updated.toObject();
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
    await this.getOwned(storeId, sellerId, id);
    const { productVariantModel, stockAdjustmentModel, sellerModel, variantLocationStockModel, stockCountModel } = this.repos;
    const seller = await sellerModel.findOne({ _id: sellerId }).select('name');
    const skipped: string[] = [];

    // Everything below commits as ONE transaction, and the count is "claimed" (open -> completed) first: a double click /
    // second tab / retry after a timeout can never apply the same count twice, and a failure half-way applies nothing.
    // The correction is the DIFFERENCE found by the count (counted - snapshot) applied with $inc, not an overwrite with the
    // counted number: sales, receipts and returns that happened while people were counting are kept.
    const result = await this.connection.transaction(async (session) => {
      skipped.length = 0;
      const count: any = await stockCountModel
        .findOneAndUpdate({ _id: id, storeId, status: 'open' }, { $set: { status: 'completed', completedAt: new Date() } }, { new: true, session });
      if (!count) throw new BadRequestException('This stock count is no longer open.');

      let applied = 0;
      for (const item of count.items as any[]) {
        if (item.countedQty == null || item.countedQty === item.systemQty) continue;
        const delta = item.countedQty - item.systemQty;
        const variant: any = await productVariantModel.findOne({ _id: item.variantId, isDelete: false }).session(session);
        if (!variant || variant.unlimitedStock) continue;
        const label = `${item.productName}${item.sku ? ' (' + item.sku + ')' : ''}`;

        if (count.locationId) {
          const rowFilter: any = { variantId: item.variantId, locationId: count.locationId };
          if (delta < 0) rowFilter.stock = { $gte: -delta };
          const row = await variantLocationStockModel.findOneAndUpdate(
            rowFilter,
            { $inc: { stock: delta }, ...(delta > 0 ? { $setOnInsert: { storeId, productId: item.productId } } : {}) },
            { upsert: delta > 0, new: true, session },
          );
          if (!row) { skipped.push(`${label}: stock at this location is now lower than the count removes — recount it`); continue; }
        } else {
          const rows = await variantLocationStockModel.find({ variantId: item.variantId }).session(session).lean();
          if (rows.length > 1) { skipped.push(`${label}: has stock in several locations — count it per location`); continue; }
          if (rows.length === 1) {
            const r = await variantLocationStockModel.updateOne(
              { _id: (rows[0] as any)._id, ...(delta < 0 ? { stock: { $gte: -delta } } : {}) },
              { $inc: { stock: delta } },
              { session },
            );
            if (r.modifiedCount === 0) { skipped.push(`${label}: stock changed while counting — recount it`); continue; }
          }
        }
        const after = await productVariantModel.findOneAndUpdate(
          { _id: item.variantId, isDelete: false, $expr: { $gte: [{ $add: ['$stock', delta] }, { $ifNull: ['$committedStock', 0] }] } },
          { $inc: { stock: delta } },
          { new: true, session },
        );
        if (!after) {
          // reserved units would go below zero: fail the whole count so nothing is half-applied
          throw new ConflictException(`${label}: the counted quantity is below the units reserved by pending orders — resolve those orders first`);
        }
        const newStock = (after as any).stock as number;
        await (stockAdjustmentModel as any).create([{
          storeId, productId: item.productId, variantId: item.variantId, locationId: count.locationId,
          productName: item.productName, sku: item.sku,
          previousStock: newStock - delta, newStock, delta,
          reason: 'correction', note: `Stock count #${count._id.toString().slice(-6).toUpperCase()}`,
          adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
        }], { session });
        applied++;
      }
      return { count, applied };
    });

    await this.activityLogService.log({
      storeId, category: 'inventory', action: 'stock_count_completed',
      description: `Stock count completed — ${result.applied} discrepant SKU(s) adjusted${skipped.length ? `, ${skipped.length} skipped` : ''}`,
      actorId: sellerId, actorRole: 'seller', targetId: id, targetType: 'stock_count',
    });

    return { count: result.count.toObject(), applied: result.applied, skipped };
  }
}
