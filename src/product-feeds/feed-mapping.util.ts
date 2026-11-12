/* eslint-disable prettier/prettier */
/** Pure mapping of products/variants to Google Merchant / Meta catalog feed items. No I/O. */

export type Availability = 'in stock' | 'out of stock' | 'preorder' | 'backorder';
export interface FeedItem {
  id: string; itemGroupId: string; title: string; description: string; link: string; imageLink: string; additionalImages: string[];
  availability: Availability; availabilityDate?: string; price: string; salePrice?: string; brand: string; gtin?: string; mpn?: string;
  condition: 'new'; identifierExists: boolean; color?: string; size?: string; productType?: string;
}
export interface FeedIssue { productId: string; variantId: string; name: string; sku: string; missing: string[] }

const stripHtml = (s: string) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const money = (n: number, cur: string) => `${(Math.round(n * 100) / 100).toFixed(2)} ${cur}`;
/** A GTIN is 8, 12, 13 or 14 digits (UPC/EAN); anything else is not sent. */
export const validGtin = (v: unknown): string | undefined => { const s = String(v ?? '').replace(/\s|-/g, ''); return /^\d{8}$|^\d{12,14}$/.test(s) ? s : undefined; };

/** In stock only when something is really sellable; backorder / pre-order only when the seller allowed it. Bundles follow their weakest component. */
export function availabilityOf(v: any, componentAvail?: number | null): { availability: Availability; date?: string } {
  const avail = v.unlimitedStock ? Infinity : Math.max(0, (v.stock ?? 0) - (v.committedStock ?? 0) - (v.damagedStock ?? 0) - (v.inTransitStock ?? 0) - (v.expiredStock ?? 0));
  const eff = componentAvail === undefined || componentAvail === null ? avail : Math.min(avail, componentAvail);
  if (eff > 0) return { availability: 'in stock' };
  const pre = v.preorder;
  if (pre?.enabled) return { availability: 'preorder', date: pre.expectedDate ? new Date(pre.expectedDate).toISOString() : undefined };
  if (v.allowBackorder) return { availability: 'backorder' };
  return { availability: 'out of stock' };
}

export function mapVariant(p: any, v: any, ctx: { baseUrl: string; currency: string; price: (n: number) => number; componentAvail?: number | null }): { item?: FeedItem; issue?: FeedIssue } {
  const missing: string[] = [];
  const title = String(p.name ?? '').replace(/[\s\u0000-\u001F]+/g, ' ').trim().slice(0, 150);
  const description = stripHtml(p.shortDescription || p.description).slice(0, 5000);
  const images: string[] = [...(v.images ?? []), ...(p.images ?? [])].filter((u) => /^https:\/\//i.test(String(u)));
  const price = ctx.price(Number(v.price));
  if (!title) missing.push('title');
  if (!description) missing.push('description');
  if (images.length === 0) missing.push('image');
  if (!(price > 0)) missing.push('price');
  if (!p.slug) missing.push('link');
  const gtin = validGtin(v.barcode);
  const brand = String(p.vendor ?? '').trim();
  if (!gtin && !brand) missing.push('brand or gtin');
  if (missing.length) return { issue: { productId: String(p._id), variantId: String(v._id), name: title || String(p.name ?? ''), sku: String(v.sku ?? ''), missing } };
  const opt = (name: string) => (v.options ?? []).find((o: any) => String(o.name).toLowerCase() === name)?.value;
  const a = availabilityOf(v, ctx.componentAvail);
  const compare = v.compareAtPrice && v.compareAtPrice > v.price ? ctx.price(Number(v.compareAtPrice)) : null;
  return {
    item: {
      id: String(v._id), itemGroupId: String(p._id), title, description, link: `${ctx.baseUrl}/product/${encodeURIComponent(p.slug)}?variant=${v._id}`,
      imageLink: images[0], additionalImages: images.slice(1, 11), availability: a.availability, availabilityDate: a.date,
      price: money(compare ?? price, ctx.currency), salePrice: compare ? money(price, ctx.currency) : undefined, brand, gtin, mpn: v.sku ? String(v.sku) : undefined,
      condition: 'new', identifierExists: !!(gtin || (brand && v.sku)), color: opt('color') ?? opt('colour'), size: opt('size'), productType: p.type || undefined,
    },
  };
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const x = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const tag = (n: string, v: unknown) => (v === undefined || v === null || v === '' ? '' : `<g:${n}>${x(v)}</g:${n}>`);

export function renderGoogleXml(store: { name: string; url: string }, items: FeedItem[]): string {
  const body = items.map((i) => `<item>${tag('id', i.id)}${tag('item_group_id', i.itemGroupId)}${tag('title', i.title)}${tag('description', i.description)}${tag('link', i.link)}${tag('image_link', i.imageLink)}${i.additionalImages.map((u) => tag('additional_image_link', u)).join('')}${tag('availability', i.availability)}${tag('availability_date', i.availabilityDate)}${tag('price', i.price)}${tag('sale_price', i.salePrice)}${tag('brand', i.brand)}${tag('gtin', i.gtin)}${tag('mpn', i.mpn)}${tag('condition', i.condition)}${i.identifierExists ? '' : tag('identifier_exists', 'no')}${tag('color', i.color)}${tag('size', i.size)}${tag('product_type', i.productType)}</item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${x(store.name)}</title><link>${x(store.url)}</link><description>${x(store.name)} product feed</description>${body}</channel></rss>`;
}

const csvCell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** Meta (Facebook/Instagram) catalog CSV column names. */
export function renderMetaCsv(items: FeedItem[]): string {
  const head = ['id', 'item_group_id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link', 'additional_image_link', 'brand', 'gtin', 'mpn', 'color', 'size'];
  const rows = items.map((i) => [i.id, i.itemGroupId, i.title, i.description, i.availability === 'preorder' ? 'preorder' : i.availability === 'backorder' ? 'available for order' : i.availability, i.condition, i.price, i.salePrice ?? '', i.link, i.imageLink, i.additionalImages.join(','), i.brand, i.gtin ?? '', i.mpn ?? '', i.color ?? '', i.size ?? '']);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
