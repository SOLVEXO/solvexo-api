/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { validateOptions } from '../products/variant-options.util';

/** Variant import: adds variants to EXISTING physical products (or updates the
 *  price of an existing variant). Unique key = variant SKU (case-insensitive,
 *  per store). */

export const VARIANT_IMPORT_MAX_ROWS = 500;

export const VARIANT_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Product SKU', required: true, description: 'SKU of ANY existing variant of the parent product (preferred way to find the product).', example: 'TSHIRT-001' },
  { key: 'Product Name', description: 'Only used when Product SKU is blank: exact product name, must be unique in your store.', example: '' },
  { key: 'Option 1 Name', description: 'Attribute name, e.g. Size. Must match the attributes the product already uses.', example: 'Size' },
  { key: 'Option 1 Value', description: 'Attribute value, e.g. Large.', example: 'Large' },
  { key: 'Option 2 Name', description: 'Optional second attribute name, e.g. Color.', example: 'Color' },
  { key: 'Option 2 Value', description: 'Optional second attribute value.', example: 'Blue' },
  { key: 'Option 3 Name', description: 'Optional third attribute name.', example: '' },
  { key: 'Option 3 Value', description: 'Optional third attribute value.', example: '' },
  { key: 'SKU', required: true, description: 'Variant SKU, unique per store. If it already exists only Price / Compare-at Price are updated (non-blank cells).', example: 'TSHIRT-001-L-BLUE' },
  { key: 'Price', required: true, description: 'Variant price in the store currency (required for new variants).', example: '24.99' },
  { key: 'Compare-at Price', description: 'Original price shown struck through.', example: '29.99' },
  { key: 'Stock', description: 'Opening stock for NEW variants (whole number).', example: '20' },
  { key: 'Weight', description: 'Shipping weight as text, e.g. "0.5 kg". New variants only.', example: '0.5 kg' },
];

export interface VariantImportDeps {
  repos: { storeModel: any; productModel: any; productVariantModel: any };
  addVariant: (sellerId: string, productId: string, dto: any) => Promise<any>;
  updateVariant: (sellerId: string, productId: string, variantId: string, dto: any) => Promise<any>;
}

export async function importVariantsCsv(deps: VariantImportDeps, sellerId: string, storeId: string, text: string) {
  const { storeModel, productModel, productVariantModel } = deps.repos;
  await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);

  const products: any[] = await productModel.find({ storeId, isDelete: false }).select('_id name type').lean();
  const productById = new Map<string, any>(products.map((p) => [String(p._id), p]));
  const productsByName = new Map<string, string[]>();
  for (const p of products) {
    const k = String(p.name).trim().toLowerCase();
    productsByName.set(k, [...(productsByName.get(k) ?? []), String(p._id)]);
  }
  const variantBySku = new Map<string, { id: string; productId: string; price: number; compareAtPrice: number | null }>();
  if (products.length) {
    const variants: any[] = await productVariantModel
      .find({ productId: { $in: [...productById.keys()] }, isDelete: false })
      .select('_id productId sku price compareAtPrice')
      .lean();
    for (const v of variants) {
      if (v.sku) {
        variantBySku.set(String(v.sku).toLowerCase(), {
          id: String(v._id), productId: String(v.productId), price: v.price, compareAtPrice: v.compareAtPrice ?? null,
        });
      }
    }
  }

  const locateProduct = (r: Record<string, string>): string => {
    const parentSku = r['Product SKU'].trim().toLowerCase();
    if (parentSku) {
      const parent = variantBySku.get(parentSku);
      if (!parent) throw new BulkRowError(`Product SKU "${r['Product SKU']}" does not match any product in your store`);
      return parent.productId;
    }
    const name = r['Product Name'].trim().toLowerCase();
    if (!name) throw new BulkRowError('Product SKU (or Product Name) is required to find the product');
    const ids = productsByName.get(name) ?? [];
    if (ids.length === 0) throw new BulkRowError(`Product "${r['Product Name']}" not found in your store`);
    if (ids.length > 1) throw new BulkRowError(`Product name "${r['Product Name']}" matches ${ids.length} products — use Product SKU instead`);
    return ids[0];
  };

  const handler = async (r: Record<string, string>) => {
    const sku = r['SKU'].trim();
    if (!sku) throw new BulkRowError('SKU is required');
    const price = parseNumberCell(r['Price'], 'Price', { min: 0 });
    const compareAt = parseNumberCell(r['Compare-at Price'], 'Compare-at Price', { min: 0 });
    const stock = parseNumberCell(r['Stock'], 'Stock', { min: 0, integer: true });
    const existing = variantBySku.get(sku.toLowerCase());

    if (existing) {
      const parent = productById.get(existing.productId);
      if (!parent || parent.type !== 'physical') throw new BulkRowError(`SKU ${sku} belongs to a non-physical product`);
      if (r['Product SKU'] || r['Product Name']) {
        if (locateProduct(r) !== existing.productId) {
          throw new BulkRowError(`SKU ${sku} is already used by a different product`);
        }
      }
      const patch: Record<string, unknown> = {};
      if (price !== undefined && price !== existing.price) patch.price = price;
      if (compareAt !== undefined && compareAt !== existing.compareAtPrice) patch.compareAtPrice = compareAt;
      if (Object.keys(patch).length === 0) return { outcome: 'skipped' as const, note: `No changes (SKU ${sku})` };
      await deps.updateVariant(sellerId, existing.productId, existing.id, patch);
      if (patch.price !== undefined) existing.price = patch.price as number;
      if (patch.compareAtPrice !== undefined) existing.compareAtPrice = patch.compareAtPrice as number;
      return { outcome: 'updated' as const };
    }

    if (price === undefined) throw new BulkRowError('Price is required for a new variant');
    const productId = locateProduct(r);
    const parent = productById.get(productId);
    if (!parent || parent.type !== 'physical') throw new BulkRowError('Only physical products support variants');

    const options: { name: string; value: string }[] = [];
    for (const n of [1, 2, 3]) {
      const name = r[`Option ${n} Name`].trim();
      const value = r[`Option ${n} Value`].trim();
      if (!name && !value) continue;
      if (!name || !value) throw new BulkRowError(`Option ${n} needs both a Name and a Value`);
      options.push({ name, value });
    }
    try {
      validateOptions(options);
    } catch (e: any) {
      throw new BulkRowError(e.message);
    }
    const names = options.map((o) => o.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new BulkRowError('Option names must be different from each other');

    const res = await deps.addVariant(sellerId, productId, {
      sku,
      price,
      compareAtPrice: compareAt,
      options,
      stock: stock ?? 0,
      shippingWeight: r['Weight'] || undefined,
    });
    const created = res?.data;
    variantBySku.set(sku.toLowerCase(), {
      id: String(created?._id ?? ''), productId, price, compareAtPrice: compareAt ?? null,
    });
    return { outcome: 'created' as const };
  };

  return runBulkImport({
    text,
    columns: VARIANT_IMPORT_COLUMNS,
    maxRows: VARIANT_IMPORT_MAX_ROWS,
    label: 'variant',
    concurrency: 1,
    fileDedupeKey: (r) => (r['SKU'] ? `SKU ${r['SKU'].toLowerCase()}` : null),
    handler,
  });
}
