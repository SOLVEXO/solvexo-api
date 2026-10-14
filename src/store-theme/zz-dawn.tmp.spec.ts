import * as fs from 'fs';
import { readThemeZip, renderThemePreview, validateThemePackage } from './theme-package.service';

const img = { src: 'https://cdn.example.com/p.jpg', url: 'https://cdn.example.com/p.jpg', alt: 'p', width: 800, height: 800, aspect_ratio: 1 };
const variant = { id: 11, title: 'Default', price: 2500, compare_at_price: 3000, available: true, sku: 'S1', option1: 'Default', options: ['Default'], featured_image: img, inventory_quantity: 5, inventory_management: 'shopify', requires_shipping: true, taxable: true };
const product: any = { id: 1, title: 'Test Product', handle: 'test-product', url: '/products/test-product', description: '<p>Desc</p>', content: '<p>Desc</p>', price: 2500, price_min: 2500, price_max: 2500, compare_at_price: 3000, available: true, type: 'Shirt', vendor: 'Brand', tags: ['a'], images: [img], featured_image: img, variants: [variant], selected_or_first_available_variant: variant, first_available_variant: variant, options: ['Title'], options_with_values: [{ name: 'Title', position: 1, values: ['Default'] }], media: [], has_only_default_variant: true };
const collection: any = { id: 2, title: 'All', handle: 'all', url: '/collections/all', products: [product, { ...product, id: 3, handle: 'p3', url: '/products/p3' }], products_count: 2, all_products_count: 2, image: img, description: '', all_tags: [], sort_options: [], default_sort_by: 'manual', sort_by: 'manual', filters: [] };

describe('dawn real-theme smoke', () => {
  it('renders', async () => {
    const zip = fs.readFileSync(process.env.THEME_ZIP as string);
    const files = await readThemeZip(zip);
    validateThemePackage(files);
    console.log('FILES', files.length, 'templates', files.filter((f) => f.path.startsWith('templates/')).map((f) => f.path).join(','));
    const pages: Array<[string, string, Record<string, any>]> = [
      ['/', 'index', {}],
      ['/collections/all', 'collection', { collection, products: collection.products }],
      ['/products/test-product', 'product', { product, collection }],
      ['/cart', 'cart', {}],
      ['/search?q=a', 'search', { search: { performed: true, terms: 'a', results: collection.products, results_count: 2 } }],
      ['/pages/about', 'page', { page: { title: 'About', content: '<p>x</p>', handle: 'about', url: '/pages/about' } }],
      ['/blogs/news', 'blog', {}],
      ['/collections', 'list-collections', {}],
    ];
    const report: string[] = [];
    for (const [path, type, extra] of pages) {
      try {
        const html = await renderThemePreview(files as any, { request: { page_type: type, origin: '' }, shop: { name: 'S', currency: 'USD', money_format: '${{amount}}' }, linklists: {}, ...extra }, path);
        const bodyLen = html.length;
        const liquidErr = (html.match(/Liquid (syntax )?error[^<]{0,160}/gi) || []).slice(0, 3);
        report.push(`${path} OK len=${bodyLen} ${liquidErr.join(' | ')}`);
      } catch (e: any) { report.push(`${path} THROW ${String(e?.message).slice(0, 300)}`); }
    }
    console.log('REPORT\n' + report.join('\n'));
  });
});
