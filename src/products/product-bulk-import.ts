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
import { parseCsv, detectDelimiter } from '../analytics/utils/csv.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { parseCustomsInput } from '../shipping-rates/customs.util';
import { normalizeShortDescription, normalizeProductTabs, normalizeVideoUrl } from './product-input.util';
import { assertValueMatchesType } from '../metafields/metafields.service';

/** Product import (Shopify-style "Import products"): CSV template + per-row
 *  create/update through the real ProductsService/ProductVariantsService
 *  paths. Unique key = Handle (preferred) or SKU (case-insensitive, per store).
 *  Supports multiple variants per product via Option columns.
 */

export const PRODUCT_IMPORT_MAX_ROWS = 500;
export const PRODUCT_SPEC_PAIRS = 10;
export const MAX_VARIANTS_PER_PRODUCT = 100;

export const PRODUCT_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Handle', required: true, description: 'Unique product handle (slug). Required for all rows. Same handle = same product.', example: 'classic-cotton-tee' },
  { key: 'Title', required: true, description: 'Product name (required for new products).', example: 'Classic Cotton T-Shirt' },
  { key: 'Body (HTML)', description: 'Product description. Defaults to the name when blank.', example: '<p>Soft everyday tee</p>' },
  { key: 'Vendor', description: 'Product vendor/brand name.', example: 'Acme Apparel' },
  { key: 'Product Category', description: "Name of one of your store's active categories (case-insensitive). Blank uses the store's default/first category.", example: 'Clothing' },
  { key: 'Type', description: 'Product type (free text, used for filtering).', example: 'T-Shirt' },
  { key: 'Tags', description: 'Separate tags with a semicolon (;).', example: 'summer;cotton' },
  { key: 'Published', description: 'TRUE = active, FALSE = draft. Blank = draft for new products.', example: 'TRUE' },
  { key: 'Option1 Name', description: 'First attribute name (e.g., Size). Required if any variant has options.', example: 'Size' },
  { key: 'Option1 Value', description: 'First attribute value (e.g., S). Required if Option1 Name is set.', example: 'S' },
  { key: 'Option2 Name', description: 'Second attribute name (e.g., Color). Optional.', example: 'Color' },
  { key: 'Option2 Value', description: 'Second attribute value. Required if Option2 Name is set.', example: 'Red' },
  { key: 'Option3 Name', description: 'Third attribute name. Optional.', example: 'Material' },
  { key: 'Option3 Value', description: 'Third attribute value. Required if Option3 Name is set.', example: 'Cotton' },
  { key: 'Variant SKU', description: 'Variant SKU, unique per store. Blank = auto-generated. If exists, updates that variant.', example: 'TEE-S-RED' },
  { key: 'Variant Price', required: true, description: 'Variant price in store currency (required).', example: '24.99' },
  { key: 'Variant Compare At Price', description: 'Original price shown struck through.', example: '29.99' },
  { key: 'Variant Inventory Qty', description: 'Opening stock for NEW variants (whole number). Blank = 0.', example: '50' },
  { key: 'Variant Inventory Policy', description: 'deny = track inventory, continue = allow backorder. Blank = deny.', example: 'deny' },
  { key: 'Variant Weight', description: 'Shipping weight as text, e.g. "0.5 kg".', example: '0.5 kg' },
  { key: 'Variant Weight Unit', description: 'kg or g. Blank = kg.', example: 'kg' },
  { key: 'Variant Length (cm)', description: 'Package length in cm for live shipping rates.', example: '30' },
  { key: 'Variant Width (cm)', description: 'Package width in cm.', example: '20' },
  { key: 'Variant Height (cm)', description: 'Package height in cm.', example: '5' },
  { key: 'Variant Country of Origin', description: '2-letter ISO country code for customs.', example: 'PK' },
  { key: 'Variant HS Code', description: 'Harmonized System code, 6-10 digits.', example: '6109.10' },
  { key: 'Variant Customs Description', description: 'Short goods description for customs forms (max 200 chars).', example: 'Cotton t-shirt' },
  { key: 'Variant Taxable', description: 'TRUE/FALSE — Charge tax on this variant. Blank = TRUE.', example: 'TRUE' },
  { key: 'Image Src', description: 'https link to a photo. Multiple images: separate with semicolon (;). First image = product image.', example: 'https://example.com/photo1.jpg;https://example.com/photo2.jpg' },
  { key: 'Image Position', description: 'Position of this image in the gallery (1-based). Blank = auto.', example: '1' },
  { key: 'Image Alt Text', description: 'Alt text for the image.', example: 'Red cotton t-shirt front view' },
  { key: 'Variant Image', description: 'Image URL for THIS specific variant (shown when variant selected).', example: 'https://example.com/red-tee.jpg' },
  { key: 'Metafield: custom.namespace.key [type]', description: 'Metafield columns: namespace.key [type]. Types: single_line_text_field, number_integer, number_decimal, boolean, date, json. Example: Metafield: custom.brand [single_line_text_field]', example: 'Metafield: custom.brand [single_line_text_field]' },
  { key: 'SEO Title', description: 'Search engine title. Blank = auto from product name.', example: 'Classic Cotton T-Shirt | Acme Store' },
  { key: 'SEO Description', description: 'Search engine description. Blank = auto from product description.', example: 'Soft everyday cotton t-shirt in multiple sizes and colors.' },
  { key: 'Google Shopping / Custom Label 0', description: 'Custom label for Google Shopping.', example: 'summer-collection' },
  { key: 'Google Shopping / Custom Label 1', description: 'Custom label for Google Shopping.', example: 'cotton' },
  { key: 'Google Shopping / Custom Label 2', description: 'Custom label for Google Shopping.', example: '' },
  { key: 'Google Shopping / Custom Label 3', description: 'Custom label for Google Shopping.', example: '' },
  { key: 'Google Shopping / Custom Label 4', description: 'Custom label for Google Shopping.', example: '' },
  { key: 'Google Shopping / Age Group', description: 'Age group: newborn, infant, toddler, kids, adult.', example: 'adult' },
  { key: 'Google Shopping / Gender', description: 'Gender: male, female, unisex.', example: 'unisex' },
  { key: 'Google Shopping / MPN', description: 'Manufacturer Part Number.', example: 'TEE-001' },
  { key: 'Google Shopping / Condition', description: 'Condition: new, used, refurbished.', example: 'new' },
  { key: 'Cost per item', description: 'Cost price for margin calculation.', example: '12.50' },
  { key: 'Status', description: 'active, draft, archived. Blank = draft for new products.', example: 'active' },
  { key: 'Short Description', description: 'One or two lines shown under the price (max 500 chars).', example: 'Soft everyday tee in organic cotton' },
  { key: 'Tab 1 Title', description: 'Title of an extra tab next to Description (max 40 chars).', example: 'Size guide' },
  { key: 'Tab 1 Content', description: 'Text of that tab (plain text or simple HTML).', example: 'S fits 36, M fits 38' },
  { key: 'Tab 2 Title', description: 'Title of a second extra tab.', example: 'Delivery' },
  { key: 'Tab 2 Content', description: 'Text of the second tab.', example: 'Ships in 2 to 3 days' },
  ...Array.from({ length: PRODUCT_SPEC_PAIRS }, (_, i) => i + 1).flatMap((n): BulkColumn[] => [
    { key: `Spec ${n} Name`, description: n === 1 ? 'A specification name shown in the product\'s Specifications table. Up to 10 pairs. A new name creates a shared field. Needs the Value too.' : `Name of specification ${n}.`, example: n === 1 ? 'Brand' : n === 2 ? 'Capacity' : '' },
    { key: `Spec ${n} Value`, description: n === 1 ? 'The value of that specification for this product (max 500 chars).' : `Value of specification ${n}.`, example: n === 1 ? 'Ecostar' : n === 2 ? '1.0 Ton' : '' },
  ]),
  { key: 'Video URL', description: 'https link to an uploaded video, or a YouTube / Vimeo link.', example: 'https://www.youtube.com/watch?v=...' },
];

export interface ProductImportDeps {
  repos: {
    storeModel: any;
    categoryModel: any;
    productModel: any;
    productVariantModel: any;
    metafieldDefinitionModel?: any;
    metafieldValueModel?: any;
  };
  addPhysicalProduct: (sellerId: string, body: any) => Promise<any>;
  addVariant: (sellerId: string, productId: string, dto: any) => Promise<any>;
  editProduct: (sellerId: string, body: any) => Promise<any>;
  updateVariant: (sellerId: string, productId: string, variantId: string, dto: any) => Promise<any>;
}

const STATUSES = ['active', 'draft', 'archived', 'inactive'] as const;
const INVENTORY_POLICIES = ['deny', 'continue'] as const;
const WEIGHT_UNITS = ['kg', 'g'] as const;
const AGE_GROUPS = ['newborn', 'infant', 'toddler', 'kids', 'adult'] as const;
const GENDERS = ['male', 'female', 'unisex'] as const;
const CONDITIONS = ['new', 'used', 'refurbished'] as const;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

interface ParsedRow {
  handle: string;
  rowNumber: number;
  raw: Record<string, string>;
  productData: ProductData;
  variantData: VariantData;
}

interface ProductData {
  title: string;
  description: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: string;
  categoryId?: string;
  images: { src: string; position?: number; alt?: string }[];
  metafields: Record<string, { value: string; type: string }>;
  seoTitle: string;
  seoDescription: string;
  googleShopping: {
    customLabels: string[];
    ageGroup: string;
    gender: string;
    mpn: string;
    condition: string;
  };
  costPerItem: number | undefined;
  shortDescription: string;
  tabs: { title: string; content: string }[];
  specs: { name: string; value: string }[];
  videoUrl: string;
}

interface VariantData {
  options: { name: string; value: string }[];
  sku: string;
  price: number;
  compareAtPrice: number | undefined;
  stock: number;
  inventoryPolicy: 'deny' | 'continue';
  weight: string;
  weightUnit: 'kg' | 'g';
  length: number | undefined;
  width: number | undefined;
  height: number | undefined;
  countryOfOrigin: string;
  hsCode: string;
  customsDescription: string;
  taxable: boolean | undefined;
  variantImage: string;
  imagePosition: number | undefined;
  imageAltText: string;
}

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

  const products: any[] = await productModel.find({ storeId, isDelete: false }).select('_id handle slug type variants').lean();
  const productByHandle = new Map<string, any>();
  const variantBySku = new Map<string, { id: string; productId: string; handle: string }>();
  for (const p of products) {
    productByHandle.set(String(p.handle).toLowerCase(), p);
    if (p.variants) {
      for (const v of p.variants) {
        if (v.sku) variantBySku.set(String(v.sku).toLowerCase(), { id: String(v._id), productId: String(p._id), handle: String(p.handle) });
      }
    }
  }

  const { metafieldDefinitionModel: defModel, metafieldValueModel: valModel } = deps.repos;
  type SpecDef = { key: string; namespace: string; type: string; name: string };
  const specDefByName = new Map<string, SpecDef>();
  const usedSpecKeys = new Set<string>();
  if (defModel) {
    const defs: any[] = await defModel.find({ storeId, ownerResource: 'product' }).lean();
    for (const d of defs) {
      specDefByName.set(String(d.name).trim().toLowerCase(), { key: d.key, namespace: d.namespace, type: d.type, name: d.name });
      usedSpecKeys.add(String(d.key));
    }
  }
  const specKeyFor = (name: string) => {
    let base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34);
    if (!/^[a-z]/.test(base)) base = `spec-${base}`.replace(/-$/, '');
    let key = base, n = 2;
    while (usedSpecKeys.has(key)) key = `${base.slice(0, 34)}-${n++}`;
    return key;
  };

  const readSpecs = (r: Record<string, string>): { name: string; value: string }[] => {
    const out: { name: string; value: string }[] = [];
    for (let n = 1; n <= PRODUCT_SPEC_PAIRS; n++) {
      const name = (r[`Spec ${n} Name`] ?? '').trim();
      const value = (r[`Spec ${n} Value`] ?? '').trim();
      if (!name && !value) continue;
      if (!name || !value) throw new BulkRowError(`Spec ${n}: give both a Name and a Value (or leave both blank)`);
      if (name.length > 60) throw new BulkRowError(`Spec ${n} Name is too long (max 60 characters)`);
      if (value.length > 500) throw new BulkRowError(`Spec ${n} Value is too long (max 500 characters)`);
      if (out.some(o => o.name.toLowerCase() === name.toLowerCase())) throw new BulkRowError(`Spec "${name}" appears twice in this row`);
      const def = specDefByName.get(name.toLowerCase());
      if (def) {
        try { assertValueMatchesType(def.type as any, value, def.name); } catch (e: any) { throw new BulkRowError(e?.message ?? `Spec "${name}": invalid value`); }
      }
      out.push({ name, value });
    }
    return out;
  };

  const applySpecs = async (productId: string, specs: { name: string; value: string }[]) => {
    if (!defModel || !valModel) return;
    for (const s of specs) {
      let def = specDefByName.get(s.name.toLowerCase());
      if (!def) {
        const key = specKeyFor(s.name);
        await defModel.create({ storeId, ownerResource: 'product', namespace: 'custom', key, name: s.name, type: 'single_line_text_field', required: false, storefrontAccess: true });
        def = { key, namespace: 'custom', type: 'single_line_text_field', name: s.name };
        specDefByName.set(s.name.toLowerCase(), def);
        usedSpecKeys.add(key);
      }
      await valModel.findOneAndUpdate(
        { storeId, ownerResource: 'product', ownerId: productId, namespace: def.namespace, key: def.key },
        { $set: { value: s.value } },
        { upsert: true },
      );
    }
  };

  const parseRow = (r: Record<string, string>, rowNumber: number): ParsedRow => {
    const handle = r['Handle'].trim().toLowerCase();
    if (!handle) throw new BulkRowError('Handle is required');

    const title = r['Title']?.trim();
    if (!title) throw new BulkRowError('Title is required');

    const price = parseNumberCell(r['Variant Price'], 'Variant Price', { min: 0 });
    if (price === undefined) throw new BulkRowError('Variant Price is required');

    const statusCell = r['Status']?.trim() || r['Published']?.trim();
    let status: string | undefined;
    if (statusCell) {
      const pub = parseEnumCell(statusCell, 'Published', ['true', 'false']);
      if (pub !== undefined) status = pub === 'true' ? 'active' : 'draft';
      else status = parseEnumCell(statusCell, 'Status', STATUSES) as string | undefined;
    }

    const categoryName = r['Product Category']?.trim();
    let categoryId: string | undefined;
    if (categoryName) {
      categoryId = categoryIdByName.get(categoryName.toLowerCase());
      if (!categoryId) throw new BulkRowError(`Category "${categoryName}" not found — create it first`);
    }

    const images = r['Image Src']?.split(';').map(u => u.trim()).filter(Boolean) || [];
    if (images.some(u => !/^https?:\/\/\S+$/i.test(u))) throw new BulkRowError('Image Src must be valid https URLs (separate with ;)');

    let shortDescription = '';
    try { shortDescription = normalizeShortDescription(r['Short Description'] ?? ''); } catch (e: any) { throw new BulkRowError(`Short Description: ${e?.message ?? 'invalid'}`); }

    let csvTabs: { title: string; content: string }[] = [];
    try { csvTabs = normalizeProductTabs([1, 2].map(n => ({ title: r[`Tab ${n} Title`] ?? '', content: r[`Tab ${n} Content`] ?? '' }))); } catch (e: any) { throw new BulkRowError(`Tabs: ${e?.message ?? 'invalid'}`); }

    let videoUrl = '';
    try { videoUrl = normalizeVideoUrl((r['Video URL'] ?? '').trim()); } catch (e: any) { throw new BulkRowError(`Video URL: ${e?.message ?? 'invalid link'}`); }

    const customsBody: Record<string, string> = {};
    if (r['Variant Country of Origin']?.trim()) customsBody.countryOfOrigin = r['Variant Country of Origin'].trim();
    if (r['Variant HS Code']?.trim()) customsBody.hsCode = r['Variant HS Code'].trim();
    if (r['Variant Customs Description']?.trim()) customsBody.customsDescription = r['Variant Customs Description'].trim();
    const customs = parseCustomsInput(customsBody);
    if (customs.error) throw new BulkRowError(customs.error);

    const tags = parseListCell(r['Tags'] ?? '');

    const inventoryPolicy = parseEnumCell(r['Variant Inventory Policy'], 'Variant Inventory Policy', INVENTORY_POLICIES);
    const weightUnit = parseEnumCell(r['Variant Weight Unit'], 'Variant Weight Unit', WEIGHT_UNITS) || 'kg';

    const length = parseNumberCell(r['Variant Length (cm)'], 'Variant Length (cm)', { min: 0 });
    const width = parseNumberCell(r['Variant Width (cm)'], 'Variant Width (cm)', { min: 0 });
    const height = parseNumberCell(r['Variant Height (cm)'], 'Variant Height (cm)', { min: 0 });
    const stock = parseNumberCell(r['Variant Inventory Qty'], 'Variant Inventory Qty', { min: 0, integer: true });
    const compareAt = parseNumberCell(r['Variant Compare At Price'], 'Variant Compare At Price', { min: 0 });
    const taxable = parseBoolCell(r['Variant Taxable'], 'Variant Taxable');
    const costPerItem = parseNumberCell(r['Cost per item'], 'Cost per item', { min: 0 });

    const seoTitle = r['SEO Title']?.trim();
    const seoDescription = r['SEO Description']?.trim();

    const googleShopping = {
      customLabels: [
        r['Google Shopping / Custom Label 0']?.trim(),
        r['Google Shopping / Custom Label 1']?.trim(),
        r['Google Shopping / Custom Label 2']?.trim(),
        r['Google Shopping / Custom Label 3']?.trim(),
        r['Google Shopping / Custom Label 4']?.trim(),
      ].filter(Boolean),
      ageGroup: parseEnumCell(r['Google Shopping / Age Group'], 'Google Shopping / Age Group', AGE_GROUPS) || '',
      gender: parseEnumCell(r['Google Shopping / Gender'], 'Google Shopping / Gender', GENDERS) || '',
      mpn: r['Google Shopping / MPN']?.trim() || '',
      condition: parseEnumCell(r['Google Shopping / Condition'], 'Google Shopping / Condition', CONDITIONS) || '',
    };

    const metafields: Record<string, { value: string; type: string }> = {};
    for (const [key, value] of Object.entries(r)) {
      const m = key.match(/^Metafield:\s*(.+)\s*\[(\w+)\]$/);
      if (m) {
        metafields[m[1].trim()] = { value: value.trim(), type: m[2] };
      }
    }

    const options: { name: string; value: string }[] = [];
    for (const n of [1, 2, 3]) {
      const name = r[`Option${n} Name`]?.trim() || r[`Option ${n} Name`]?.trim();
      const value = r[`Option${n} Value`]?.trim() || r[`Option ${n} Value`]?.trim();
      if (!name && !value) continue;
      if (!name || !value) throw new BulkRowError(`Option ${n} needs both a Name and a Value`);
      options.push({ name, value });
    }
    const optionNames = options.map(o => o.name.toLowerCase());
    if (new Set(optionNames).size !== optionNames.length) throw new BulkRowError('Option names must be different');

    const sku = r['Variant SKU']?.trim();
    const variantImage = r['Variant Image']?.trim();
    const imagePosition = parseNumberCell(r['Image Position'], 'Image Position', { min: 1, integer: true });
    const imageAltText = r['Image Alt Text']?.trim();

    const specs = readSpecs(r);

    return {
      handle,
      rowNumber,
      raw: r,
      productData: {
        title,
        description: r['Body (HTML)']?.trim() || title,
        vendor: r['Vendor']?.trim(),
        productType: r['Type']?.trim(),
        tags,
        status: status ?? 'draft',
        categoryId,
        images: images.map((src, idx) => ({ src, position: idx + 1, alt: '' })),
        metafields,
        seoTitle,
        seoDescription,
        googleShopping,
        costPerItem,
        shortDescription,
        tabs: csvTabs,
        specs,
        videoUrl,
      },
      variantData: {
        options,
        sku,
        price,
        compareAtPrice: compareAt,
        stock: stock ?? 0,
        inventoryPolicy: inventoryPolicy ?? 'deny',
        weight: r['Variant Weight']?.trim() || '',
        weightUnit,
        length,
        width,
        height,
        countryOfOrigin: r['Variant Country of Origin']?.trim() || '',
        hsCode: r['Variant HS Code']?.trim() || '',
        customsDescription: r['Variant Customs Description']?.trim() || '',
        taxable,
        variantImage,
        imagePosition,
        imageAltText,
      },
    };
  };

  const rows = parseCsv(text, detectDelimiter(text));
  if (rows.length === 0) throw new BulkRowError('The CSV file has no data rows.');
  if (rows.length > PRODUCT_IMPORT_MAX_ROWS) {
    throw new BulkRowError(`A single import is capped at ${PRODUCT_IMPORT_MAX_ROWS} rows — split larger files into several.`);
  }

  const parsedRows: ParsedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    try {
      parsedRows.push(parseRow(rows[i], rowNumber));
    } catch (err: any) {
      throw new BulkRowError(err?.message ?? 'Could not parse row');
    }
  }

  const groups = new Map<string, ParsedRow[]>();
  for (const pr of parsedRows) {
    const arr = groups.get(pr.handle) || [];
    arr.push(pr);
    groups.set(pr.handle, arr);
  }

  for (const [handle, group] of groups) {
    if (group.length > MAX_VARIANTS_PER_PRODUCT) {
      throw new BulkRowError(`Handle "${handle}" has ${group.length} variants (max ${MAX_VARIANTS_PER_PRODUCT})`);
    }
    const firstProductData = group[0].productData;
    for (let i = 1; i < group.length; i++) {
      const pd = group[i].productData;
      const fields: (keyof ProductData)[] = ['title', 'description', 'vendor', 'productType', 'tags', 'status', 'categoryId', 'images', 'metafields', 'seoTitle', 'seoDescription', 'googleShopping', 'costPerItem', 'shortDescription', 'tabs', 'specs', 'videoUrl'];
      for (const f of fields) {
        const v1 = firstProductData[f];
        const v2 = pd[f];
        if (Array.isArray(v1) && Array.isArray(v2)) {
          if (v1.length !== v2.length || v1.some((x, i) => JSON.stringify(x) !== JSON.stringify(v2[i]))) {
            throw new BulkRowError(`Handle "${handle}": product data differs between rows (${f})`);
          }
        } else if (JSON.stringify(v1) !== JSON.stringify(v2)) {
          throw new BulkRowError(`Handle "${handle}": product data differs between rows (${f})`);
        }
      }
    }
    const allOptions = group.map(g => g.variantData.options);
    const firstOptions = allOptions[0];
    for (let i = 1; i < allOptions.length; i++) {
      if (JSON.stringify(firstOptions) !== JSON.stringify(allOptions[i])) {
        throw new BulkRowError(`Handle "${handle}": option names differ between variants`);
      }
    }
    const optionNames = firstOptions.map(o => o.name.toLowerCase());
    if (new Set(optionNames).size !== optionNames.length) throw new BulkRowError(`Handle "${handle}": duplicate option names`);
    if (optionNames.length > 3) throw new BulkRowError(`Handle "${handle}": max 3 options allowed`);

    const variantKeys = group.map(g => g.variantData.options.map(o => o.value).join('|'));
    if (new Set(variantKeys).size !== variantKeys.length) throw new BulkRowError(`Handle "${handle}": duplicate variant option combinations`);
  }

  const existingProductByHandle = new Map<string, any>();
  const existingVariantBySku = new Map<string, { id: string; productId: string; handle: string }>();
  for (const [handle, product] of productByHandle) {
    existingProductByHandle.set(handle, product);
  }
  for (const [sku, v] of variantBySku) {
    existingVariantBySku.set(sku, v);
  }

  const handler = async (groupRows: ParsedRow[]) => {
    const handle = groupRows[0].handle;
    const productData = groupRows[0].productData;
    const variantsData = groupRows.map(g => g.variantData);

    const existingProduct = existingProductByHandle.get(handle);
    const existingVariants: any[] = [];
    if (existingProduct) {
      const vars: any[] = await productVariantModel.find({ productId: existingProduct._id, isDelete: false }).lean();
      existingVariants.push(...vars);
    }

    const variantSkuMap = new Map<string, any>();
    for (const v of existingVariants) {
      if (v.sku) variantSkuMap.set(v.sku.toLowerCase(), v);
    }

    const createdVariants: any[] = [];
    const updatedVariants: any[] = [];

    for (const vd of variantsData) {
      let targetVariant: any = null;
      if (vd.sku) {
        targetVariant = variantSkuMap.get(vd.sku.toLowerCase());
      }
      if (!targetVariant && vd.options.length > 0) {
        for (const ev of existingVariants) {
          const evOptions = (ev.options || []).map((o: any) => ({ name: o.name, value: o.value }));
          const vdOptions = vd.options.map(o => ({ name: o.name, value: o.value }));
          if (JSON.stringify(evOptions.sort((a, b) => a.name.localeCompare(b.name))) === JSON.stringify(vdOptions.sort((a, b) => a.name.localeCompare(b.name)))) {
            targetVariant = ev;
            break;
          }
        }
      }

      const variantPatch: Record<string, unknown> = {};
      if (vd.price !== undefined && vd.price !== (targetVariant?.price ?? -1)) variantPatch.price = vd.price;
      if (vd.compareAtPrice !== undefined && vd.compareAtPrice !== (targetVariant?.compareAtPrice ?? -1)) variantPatch.compareAtPrice = vd.compareAtPrice;
      if (vd.stock !== undefined && vd.stock !== (targetVariant?.stock ?? -1)) variantPatch.stock = vd.stock;
      if (vd.inventoryPolicy !== 'deny') variantPatch.allowBackorder = vd.inventoryPolicy === 'continue';
      if (vd.weight) variantPatch.shippingWeight = vd.weight;
      if (vd.length !== undefined) variantPatch.length = vd.length;
      if (vd.width !== undefined) variantPatch.width = vd.width;
      if (vd.height !== undefined) variantPatch.height = vd.height;
      if (vd.countryOfOrigin) variantPatch.countryOfOrigin = vd.countryOfOrigin;
      if (vd.hsCode) variantPatch.hsCode = vd.hsCode;
      if (vd.customsDescription) variantPatch.customsDescription = vd.customsDescription;
      if (vd.taxable !== undefined) variantPatch.taxable = vd.taxable;
      if (vd.variantImage) variantPatch.images = [vd.variantImage];

      if (targetVariant) {
        if (Object.keys(variantPatch).length > 0) {
          await deps.updateVariant(sellerId, targetVariant.productId, targetVariant._id, variantPatch);
          updatedVariants.push({ sku: vd.sku || targetVariant.sku, action: 'updated' });
        } else {
          updatedVariants.push({ sku: vd.sku || targetVariant.sku, action: 'skipped' });
        }
      } else {
        const newVariant = await deps.addVariant?.(sellerId, existingProduct?._id || '', {
          sku: vd.sku,
          price: vd.price,
          compareAtPrice: vd.compareAtPrice ?? null,
          options: vd.options,
          stock: vd.stock,
          shippingWeight: vd.weight || undefined,
          length: vd.length,
          width: vd.width,
          height: vd.height,
          countryOfOrigin: vd.countryOfOrigin || undefined,
          hsCode: vd.hsCode || undefined,
          customsDescription: vd.customsDescription || undefined,
          taxable: vd.taxable ?? true,
          images: vd.variantImage ? [vd.variantImage] : [],
          unlimitedStock: false,
          allowBackorder: vd.inventoryPolicy === 'continue',
        });
        if (newVariant) createdVariants.push({ sku: vd.sku || newVariant.data?.sku, action: 'created' });
      }
    }

    if (existingProduct) {
      const productPatch: Record<string, unknown> = {};
      if (productData.title !== existingProduct.name) productPatch.name = productData.title;
      if (productData.description !== existingProduct.description) productPatch.description = productData.description;
      if (productData.vendor && productData.vendor !== existingProduct.vendor) productPatch.vendor = productData.vendor;
      if (productData.productType && productData.productType !== existingProduct.productType) productPatch.productType = productData.productType;
      if (productData.tags.length && !sameSet(productData.tags, existingProduct.tags ?? [])) productPatch.tags = productData.tags;
      if (productData.status && productData.status !== existingProduct.status) productPatch.status = productData.status;
      if (productData.categoryId && productData.categoryId !== String(existingProduct.categoryId)) productPatch.categoryId = productData.categoryId;
      if (productData.images.length > 0) {
        const newImages = productData.images.map(i => i.src);
        const existingImages = existingProduct.images || [];
        if (JSON.stringify(newImages) !== JSON.stringify(existingImages)) productPatch.images = newImages;
      }
      if (productData.videoUrl && productData.videoUrl !== existingProduct.videoUrl) productPatch.videoUrl = productData.videoUrl;
      if (productData.shortDescription && productData.shortDescription !== existingProduct.shortDescription) productPatch.shortDescription = productData.shortDescription;
      if (productData.tabs.length) productPatch.tabs = productData.tabs;
      if (productData.seoTitle) productPatch.metaTitle = productData.seoTitle;
      if (productData.seoDescription) productPatch.metaDescription = productData.seoDescription;
      if (productData.googleShopping.customLabels.length) productPatch.googleShoppingLabels = productData.googleShopping.customLabels;
      if (productData.googleShopping.ageGroup) productPatch.googleShoppingAgeGroup = productData.googleShopping.ageGroup;
      if (productData.googleShopping.gender) productPatch.googleShoppingGender = productData.googleShopping.gender;
      if (productData.googleShopping.mpn) productPatch.googleShoppingMpn = productData.googleShopping.mpn;
      if (productData.googleShopping.condition) productPatch.googleShoppingCondition = productData.googleShopping.condition;
      if (productData.costPerItem !== undefined) productPatch.costPerItem = productData.costPerItem;

      if (Object.keys(productPatch).length > 0) {
        await deps.editProduct(sellerId, { productId: existingProduct._id, ...productPatch });
      }

      await applySpecs(String(existingProduct._id), productData.specs);

      return { outcome: 'updated' as const, createdVariants, updatedVariants };
    }

    if (!productData.categoryId && !store.categoryId) {
      productData.categoryId = storeCategories[0] ? String(storeCategories[0]._id) : undefined;
      if (!productData.categoryId) throw new BulkRowError('No category available — create one first');
    }

    const variantInputs = variantsData.map(vd => ({
      sku: vd.sku || undefined,
      price: vd.price,
      compareAtPrice: vd.compareAtPrice ?? null,
      options: vd.options,
      stock: vd.stock,
      shippingWeight: vd.weight || undefined,
      length: vd.length,
      width: vd.width,
      height: vd.height,
      countryOfOrigin: vd.countryOfOrigin || undefined,
      hsCode: vd.hsCode || undefined,
      customsDescription: vd.customsDescription || undefined,
      taxable: vd.taxable ?? true,
      images: vd.variantImage ? [vd.variantImage] : [],
      unlimitedStock: false,
      allowBackorder: vd.inventoryPolicy === 'continue',
    }));

    const res = await deps.addPhysicalProduct(sellerId, {
      storeId,
      name: productData.title,
      description: productData.description,
      vendor: productData.vendor,
      productType: productData.productType,
      tags: productData.tags,
      status: productData.status,
      categoryId: productData.categoryId,
      images: productData.images.map(i => i.src),
      videoUrl: productData.videoUrl,
      shortDescription: productData.shortDescription,
      tabs: productData.tabs,
      variants: variantInputs,
      isListedOnSolvexo: false,
    });

    const createdProduct = res?.data?.product;
    const newVariants = res?.data?.variants || [];
    if (createdProduct) {
      existingProductByHandle.set(handle, createdProduct);
      for (const v of newVariants) {
        if (v.sku) variantSkuMap.set(v.sku.toLowerCase(), { id: String(v._id), productId: String(createdProduct._id), handle });
      }
      await applySpecs(String(createdProduct._id), productData.specs);
    }

    return { outcome: 'created' as const, createdVariants: newVariants.map(v => ({ sku: v.sku, action: 'created' })) };
  };

  return runBulkImport({
    text,
    columns: PRODUCT_IMPORT_COLUMNS,
    maxRows: PRODUCT_IMPORT_MAX_ROWS,
    label: 'product',
    concurrency: 1,
    fileDedupeKey: (r) => {
      const handle = (r['Handle'] || '').trim().toLowerCase();
      return handle ? `handle ${handle}` : null;
    },
    handler: async (record: Record<string, string>, rowNumber: number) => {
      const pr = parseRow(record, rowNumber);
      const group = groups.get(pr.handle)!;
      return handler(group);
    },
  });
}