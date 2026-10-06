/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseEnumCell,
  parseListCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { slugify } from '../common/slug.util';

export const COLLECTION_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Title', required: true, description: 'Collection name. Unique per store (case-insensitive) — an existing collection is skipped.', example: 'New Arrivals' },
  { key: 'Description', description: 'Optional plain text.', example: 'Fresh in this week' },
  { key: 'Status', description: 'active (published) or draft (default draft).', example: 'draft' },
  { key: 'Product SKUs', required: true, description: 'Variant SKUs of THIS store separated by ";". Each SKU is resolved to its product; every SKU must exist. A manual collection needs at least one product.', example: 'TSHIRT-RED-M;TSHIRT-BLUE-M' },
];

export const COLLECTION_IMPORT_MAX_ROWS = 1000;
const MAX_SKUS_PER_ROW = 500;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CollectionImportDeps {
  collectionModel: any;
  productModel: any;
  productVariantModel: any;
  /** CollectionsService-like: the REAL create path. */
  collectionsService: { create(storeId: string, sellerId: string, dto: any): Promise<any> };
}

/** Manual collections only. Automatic (rule) collections are not supported by CSV. */
export async function importCollectionsCsv(deps: CollectionImportDeps, sellerId: string, storeId: string, text: string) {
  const { collectionModel, productModel, productVariantModel, collectionsService } = deps;

  return runBulkImport({
    text,
    columns: COLLECTION_IMPORT_COLUMNS,
    maxRows: COLLECTION_IMPORT_MAX_ROWS,
    label: 'collection',
    fileDedupeKey: (r) => (r.Title ? r.Title.toLowerCase() : null),
    handler: async (r) => {
      const name = r.Title.trim();
      if (!name) throw new BulkRowError('Title is required');
      if (name.length > 255) throw new BulkRowError('Title cannot be more than 255 characters');
      const status = parseEnumCell(r.Status, 'Status', ['active', 'draft'] as const) ?? 'draft';
      const skus = [...new Set(parseListCell(r['Product SKUs']))];
      if (skus.length === 0) throw new BulkRowError('Product SKUs is required (a manual collection needs at least one product)');
      if (skus.length > MAX_SKUS_PER_ROW) throw new BulkRowError(`Product SKUs: at most ${MAX_SKUS_PER_ROW} per row`);

      const existing = await collectionModel.findOne({
        storeId,
        isDelete: false,
        $or: [{ name: new RegExp(`^${escapeRegex(name)}$`, 'i') }, { slug: slugify(name) || 'collection' }],
      });
      if (existing) return { outcome: 'skipped', note: `Collection "${name}" already exists` };

      // SKU -> variant -> product, always confined to this store's live products.
      const variants: any[] = await productVariantModel
        .find({ sku: { $in: skus.map(String) }, isDelete: false })
        .select('sku productId')
        .lean();
      const productIds = [...new Set(variants.map((v) => String(v.productId)))];
      const products: any[] = productIds.length
        ? await productModel.find({ _id: { $in: productIds }, storeId, isDelete: false }).select('_id').lean()
        : [];
      const okProducts = new Set(products.map((p) => String(p._id)));
      const productBySku = new Map<string, string>();
      for (const v of variants) {
        if (okProducts.has(String(v.productId)) && !productBySku.has(String(v.sku))) productBySku.set(String(v.sku), String(v.productId));
      }
      const unknown = skus.filter((s) => !productBySku.has(s));
      if (unknown.length) throw new BulkRowError(`Unknown SKU in this store: ${unknown.join(', ')}`);

      await collectionsService.create(storeId, sellerId, {
        name,
        type: 'manual',
        status,
        productIds: [...new Set(skus.map((s) => productBySku.get(s) as string))],
        ...(r.Description ? { description: r.Description } : {}),
      });
      return { outcome: 'created' };
    },
  });
}
