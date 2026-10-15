/* eslint-disable prettier/prettier */
// Import-time compatibility check for an uploaded Shopify (Liquid) theme.
// It renders the main storefront pages with sample data through the SAME engine the live store uses, so a "renders" result is a
// real result, and lists the Shopify features Solvexo does not provide so the seller knows before publishing.

type ThemeFile = { path: string; encoding: 'utf8' | 'base64'; content: string };
type Renderer = (files: any[], context: Record<string, any>, path: string) => Promise<string>;

const IMG = { src: 'https://cdn.example.com/sample.jpg', url: 'https://cdn.example.com/sample.jpg', alt: 'Sample', width: 800, height: 800, aspect_ratio: 1 };
const VARIANT = { id: 11, title: 'Default', price: 2500, compare_at_price: 3000, available: true, sku: 'SKU-1', option1: 'Default', options: ['Default'], featured_image: IMG, inventory_quantity: 5, inventory_management: 'shopify', requires_shipping: true, taxable: true };
const PRODUCT: any = {
  id: 1, title: 'Sample product', handle: 'sample-product', url: '/products/sample-product', description: '<p>Sample</p>', content: '<p>Sample</p>',
  price: 2500, price_min: 2500, price_max: 2500, compare_at_price: 3000, available: true, type: 'Sample', vendor: 'Sample', tags: ['sample'],
  images: [IMG], featured_image: IMG, variants: [VARIANT], selected_or_first_available_variant: VARIANT, first_available_variant: VARIANT,
  options: ['Title'], options_with_values: [{ name: 'Title', position: 1, values: ['Default'] }], media: [], has_only_default_variant: true,
};
const COLLECTION: any = {
  id: 2, title: 'All products', handle: 'all', url: '/collections/all', products: [PRODUCT, { ...PRODUCT, id: 3, handle: 'sample-2', url: '/products/sample-2' }],
  products_count: 2, all_products_count: 2, image: IMG, description: '', all_tags: [], sort_options: [], default_sort_by: 'manual', sort_by: 'manual', filters: [],
};

export const COMPAT_PAGES: Array<{ label: string; path: string; type: string; extra: Record<string, any> }> = [
  { label: 'Home page', path: '/', type: 'index', extra: {} },
  { label: 'Collection page', path: '/collections/all', type: 'collection', extra: { collection: COLLECTION, products: COLLECTION.products } },
  { label: 'Product page', path: '/products/sample-product', type: 'product', extra: { product: PRODUCT, collection: COLLECTION } },
  { label: 'Cart page', path: '/cart', type: 'cart', extra: {} },
  { label: 'Search page', path: '/search?q=sample', type: 'search', extra: { search: { performed: true, terms: 'sample', results: COLLECTION.products, results_count: 2 } } },
];

/** Turns a Liquid engine error into a sentence a store owner can act on. */
function friendlyError(error: unknown): string {
  const raw = String((error as any)?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ');
  const tag = /tag "([^"]+)" not found/.exec(raw)?.[1];
  if (tag) return `Uses the Liquid tag "${tag}", which Solvexo does not support yet.`;
  const missing = /Failed to lookup "([^"]+)"/.exec(raw)?.[1];
  if (missing) return `Refers to the file "${missing}", which is not in the theme.`;
  return raw.slice(0, 240);
}

/** Filters and tags the theme uses that the Solvexo engine does not know (they would print their input unchanged / fail). */
export function findUnsupportedLiquid(files: ThemeFile[], knownFilters: Set<string>, knownTags: Set<string>) {
  const filters = new Set<string>();
  const tags = new Set<string>();
  // Handled before the engine runs (text rewriting in preprocessShopifyTags / the layout renderer).
  const handledTags = new Set(['style', 'endstyle', 'stylesheet', 'endstylesheet', 'javascript', 'endjavascript', 'schema', 'endschema', 'form', 'endform', 'paginate', 'endpaginate', 'section', 'sections', 'doc', 'enddoc', 'else', 'elsif', 'when', 'endif', 'endfor', 'endcase', 'endunless', 'endcapture', 'endcomment', 'endraw', 'endtablerow', 'endliquid', 'ifchanged', 'endifchanged', 'content_for_header', 'content_for_layout']);
  for (const file of files) {
    if (file.encoding !== 'utf8' || !/\.liquid$/.test(file.path)) continue;
    const source = file.content
      .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '')
      .replace(/\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g, '')
      .replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, '')
      .replace(/\{%-?\s*doc\s*-?%\}[\s\S]*?\{%-?\s*enddoc\s*-?%\}/g, '');
    for (const m of source.matchAll(/\{%-?\s*([a-z_]+)/g)) if (!knownTags.has(m[1]) && !handledTags.has(m[1])) tags.add(m[1]);
    for (const m of source.matchAll(/\{\{-?([\s\S]*?)-?\}\}|\{%-?\s*(?:assign|echo|if|elsif|unless|case|when|for|capture|render|liquid)\b([\s\S]*?)-?%\}/g)) {
      const expr = (m[1] ?? m[2] ?? '').replace(/'[^']*'|"[^"]*"/g, '""');
      for (const f of expr.matchAll(/\|\s*([a-z_0-9]+)/g)) if (!knownFilters.has(f[1])) filters.add(f[1]);
    }
  }
  return { filters: [...filters].sort(), tags: [...tags].sort() };
}

export async function checkThemeCompatibility(files: ThemeFile[], render: Renderer) {
  const holder: { names?: { filters: Set<string>; tags: Set<string> } } = {};
  const inspect = (engine: any) => { holder.names = { filters: new Set(Object.keys(engine.filters ?? {})), tags: new Set(Object.keys(engine.tags ?? {})) }; };
  const pages: Array<{ label: string; path: string; ok: boolean; message?: string }> = [];
  for (const page of COMPAT_PAGES) {
    try {
      const html = await Promise.race([
        render(files as any[], { __inspectEngine: inspect, request: { page_type: page.type, origin: '' }, shop: { name: 'Store', currency: 'USD', money_format: '${{amount}}' }, linklists: {}, ...page.extra }, page.path),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Took longer than 20 seconds to render.')), 20_000)),
      ]);
      pages.push(String(html).trim().length > 0 ? { label: page.label, path: page.path, ok: true } : { label: page.label, path: page.path, ok: false, message: 'Rendered an empty page.' });
    } catch (error) {
      pages.push({ label: page.label, path: page.path, ok: false, message: friendlyError(error) });
    }
  }

  const notes: string[] = [];
  const text = files.filter((f) => f.encoding === 'utf8');
  if (text.some((f) => /^(sections|blocks)\//.test(f.path) && /"type"\s*:\s*"@app"/.test(f.content))) {
    notes.push('This theme has app blocks (@app). Third-party apps are not available on Solvexo, so those spots stay empty.');
  }
  if (files.some((f) => /^templates\/customers\//.test(f.path))) {
    notes.push('Customer account templates are ignored: Solvexo uses its own login, register and account pages.');
  }
  if (files.some((f) => f.path === 'templates/gift_card.liquid')) {
    notes.push('The gift card template in the theme is ignored: Solvexo has its own gift card pages.');
  }
  const layout = text.find((f) => f.path === 'layout/theme.liquid');
  if (layout && !/content_for_header/.test(layout.content)) {
    notes.push('layout/theme.liquid does not contain content_for_header; some theme features may not load.');
  }
  const engineNames = holder.names;
  if (engineNames) {
    const unsupported = findUnsupportedLiquid(files, engineNames.filters, engineNames.tags);
    if (unsupported.filters.length) notes.push('Uses Liquid filters Solvexo does not support yet (their output may be wrong): ' + unsupported.filters.slice(0, 15).join(', ') + '.');
    if (unsupported.tags.length) notes.push('Uses Liquid tags Solvexo does not support yet: ' + unsupported.tags.slice(0, 15).join(', ') + '.');
  }
  notes.push('Checkout, payments and customer accounts always use the Solvexo store checkout, not the theme.');

  return { checkedAt: new Date().toISOString(), pages, notes, ok: pages.every((p) => p.ok) };
}
