/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { InventoryService } from '../inventory/inventory.service';
import { normalizeBarcode } from '../products/product-input.util';
import { fromMinor, isoExponent, toMinor } from '@/common/money-minor.util';
import { PosService } from './pos.service';
import { AdjustCatalogStockDto, UpdateCatalogVariantDto } from './dto/catalog.dto';

/**
 * G2.6 — POS catalog edits (decision D3). Behind a MANAGER's PIN session (verified server-side), audit-logged with before/after values,
 * written to the SAME variant / product documents the storefront reads (so a change is visible there at once). Stock never gets overwritten:
 * it moves through the inventory stock-movement path. Prices must be exact in the currency's minor units.
 */
@Injectable()
export class PosCatalogService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly inventory: InventoryService) {}
  private get r() { return this.db.repositories; }

  private async audit(storeId: string, employeeId: string, action: string, targetId: string, metadata: object) {
    await this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'variant', metadata }]);
  }

  private async load(storeId: string, variantId: string) {
    const variant: any = await this.r.productVariantModel.findOne({ _id: variantId, isDelete: false }).lean();
    const product: any = variant ? await this.r.productModel.findOne({ _id: variant.productId, storeId, isDelete: false }).lean() : null;
    if (!variant || !product) throw new NotFoundException('Variant not found in this store');
    return { variant, product };
  }

  /** A barcode may be used by one live variant per store. Variants that predate `storeId` are matched through their product. */
  private async assertBarcodeFree(storeId: string, barcode: string, variantId: string) {
    const clash: any = await this.r.productVariantModel.findOne({ barcode, isDelete: false, _id: { $ne: variantId }, storeId }).select('_id sku').lean();
    if (clash) throw new ConflictException({ statusCode: 409, code: 'BARCODE_IN_USE', message: `Barcode ${barcode} is already used by ${clash.sku ?? 'another item'} in this store` });
    const legacy: any[] = await this.r.productVariantModel.find({ barcode, isDelete: false, _id: { $ne: variantId }, storeId: null }).select('productId sku').lean();
    for (const l of legacy) {
      if (await this.r.productModel.exists({ _id: l.productId, storeId, isDelete: false })) throw new ConflictException({ statusCode: 409, code: 'BARCODE_IN_USE', message: `Barcode ${barcode} is already used by ${l.sku ?? 'another item'} in this store` });
    }
  }

  async updateVariant(sellerId: string, storeId: string, variantId: string, dto: UpdateCatalogVariantDto, employeeToken: string | undefined) {
    await this.pos.verifyStoreOwnership(storeId, sellerId);
    const actor = await this.pos.requireManagerEmployee(employeeToken, storeId, 'edit the catalog');
    const { variant, product } = await this.load(storeId, variantId);
    const store: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const exp = isoExponent(store?.baseCurrency);

    const vSet: Record<string, any> = {}; const pSet: Record<string, any> = {}; const before: Record<string, any> = {}; const after: Record<string, any> = {};
    if (dto.price !== undefined) {
      const price = Number(dto.price);
      if (!Number.isFinite(price) || price <= 0 || price > 1_000_000_000) throw new BadRequestException({ statusCode: 400, code: 'PRICE_INVALID', message: 'The price must be above zero' });
      // minor-safe: the number must be EXACTLY what the currency can hold (no hidden sub-minor digits that the shared price would round differently)
      if (fromMinor(toMinor(price, exp), exp) !== price) throw new BadRequestException({ statusCode: 400, code: 'PRICE_PRECISION', message: `This currency allows ${exp} decimal places`, exponent: exp });
      if (price !== variant.price) { vSet.price = price; before.price = variant.price; after.price = price; }
    }
    if (dto.barcode !== undefined) {
      const barcode = normalizeBarcode(dto.barcode);
      if (barcode) await this.assertBarcodeFree(storeId, barcode, variantId);
      if (barcode !== (variant.barcode ?? null)) { vSet.barcode = barcode; before.barcode = variant.barcode ?? null; after.barcode = barcode; }
    }
    if (dto.hsCode !== undefined) {
      const hs = dto.hsCode === null || dto.hsCode === '' ? null : String(dto.hsCode);
      if (hs !== (variant.hsCode ?? null)) { vSet.hsCode = hs; before.hsCode = variant.hsCode ?? null; after.hsCode = hs; }
    }
    if (dto.categoryId !== undefined && dto.categoryId !== String(product.categoryId)) {
      const cat: any = await this.r.categoryModel.findOne({ _id: dto.categoryId, isDelete: false }).select('storeId').lean();
      if (!cat || (cat.storeId && String(cat.storeId) !== storeId)) throw new BadRequestException({ statusCode: 400, code: 'CATEGORY_NOT_FOUND', message: 'That category is not available to this store' });
      pSet.categoryId = dto.categoryId; before.categoryId = String(product.categoryId); after.categoryId = dto.categoryId;
    }
    if (!Object.keys(vSet).length && !Object.keys(pSet).length) return { success: true, message: 'Nothing changed', data: { variantId, changed: [] } };

    try {
      // guarded on the price we read: two managers editing at once cannot silently overwrite each other
      if (Object.keys(vSet).length) {
        const filter: any = { _id: variantId, isDelete: false };
        if (vSet.price !== undefined) filter.price = variant.price;
        const res = await this.r.productVariantModel.findOneAndUpdate(filter, { $set: vSet }, { new: true }); // (a price change is also recorded in the variant price history by its model hook)
        if (!res) throw new ConflictException({ statusCode: 409, code: 'VARIANT_CHANGED', message: 'This item was just changed by someone else — reload it and try again' });
      }
      if (Object.keys(pSet).length) await this.r.productModel.updateOne({ _id: product._id }, { $set: pSet });
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException({ statusCode: 409, code: 'BARCODE_IN_USE', message: 'That barcode is already used in this store' });
      throw e;
    }
    await this.audit(storeId, actor.employeeId, 'catalog_variant_updated', variantId, { sku: variant.sku, product: product.name, before, after, note: dto.note ?? null });
    return { success: true, message: 'Item updated', data: { variantId, changed: Object.keys(after), before, after } };
  }

  /** Stock edit: a signed movement through the inventory service (the stock-adjustment history is written there); the audit row keeps who and why. */
  async adjustStock(sellerId: string, storeId: string, variantId: string, dto: AdjustCatalogStockDto, employeeToken: string | undefined) {
    await this.pos.verifyStoreOwnership(storeId, sellerId);
    const actor = await this.pos.requireManagerEmployee(employeeToken, storeId, 'change stock');
    const { variant, product } = await this.load(storeId, variantId);
    if (!dto.delta) throw new BadRequestException({ statusCode: 400, code: 'DELTA_REQUIRED', message: 'Enter how many units to add or remove' });
    if (variant.unlimitedStock) throw new BadRequestException({ statusCode: 400, code: 'UNLIMITED_STOCK', message: 'This item has unlimited stock' });
    const res: any = await this.inventory.adjustStock(sellerId, storeId, variantId, dto.delta, dto.reason as any, dto.note);
    const now: any = await this.r.productVariantModel.findById(variantId).select('stock').lean();
    await this.audit(storeId, actor.employeeId, 'catalog_stock_adjusted', variantId, { sku: variant.sku, product: product.name, before: { stock: variant.stock }, after: { stock: now?.stock ?? null }, delta: dto.delta, reason: dto.reason, note: dto.note ?? null });
    return { success: true, message: 'Stock updated', data: { variantId, before: variant.stock, after: now?.stock ?? null, movement: res?.data ?? null } };
  }
}
