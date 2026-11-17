/* eslint-disable prettier/prettier */
import { SeoResolutionService } from './seo-resolution.service';

const PRODUCT_ID = 'a'.repeat(24);
const lean = (value: any) => ({ lean: () => Promise.resolve(value) });

function build(opts: { productSeo?: any; storeSeo?: any; categorySeo?: any; template?: any } = {}) {
  const product = { _id: PRODUCT_ID, storeId: 's1', categoryId: 'c1', name: 'Blue Shirt', slug: 'blue-shirt', description: 'A soft cotton shirt.', images: ['p.jpg'], type: 'physical', seo: opts.productSeo };
  const repositories: any = {
    productModel: { findOne: () => lean(product) },
    productVariantModel: { find: () => lean([{ isDefault: true, price: 10, stock: 5 }]) },
    categoryModel: { findById: () => lean({ _id: 'c1', name: 'Shirts', slug: 'shirts', seo: opts.categorySeo }) },
    storeModel: (() => { const row = { _id: 's1', name: 'Acme', slug: 'acme', seo: opts.storeSeo }; return { findById: () => lean(row), findOne: () => lean(row) }; })(),
  };
  const redis: any = { isConnected: false, get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const platform: any = { getSettings: async () => ({ metaTemplates: opts.template ? [opts.template] : [] }) };
  const schema: any = { buildProductSchema: () => ({}), buildBreadcrumbSchema: () => ({}), buildStoreSchema: () => ({}) };
  return new SeoResolutionService({ repositories } as any, redis, platform, schema);
}

describe('SeoResolutionService.resolve(product)', () => {
  it('defaults to "Product – Store" and the product description', async () => {
    const meta = await build().resolve('product', PRODUCT_ID);
    expect(meta.title).toBe('Blue Shirt – Acme');
    expect(meta.description).toBe('A soft cotton shirt.');
  });

  it('never reuses the store or category meta title/description for a product with no SEO of its own', async () => {
    const meta = await build({
      storeSeo: { metaTitle: 'Acme | Best clothes', metaDescription: 'Store-wide description' },
      categorySeo: { metaTitle: 'Shirts category', metaDescription: 'Category description' },
    }).resolve('product', PRODUCT_ID);
    expect(meta.title).toBe('Blue Shirt – Acme');
    expect(meta.description).toBe('A soft cotton shirt.');
    expect(meta.ogTitle).toBe('Blue Shirt – Acme');
  });

  it('uses the seller\'s own product SEO when set', async () => {
    const meta = await build({
      productSeo: { metaTitle: 'Custom title', metaDescription: 'Custom description' },
      storeSeo: { metaTitle: 'Store title' },
    }).resolve('product', PRODUCT_ID);
    expect(meta.title).toBe('Custom title');
    expect(meta.description).toBe('Custom description');
  });

  it('ignores the platform admin meta templates: only the seller shapes a storefront title', async () => {
    const meta = await build({ template: { key: 'product', titleTemplate: '{{productName}} | Solvexo', descriptionTemplate: 'Buy on Solvexo' } }).resolve('product', PRODUCT_ID);
    expect(meta.title).toBe('Blue Shirt – Acme');
    expect(meta.description).toBe('A soft cotton shirt.');
  });

  it('store home: seller title wins, else the plain store name, never an admin template', async () => {
    const withTemplate = { key: 'store', titleTemplate: '{{storeName}} | Solvexo', descriptionTemplate: 'On Solvexo' };
    const plain = await build({ template: withTemplate }).resolve('store', 's1');
    expect(plain.title).toBe('Acme');
    expect(plain.description).toBe('');
    const custom = await build({ template: withTemplate, storeSeo: { metaTitle: 'Acme – Shirts', metaDescription: 'Great shirts' } }).resolve('store', 's1');
    expect(custom.title).toBe('Acme – Shirts');
    expect(custom.description).toBe('Great shirts');
  });
});

describe('emptied SEO fields count as unset', () => {
  it('product: a seller who clears title/description gets the default back, not a blank tab', async () => {
    const meta = await build({ productSeo: { metaTitle: '', metaDescription: '', ogTitle: '', ogDescription: '' } }).resolve('product', PRODUCT_ID);
    expect(meta.title).toBe('Blue Shirt – Acme');
    expect(meta.description).toBe('A soft cotton shirt.');
    expect(meta.ogTitle).toBe('Blue Shirt – Acme');
  });

  it('store home: empty title falls back to the store name', async () => {
    const meta = await build({ storeSeo: { metaTitle: '', metaDescription: '' } }).resolve('store', 's1');
    expect(meta.title).toBe('Acme');
  });
});
