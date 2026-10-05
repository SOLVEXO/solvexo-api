/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ProductVariantsService } from '../product-variants/product-variants.service';
import { buildStoreProductFilter } from '../products/product-list-filter.util';
import { BulkEditDto, BulkTagsDto, BulkTargetDto } from './dto/bulk-products.dto';

const MAX_SELECT_ALL = 5000;

export interface BulkRowResult { productId: string; ok: boolean; error?: string }

/**
 * Shopify's product-list bulk actions and the "Edit products" bulk editor.
 * Every action is scoped to the caller's own store AND seller (a staff caller is additionally pinned to their store by
 * PermissionsGuard), only ever touches non-deleted products, and is written to the activity log.
 */
@Injectable()
export class ProductsBulkService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly variants: ProductVariantsService,
  ) {}

  private get r() { return this.db.repositories; }

  private async assertOwnedStore(sellerId: string, storeId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('_id name');
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  /** Explicit ids, or every product matching the current filter ("Select all N products"). Always store+seller scoped. */
  private async resolveTargets(sellerId: string, storeId: string, target: BulkTargetDto): Promise<string[]> {
    if (target.selectAll) {
      const filter = await buildStoreProductFilter(this.r, storeId, sellerId, target.filter ?? {});
      const rows: any[] = await this.r.productModel.find(filter).select('_id').limit(MAX_SELECT_ALL + 1).lean();
      if (rows.length > MAX_SELECT_ALL) {
        throw new BadRequestException(`Too many products selected (max ${MAX_SELECT_ALL} at once) — narrow the filter first.`);
      }
      return rows.map((p) => String(p._id));
    }
    const ids = [...new Set((target.productIds ?? []).map(String))];
    if (ids.length === 0) throw new BadRequestException('Select at least one product.');
    const owned: any[] = await this.r.productModel
      .find({ _id: { $in: ids }, storeId, sellerId, isDelete: false })
      .select('_id').lean();
    return owned.map((p) => String(p._id));
  }

  private async log(storeId: string, sellerId: string, actorRole: 'seller' | 'staff', action: string, description: string, count: number) {
    await this.activityLog.log({
      storeId, category: 'products', action, description,
      actorId: sellerId, actorRole, targetType: 'product', metadata: { count },
    } as any);
  }

  async setStatus(sellerId: string, storeId: string, actorRole: 'seller' | 'staff', target: BulkTargetDto, status: 'active' | 'draft' | 'inactive') {
    await this.assertOwnedStore(sellerId, storeId);
    const ids = await this.resolveTargets(sellerId, storeId, target);
    if (ids.length === 0) return { success: true, message: 'No matching products', data: { matched: 0, modified: 0 } };
    const res: any = await this.r.productModel.updateMany(
      { _id: { $in: ids }, storeId, sellerId, isDelete: false },
      { $set: { status, scheduledAt: null } },
    );
    const label = status === 'inactive' ? 'archived' : `set to ${status}`;
    await this.log(storeId, sellerId, actorRole, 'products_bulk_status', `${ids.length} product(s) ${label}`, ids.length);
    return { success: true, message: `${ids.length} product(s) ${label}`, data: { matched: ids.length, modified: res.modifiedCount ?? ids.length } };
  }

  async updateTags(sellerId: string, storeId: string, actorRole: 'seller' | 'staff', dto: BulkTagsDto) {
    await this.assertOwnedStore(sellerId, storeId);
    const clean = (a?: string[]) => [...new Set((a ?? []).map((t) => t.trim()).filter(Boolean))];
    const add = clean(dto.add);
    const remove = clean(dto.remove);
    if (add.length === 0 && remove.length === 0) throw new BadRequestException('Provide tags to add or remove.');
    if (add.some((t) => remove.includes(t))) throw new BadRequestException('A tag cannot be both added and removed.');
    const ids = await this.resolveTargets(sellerId, storeId, dto);
    if (ids.length === 0) return { success: true, message: 'No matching products', data: { matched: 0, modified: 0 } };
    const scope = { _id: { $in: ids }, storeId, sellerId, isDelete: false };
    // Mongo cannot $addToSet and $pullAll the same path in one update → two sequential updates.
    if (add.length) await this.r.productModel.updateMany(scope, { $addToSet: { tags: { $each: add } } });
    if (remove.length) await this.r.productModel.updateMany(scope, { $pullAll: { tags: remove } });
    await this.log(storeId, sellerId, actorRole, 'products_bulk_tags',
      `Tags updated on ${ids.length} product(s)${add.length ? ` (added: ${add.join(', ')})` : ''}${remove.length ? ` (removed: ${remove.join(', ')})` : ''}`, ids.length);
    return { success: true, message: `Tags updated on ${ids.length} product(s)`, data: { matched: ids.length, modified: ids.length } };
  }

  /** Same effect as the single-product delete (soft delete + its variants). */
  async deleteProducts(sellerId: string, storeId: string, actorRole: 'seller' | 'staff', target: BulkTargetDto) {
    await this.assertOwnedStore(sellerId, storeId);
    const ids = await this.resolveTargets(sellerId, storeId, target);
    if (ids.length === 0) return { success: true, message: 'No matching products', data: { matched: 0, modified: 0 } };
    await this.r.productModel.updateMany(
      { _id: { $in: ids }, storeId, sellerId, isDelete: false },
      { $set: { isDelete: true, status: 'inactive' } },
    );
    await this.r.productVariantModel.updateMany(
      { productId: { $in: ids }, isDelete: false },
      { $set: { isDelete: true, isDefault: false } },
    );
    await this.log(storeId, sellerId, actorRole, 'products_bulk_deleted', `${ids.length} product(s) deleted`, ids.length);
    return { success: true, message: `${ids.length} product(s) deleted`, data: { matched: ids.length, modified: ids.length } };
  }

  /**
   * Shopify's spreadsheet "Edit products": per product its title, status, tags, and per variant price, compare-at
   * price, SKU and inventory. Each product is applied independently — one bad row never blocks the others; the result
   * lists every row. Variant edits go through ProductVariantsService.updateVariant so validation and the inventory
   * audit trail are identical to editing a variant on its own page.
   */
  async editProducts(
    sellerId: string, storeId: string, actorRole: 'seller' | 'staff', dto: BulkEditDto, canEditPrice: boolean,
  ) {
    await this.assertOwnedStore(sellerId, storeId);
    const touchesPrice = dto.updates.some((u) => (u.variants ?? []).some((v) => v.price !== undefined || v.compareAtPrice !== undefined));
    if (touchesPrice && !canEditPrice) {
      throw new ForbiddenException("Your staff account doesn't have permission to edit product prices.");
    }

    const ids = [...new Set(dto.updates.map((u) => u.productId))];
    const owned: any[] = await this.r.productModel
      .find({ _id: { $in: ids }, storeId, sellerId, isDelete: false })
      .select('_id type').lean();
    const ownedById = new Map(owned.map((p) => [String(p._id), p]));

    const results: BulkRowResult[] = [];
    for (const u of dto.updates) {
      const product = ownedById.get(u.productId);
      if (!product) { results.push({ productId: u.productId, ok: false, error: 'Product not found in this store' }); continue; }
      try {
        const $set: Record<string, any> = {};
        if (u.name !== undefined) {
          const name = u.name.trim();
          if (!name) throw new BadRequestException('Title cannot be empty');
          $set.name = name;
        }
        if (u.status !== undefined) { $set.status = u.status; $set.scheduledAt = null; }
        if (u.tags !== undefined) $set.tags = [...new Set(u.tags.map((t) => t.trim()).filter(Boolean))];
        if (Object.keys($set).length) {
          await this.r.productModel.updateOne({ _id: u.productId, storeId, sellerId, isDelete: false }, { $set });
        }

        for (const v of u.variants ?? []) {
          const patch: Record<string, any> = {};
          if (v.price !== undefined) patch.price = v.price;
          if (v.compareAtPrice !== undefined && v.compareAtPrice !== null) patch.compareAtPrice = v.compareAtPrice;
          if (v.sku !== undefined) patch.sku = v.sku;
          if (v.stock !== undefined) patch.stock = v.stock;
          if (Object.keys(patch).length) {
            if (product.type === 'physical') {
              await this.variants.updateVariant(sellerId, u.productId, v.variantId, patch as any);
            } else {
              // Digital products: price / compare-at / SKU only (no inventory). Scoped to this product's own variant.
              const { stock: _ignored, ...digitalPatch } = patch;
              if (Object.keys(digitalPatch).length) {
                const res: any = await this.r.productVariantModel.updateOne(
                  { _id: v.variantId, productId: u.productId, isDelete: false },
                  { $set: digitalPatch },
                );
                if ((res.matchedCount ?? res.n ?? 1) === 0) throw new BadRequestException('Variant not found');
              }
            }
          }
          if (v.compareAtPrice === null) {
            // updateVariant ignores null (DTO: number); clearing the compare-at price is a direct, scoped write.
            await this.r.productVariantModel.updateOne({ _id: v.variantId, productId: u.productId, isDelete: false }, { $set: { compareAtPrice: null } });
          }
        }
        results.push({ productId: u.productId, ok: true });
      } catch (err: any) {
        results.push({ productId: u.productId, ok: false, error: err?.message ?? 'Update failed' });
      }
    }

    const okCount = results.filter((x) => x.ok).length;
    await this.log(storeId, sellerId, actorRole, 'products_bulk_edit', `Bulk editor: ${okCount} of ${results.length} product(s) updated`, okCount);
    return {
      success: true,
      message: `${okCount} of ${results.length} product(s) updated`,
      data: { updated: okCount, failed: results.length - okCount, results },
    };
  }
}
