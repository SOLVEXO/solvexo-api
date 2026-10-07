/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseBoolCell,
  parseEnumCell,
  parseListCell,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { parseCustomsInput } from '../shipping-rates/customs.util';

/** Product import (Shopify-style "Import products"): CSV template + per-row
 *  create/update through the real ProductsService/ProductVariantsService
 *  paths. Unique key = SKU (case-insensitive, per store). */

export const PRODUCT_IMPORT_MAX_ROWS = 500;

export const PRODUCT_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Name', required: true, description: 'Product name (required for new products).', example: 'Classic Cotton T-Shirt' },
  { key: 'Price', required: true, description: 'Selling price in the store currency (required for new products).', example: '24.99' },
  { key: 'Description', description: 'Product description. Defaults to the name when blank.', example: 'Soft everyday tee' },
  { key: 'SKU', description: 'Unique per store. If a product with this SKU already exists it is UPDATED (non-blank cells only; stock is never changed here). Blank SKU always creates a new product.', example: 'TSHIRT-001' },
  { key: 'Compare-at Price', description: 'Original price shown struck through. Must be a number.', example: '29.99' },
  { key: 'Stock', description: 'Opening stock for NEW products (whole number). Use the Stock import to change stock later.', example: '50' },
  { key: 'Weight', description: 'Shipping weight as text, e.g. "0.5 kg". Applied to new products only.', example: '0.5 kg' },
  { key: 'Tags', description: 'Separate tags with a semicolon (;).', example: 'summer;cotton' },
  { key: 'Status', description: 'active or draft. New products default to draft.', example: 'draft' },
  { key: 'Category', description: "Name of one of your store's active categories (case-insensitive). Blank uses the store's default/first category.", example: 'Clothing' },
  { key: 'Length (cm)', description: 'Package length in cm (used to pack the item into a shipping package for live rates). Blank = unchanged.', example: '30' },
  { key: 'Width (cm)', description: 'Package width in cm.', example: '20' },
  { key: 'Height (cm)', description: 'Package height in cm.', example: '5' },
  { key: 'Country of Origin', description: '2-letter ISO country code (customs information), e.g. PK. Blank = unchanged.', example: 'PK' },
  { key: 'HS Code', description: 'Harmonized System code, 6 to 10 digits (dots allowed), e.g. 6109.10. Blank = unchanged.', example: '6109.10' },
  { key: 'Customs Description', description: 'Short goods description for customs forms (max 200 chars).', example: 'Cotton t-shirt' },
  { key: 'Charge Tax', description: 'yes / no — "Charge tax on this product". Blank = unchanged (new products are taxable).', example: 'yes' },
];

export interface ProductImportDeps {
  repos: {
    storeModel: any;
    categoryModel: any;
    productModel: any;
    productVariantModel: any;
  };
  addPhysicalProduct: (sellerId: string, body: any) => Promise<any>;
  editProduct: (sellerId: string, body: any) => Promise<any>;
  updateVariant: (sellerId: string, productId: string, variantId: string, dto: any) => Promise<any>;
}

const STATUSES = ['active', 'draft'] as const;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

export async function importProductsCsv(
  deps: ProductImportDeps,
  sellerId: string,
  storeId: string,
  text: string,
) {
  const { storeModel, categoryModel, productModel, productVariantModel } = deps.repos;
  const store = await verifyStoreOwnershipOrForbidden(storeModel, storeId, sellerId);

  const storeCategories: any[] = await categoryModel.find({ storeId, isDelete: false, status: 'active' }).lean();
  const categoryIdByName = new Map<string, string>();
  for (const c of storeCategories) categoryIdByName.set(String(c.name).trim().toLowerCase(), String(c._id));

  // SKU (lower-case) -> existing variant of a non-deleted product of THIS store.
  const products: any[] = await productModel.find({ storeId, isDelete: false }).select('_id type').lean();
  const productIds = products.map((p) => String(p._id));
  const typeById = new Map<string, string>(products.map((p) => [String(p._id), p.type]));
  const variantBySku = new Map<string, { id: string; productId: string }>();
  if (productIds.length) {
    const variants: any[] = await productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false })
      .select('_id productId sku')
      .lean();
    for (const v of variants) {
      if (v.sku) variantBySku.set(String(v.sku).toLowerCase(), { id: String(v._id), productId: String(v.productId) });
    }
  }

  const handler = async (r: Record<string, string>) => {
    const sku = r['SKU'].trim();
    const skuKey = sku.toLowerCase();
    const price = parseNumberCell(r['Price'], 'Price', { min: 0 });
    const compareAt = parseNumberCell(r['Compare-at Price'], 'Compare-at Price', { min: 0 });
    const stock = parseNumberCell(r['Stock'], 'Stock', { min: 0, integer: true });
    const status = parseEnumCell(r['Status'], 'Status', STATUSES);
    const tags = parseListCell(r['Tags']);
    const length = parseNumberCell(r['Length (cm)'], 'Length (cm)', { min: 0 });
    const width = parseNumberCell(r['Width (cm)'], 'Width (cm)', { min: 0 });
    const height = parseNumberCell(r['Height (cm)'], 'Height (cm)', { min: 0 });
    const taxable = parseBoolCell(r['Charge Tax'], 'Charge Tax');
    // Customs info: only NON-blank cells are applied (blank = leave unchanged), normalised + validated by the
    // same parser the variant form uses.
    const customsBody: Record<string, string> = {};
    if (r['Country of Origin'].trim()) customsBody.countryOfOrigin = r['Country of Origin'];
    if (r['HS Code'].trim()) customsBody.hsCode = r['HS Code'];
    if (r['Customs Description'].trim()) customsBody.customsDescription = r['Customs Description'];
    const customs = parseCustomsInput(customsBody);
    if (customs.error) throw new BulkRowError(customs.error);
    const categoryName = r['Category'].trim();
    let categoryId: string | undefined;
    if (categoryName) {
      categoryId = categoryIdByName.get(categoryName.toLowerCase());
      if (!categoryId) {
        throw new BulkRowError(`Category "${categoryName}" not found — create it first from the store's Categories page`);
      }
    }

    const existing = sku ? variantBySku.get(skuKey) : undefined;

    if (existing) {
      if (typeById.get(existing.productId) !== 'physical') {
        throw new BulkRowError(`SKU ${sku} belongs to a non-physical product — edit it from the dashboard`);
      }
      const [product, variant] = await Promise.all([
        productModel.findOne({ _id: existing.productId, storeId, isDelete: false }).lean(),
        productVariantModel.findOne({ _id: existing.id, productId: existing.productId, isDelete: false }).lean(),
      ]);
      if (!product || !variant) throw new BulkRowError(`SKU ${sku} could not be loaded`);
      const p: any = product;
      const v: any = variant;

      const productPatch: Record<string, unknown> = {};
      if (r['Name'] && r['Name'] !== p.name) productPatch.name = r['Name'];
      if (r['Description'] && r['Description'] !== p.description) productPatch.description = r['Description'];
      if (tags.length && !sameSet(tags, p.tags ?? [])) productPatch.tags = tags;
      if (status && status !== p.status) productPatch.status = status;
      if (categoryId && categoryId !== String(p.categoryId)) productPatch.categoryId = categoryId;

      const variantPatch: Record<string, unknown> = {};
      if (price !== undefined && price !== v.price) variantPatch.price = price;
      if (compareAt !== undefined && compareAt !== v.compareAtPrice) variantPatch.compareAtPrice = compareAt;
      if (length !== undefined && length !== v.length) variantPatch.length = length;
      if (width !== undefined && width !== v.width) variantPatch.width = width;
      if (height !== undefined && height !== v.height) variantPatch.height = height;
      for (const [k, val] of Object.entries(customs.value)) {
        if (val !== undefined && val !== (v[k] ?? null)) variantPatch[k] = val;
      }
      if (taxable !== undefined && taxable !== (v.taxable !== false)) variantPatch.taxable = taxable;

      if (Object.keys(productPatch).length === 0 && Object.keys(variantPatch).length === 0) {
        return { outcome: 'skipped' as const, note: `No changes (SKU ${sku})` };
      }
      if (Object.keys(productPatch).length) {
        await deps.editProduct(sellerId, { productId: existing.productId, ...productPatch });
      }
      if (Object.keys(variantPatch).length) {
        await deps.updateVariant(sellerId, existing.productId, existing.id, variantPatch);
      }
      return { outcome: 'updated' as const };
    }

    // ── create ──
    const name = r['Name'];
    if (!name) throw new BulkRowError('Name is required');
    if (price === undefined) throw new BulkRowError('Price is required');
    if (!categoryId && !store.categoryId) {
      // A product must have a category: no Category cell + no legacy store category → first store category.
      categoryId = storeCategories[0] ? String(storeCategories[0]._id) : undefined;
      if (!categoryId) {
        throw new BulkRowError("No category available — create one from the store's Categories page first");
      }
    }

    const res = await deps.addPhysicalProduct(sellerId, {
      storeId,
      name,
      description: r['Description'] || name, // the schema requires a description
      categoryId,
      images: [],
      tags,
      status: status ?? 'draft',
      variants: [
        {
          price,
          compareAtPrice: compareAt ?? null,
          sku: sku || undefined,
          stock: stock ?? 0,
          shippingWeight: r['Weight'] || null,
          length: length ?? null,
          width: width ?? null,
          height: height ?? null,
          ...customs.value,
          taxable: taxable ?? true,
          unlimitedStock: false,
          isDefault: true,
        },
      ],
    });
    // Keep the lookup current so a later duplicate in the same run is caught.
    const createdVariant = res?.data?.defaultVariant;
    const createdProduct = res?.data?.product;
    if (sku && createdVariant && createdProduct) {
      variantBySku.set(skuKey, { id: String(createdVariant._id), productId: String(createdProduct._id) });
      typeById.set(String(createdProduct._id), 'physical');
    }
    return { outcome: 'created' as const };
  };

  return runBulkImport({
    text,
    columns: PRODUCT_IMPORT_COLUMNS,
    maxRows: PRODUCT_IMPORT_MAX_ROWS,
    label: 'product',
    // concurrency 1: slug generation + the plan product limit stay race-free.
    concurrency: 1,
    fileDedupeKey: (r) => (r['SKU'] ? `SKU ${r['SKU'].toLowerCase()}` : r['Name'] ? `name ${r['Name'].toLowerCase()} (no SKU)` : null),
    handler,
  });
}
