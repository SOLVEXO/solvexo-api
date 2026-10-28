/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';

const BATCH = 2000;
const MAX_BATCHES = 50;
const MAX_DUP_GROUPS = 500;

/**
 * Backward-compatible catalog migration, run once at boot (idempotent, bounded, never blocks startup):
 *  1. fills `ProductVariant.storeId` on older variants (copied from their product);
 *  2. renames duplicate live SKUs inside a store (first keeps its SKU, the rest get `-D<n>`), because the new per-store
 *     unique SKU index cannot be built while duplicates exist — duplicating a product used to copy every SKU;
 *  3. (re)builds the variant indexes so the unique `{storeId, sku}` index exists.
 * Nothing is deleted and no stock/price is touched.
 */
@Injectable()
export class CatalogIntegrityService implements OnModuleInit {
  private readonly logger = new Logger(CatalogIntegrityService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  onModuleInit() {
    if (process.env.CATALOG_MIGRATION === 'off') return;
    void this.runOnce().catch((err) => this.logger.warn(`Catalog integrity migration skipped: ${err?.message ?? err}`));
  }

  async runOnce(): Promise<{ backfilled: number; renamed: number }> {
    let result = { backfilled: 0, renamed: 0 };
    const work = async () => {
      const backfilled = await this.backfillVariantStoreIds();
      const renamed = await this.dedupeSkus();
      try {
        await this.r.productVariantModel.createIndexes();
      } catch (err: any) {
        this.logger.warn(`Variant index build failed (fix remaining duplicate SKUs): ${err?.message ?? err}`);
      }
      result = { backfilled, renamed };
      // warn, not log: production prints only error/warn, and this line says that product data was changed.
      if (backfilled || renamed) this.logger.warn(`Catalog integrity: ${backfilled} variant(s) got a storeId, ${renamed} duplicate SKU(s) renamed`);
    };
    const outcome = await this.redis.withLock('catalog-integrity-boot', 10 * 60_000, work);
    // No Redis (local/dev): the work is idempotent, so just run it.
    if (outcome === 'lock_not_acquired' && !this.redis.isConnected) await work();
    return result;
  }

  async backfillVariantStoreIds(): Promise<number> {
    let total = 0;
    const settled: string[] = []; // variants handled (or given up on) in this run, so a stuck one cannot loop forever
    for (let i = 0; i < MAX_BATCHES; i++) {
      const variants: any[] = await this.r.productVariantModel
        .find({ $and: [{ $or: [{ storeId: null }, { storeId: { $exists: false } }] }, { _id: { $nin: settled } }] })
        .select('productId')
        .limit(BATCH)
        .lean();
      if (variants.length === 0) break;
      const productIds = [...new Set(variants.map((v) => String(v.productId)))];
      const products: any[] = await this.r.productModel.find({ _id: { $in: productIds } }).select('storeId').lean();
      const storeOf = new Map(products.map((p) => [String(p._id), String(p.storeId)]));
      const ops = variants
        .filter((v) => storeOf.has(String(v.productId)))
        .map((v) => ({ updateOne: { filter: { _id: v._id }, update: { $set: { storeId: storeOf.get(String(v.productId)) } } } }));
      if (ops.length === 0) break; // only orphans left (product gone) — nothing to fill, stop instead of looping
      let failed: number[] = [];
      try {
        await this.r.productVariantModel.bulkWrite(ops as any, { ordered: false });
      } catch (err: any) {
        // The unique {storeId, sku} index already exists: an old variant whose SKU equals another live variant of its store
        // cannot take that storeId as is. The rest of the batch was applied (unordered); fix these one by one below.
        const raw = err?.writeErrors ?? err?.result?.getWriteErrors?.() ?? []; // the driver gives ONE error as an object, several as an array
        const writeErrors: any[] = Array.isArray(raw) ? raw : [raw];
        if (err?.code !== 11000 && !writeErrors.some((e) => (e?.code ?? e?.err?.code) === 11000)) throw err;
        failed = writeErrors.map((e) => e?.index ?? e?.err?.index).filter((n) => typeof n === 'number');
        if (failed.length === 0) throw err;
      }
      for (const idx of failed) {
        const v = variants.filter((x) => storeOf.has(String(x.productId)))[idx];
        if (v) await this.assignStoreIdWithUniqueSku(v._id, storeOf.get(String(v.productId))!);
      }
      for (const v of variants) settled.push(String(v._id));
      total += ops.length;
      if (variants.length < BATCH) break;
    }
    return total;
  }

  /** Gives a variant its storeId and, because its SKU collides inside that store, a free `-D<n>` suffix. Nothing else changes. */
  private async assignStoreIdWithUniqueSku(variantId: any, storeId: string): Promise<void> {
    const v: any = await this.r.productVariantModel.findById(variantId).select('sku isDelete').lean();
    if (!v) return;
    for (let n = 1; n <= 20; n++) {
      const candidate = `${String(v.sku ?? '').slice(0, 56)}-D${n}`;
      if (await this.r.productVariantModel.exists({ storeId, sku: candidate, isDelete: false })) continue;
      try {
        await this.r.productVariantModel.updateOne({ _id: variantId }, { $set: { storeId, sku: candidate } });
        return;
      } catch (err: any) {
        if (err?.code !== 11000) throw err; // taken in the meantime: try the next suffix
      }
    }
    this.logger.warn(`Could not give variant ${String(variantId)} a unique SKU in store ${storeId}; left unchanged`);
  }

  async dedupeSkus(): Promise<number> {
    const groups: any[] = await this.r.productVariantModel.aggregate([
      { $match: { isDelete: false, storeId: { $type: 'string' }, sku: { $gt: '' } } },
      { $group: { _id: { storeId: '$storeId', sku: '$sku' }, ids: { $push: { id: '$_id', at: '$createdAt' } }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: MAX_DUP_GROUPS },
    ]);
    let renamed = 0;
    for (const g of groups) {
      const ordered = [...g.ids].sort((a: any, b: any) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());
      for (let k = 1; k < ordered.length; k++) {
        let n = k;
        for (let attempt = 0; attempt < 20; attempt++, n++) {
          const candidate = `${String(g._id.sku).slice(0, 56)}-D${n}`;
          const taken = await this.r.productVariantModel.exists({ storeId: g._id.storeId, sku: candidate, isDelete: false });
          if (taken) continue;
          await this.r.productVariantModel.updateOne({ _id: ordered[k].id }, { $set: { sku: candidate } });
          renamed += 1;
          break;
        }
      }
    }
    return renamed;
  }
}
