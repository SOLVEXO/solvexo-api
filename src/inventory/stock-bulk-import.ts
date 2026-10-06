/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';

/** Stock reconciliation import (absolute counts, matched by variant SKU). */

export const STOCK_IMPORT_MAX_ROWS = 1000;

export const STOCK_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'SKU', required: true, description: "Variant SKU of one of your store's products (case-insensitive).", example: 'TSHIRT-001' },
  { key: 'Quantity', required: true, description: 'The counted on-hand quantity (absolute, whole number, 0 or more) — NOT a +/- change.', example: '40' },
];

export interface StockImportDeps {
  repos: { storeModel: any; productModel: any; productVariantModel: any };
  /** Applies a signed stock delta through the real adjustment path (audit row, committed-stock floor, lots). */
  adjust: (variantId: string, delta: number, reason: 'correction', note: string) => Promise<any>;
}

export async function importStockCsv(deps: StockImportDeps, sellerId: string, storeId: string, text: string) {
  const { storeModel, productModel, productVariantModel } = deps.repos;
  await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);

  const products: any[] = await productModel.find({ storeId, sellerId, isDelete: false }).select('_id').lean();
  const productIds = products.map((p) => String(p._id));
  const variants: any[] = productIds.length
    ? await productVariantModel.find({ productId: { $in: productIds }, isDelete: false }).lean()
    : [];
  const variantsBySku = new Map<string, any[]>();
  for (const v of variants) {
    if (!v.sku) continue;
    const k = String(v.sku).toLowerCase();
    variantsBySku.set(k, [...(variantsBySku.get(k) ?? []), v]);
  }

  const handler = async (r: Record<string, string>) => {
    const sku = r['SKU'].trim();
    if (!sku) throw new BulkRowError('SKU is required');
    const qty = parseNumberCell(r['Quantity'], 'Quantity', { required: true, min: 0, integer: true }) as number;

    const matches = variantsBySku.get(sku.toLowerCase()) ?? [];
    if (matches.length === 0) throw new BulkRowError('No SKU matches this in your store');
    if (matches.length > 1) throw new BulkRowError(`SKU ${sku} matches more than one variant — make SKUs unique first`);
    const variant = matches[0];
    if (variant.unlimitedStock) throw new BulkRowError('This SKU has unlimited stock — skipped');
    if (qty === variant.stock) return { outcome: 'skipped' as const, note: 'No change' };

    await deps.adjust(String(variant._id), qty - variant.stock, 'correction', 'Bulk CSV reconciliation');
    return { outcome: 'updated' as const };
  };

  return runBulkImport({
    text,
    columns: STOCK_IMPORT_COLUMNS,
    maxRows: STOCK_IMPORT_MAX_ROWS,
    label: 'SKU',
    fileDedupeKey: (r) => (r['SKU'] ? `SKU ${r['SKU'].toLowerCase()}` : null),
    handler,
  });
}
