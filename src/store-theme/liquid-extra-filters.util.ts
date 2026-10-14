/* eslint-disable prettier/prettier */
// Shopify Liquid filters that real themes (Dawn, Horizon, premium themes) call and that liquidjs does not ship.
// Anything Solvexo cannot provide (Shopify-hosted payment buttons, 3D models, Shopify login) returns an empty string, never raw input.
import { createHash, createHmac } from 'crypto';

type FileLike = { path: string; encoding: string; content: string };
type Options = { files: Map<string, FileLike>; assetUrl: (name: string) => string };

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** liquidjs passes keyword arguments (`as: 'style'`) as [key, value] pairs. */
function kwargs(args: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const a of args) if (Array.isArray(a) && a.length === 2 && typeof a[0] === 'string') out[a[0]] = a[1];
  return out;
}
const positional = (args: any[]) => args.filter((a) => !(Array.isArray(a) && a.length === 2 && typeof a[0] === 'string'));

// ── colour helpers (hex / rgb / rgba) ──
type Rgba = { r: number; g: number; b: number; a: number };
function parseColor(input: unknown): Rgba | null {
  const s = String(input ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
const brightness = (c: Rgba) => (c.r * 299 + c.g * 587 + c.b * 114) / 1000;
function toHsl(c: Rgba) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, sat = 0;
  if (d) {
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(sat * 100), l: Math.round(l * 100) };
}
const rgbaString = (c: Rgba) => (c.a >= 1 ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a})`);

function productJsonLd(p: any): Record<string, any> {
  const variants: any[] = Array.isArray(p?.variants) ? p.variants : [];
  const image = p?.featured_image?.src ?? p?.featured_image ?? p?.images?.[0]?.src ?? p?.images?.[0];
  return {
    '@context': 'http://schema.org/', '@type': 'Product', name: p?.title, url: p?.url, description: String(p?.description ?? '').replace(/<[^>]*>/g, ''),
    ...(image ? { image } : {}), ...(p?.vendor ? { brand: { '@type': 'Brand', name: p.vendor } } : {}),
    offers: variants.map((v) => ({ '@type': 'Offer', sku: v.sku, price: (Number(v.price ?? 0) / 100).toFixed(2), availability: v.available ? 'http://schema.org/InStock' : 'http://schema.org/OutOfStock' })),
  };
}

export function registerExtraShopifyFilters(engine: any, { files, assetUrl }: Options) {
  const f = (name: string, fn: (this: any, ...args: any[]) => any) => engine.registerFilter(name, fn);

  // ── collection / cart ──
  f('item_count_for_variant', (cart: any, variantId: any) => (cart?.items ?? []).filter((i: any) => String(i.variant_id ?? i.id) === String(variantId)).reduce((n: number, i: any) => n + Number(i.quantity ?? 0), 0));
  f('line_items_for', (cart: any, object: any) => (cart?.items ?? []).filter((i: any) => String(i.product_id) === String(object?.id) || String(i.variant_id ?? i.id) === String(object?.id)));
  f('url_for_type', (type: any) => `/collections/types?q=${encodeURIComponent(String(type ?? ''))}`);
  f('url_for_vendor', (vendor: any) => `/collections/vendors?q=${encodeURIComponent(String(vendor ?? ''))}`);
  f('link_to_type', (type: any) => `<a href="/collections/types?q=${encodeURIComponent(String(type ?? ''))}" title="${esc(type)}">${esc(type)}</a>`);
  f('link_to_vendor', (vendor: any) => `<a href="/collections/vendors?q=${encodeURIComponent(String(vendor ?? ''))}" title="${esc(vendor)}">${esc(vendor)}</a>`);
  f('sort_by', (url: any, sort: any) => `${String(url ?? '')}${String(url ?? '').includes('?') ? '&' : '?'}sort_by=${encodeURIComponent(String(sort ?? ''))}`);
  f('within', (url: any, collection: any) => (collection?.url ? `${String(collection.url).replace(/\/$/, '')}${url}` : String(url ?? '')));
  f('highlight_active_tag', (tag: any) => String(tag ?? ''));
  f('link_to_tag', function (this: any, label: any, tag: any) { const base = String(this.context?.get?.(['collection', 'url']) ?? '/collections/all').replace(/\/$/, ''); return `<a href="${base}/${encodeURIComponent(String(tag ?? ''))}" title="Show products matching tag ${esc(tag)}">${esc(label)}</a>`; });
  f('link_to_add_tag', function (this: any, label: any, tag: any) { const base = String(this.context?.get?.(['collection', 'url']) ?? '/collections/all').replace(/\/$/, ''); return `<a href="${base}/${encodeURIComponent(String(tag ?? ''))}" title="Show products matching tag ${esc(tag)}">${esc(label)}</a>`; });
  f('link_to_remove_tag', function (this: any, label: any) { const base = String(this.context?.get?.(['collection', 'url']) ?? '/collections/all'); return `<a href="${base}" title="Remove tag">${esc(label)}</a>`; });

  // ── customer ──
  f('customer_login_link', (text: any) => `<a href="/login" id="customer_login_link">${esc(text)}</a>`);
  f('customer_logout_link', (text: any) => `<a href="/logout" id="customer_logout_link">${esc(text)}</a>`);
  f('customer_register_link', (text: any) => `<a href="/register" id="customer_register_link">${esc(text)}</a>`);
  f('avatar', () => '');
  f('login_button', () => '');

  // ── forms / seo ──
  f('default_errors', (errors: any) => { const list: any[] = Array.isArray(errors) ? errors : []; return list.length ? `<ul class="errors">${list.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''; });
  f('structured_data', (obj: any) => JSON.stringify(obj && typeof obj === 'object' && obj.variants ? productJsonLd(obj) : {}).replace(/</g, '\\u003c'));
  f('class_list', (value: any) => (Array.isArray(value) ? value.join(' ') : String(value ?? '')));

  // ── html tags ──
  f('preload_tag', (url: any, ...args: any[]) => {
    const o = kwargs(args); const as = String(o.as ?? positional(args)[0] ?? 'style');
    return url ? `<link rel="preload" href="${esc(url)}" as="${esc(as)}"${as === 'font' ? ' crossorigin' : ''}>` : '';
  });
  f('time_tag', function (this: any, value: any, format?: any) {
    const d = new Date(value === 'now' || value === 'today' ? Date.now() : value);
    if (Number.isNaN(d.getTime())) return '';
    const dateFilter = (engine as any).filters?.date;
    const text = typeof format === 'string' && typeof dateFilter === 'function' ? dateFilter.call(this, d, format) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    return `<time datetime="${d.toISOString()}">${esc(text)}</time>`;
  });
  f('external_video_url', (video: any) => (video?.host === 'vimeo' ? `https://player.vimeo.com/video/${video.external_id}` : `https://www.youtube.com/embed/${video?.external_id ?? ''}`));
  f('external_video_tag', (video: any) => (video?.external_id ? `<iframe src="${video.host === 'vimeo' ? `https://player.vimeo.com/video/${esc(video.external_id)}` : `https://www.youtube.com/embed/${esc(video.external_id)}`}" allowfullscreen loading="lazy" title="${esc(video.alt ?? 'Video')}"></iframe>` : ''));
  f('media_tag', (media: any) => {
    if (media?.media_type === 'image' || media?.preview_image) return `<img src="${esc(media?.src ?? media?.preview_image?.src ?? '')}" alt="${esc(media?.alt ?? '')}">`;
    if (media?.media_type === 'video') return `<video controls><source src="${esc(media?.sources?.[0]?.url ?? '')}"></video>`;
    return '';
  });
  f('model_viewer_tag', () => '');
  f('payment_button', () => '');
  f('payment_terms', () => '');
  f('payment_type_img_url', () => '');
  f('payment_type_svg_tag', (type: any, ...args: any[]) => { const o = kwargs(args); const label = esc(String(type ?? '').replace(/_/g, ' ')); return `<svg xmlns="http://www.w3.org/2000/svg" class="${esc(o.class ?? 'icon')}" viewBox="0 0 38 24" width="38" height="24" role="img" aria-labelledby="pi-${label}"><title id="pi-${label}">${label}</title><rect width="38" height="24" rx="3" fill="#fff" stroke="#d9d9d9"/><text x="19" y="15" font-size="6" text-anchor="middle" fill="#555" font-family="sans-serif">${label.slice(0, 10)}</text></svg>`; });
  f('currency_selector', () => '');
  f('format_address', (address: any) => (address && typeof address === 'object' ? `<p>${['name', 'address1', 'address2', 'city', 'province', 'zip', 'country'].map((k) => address[k]).filter(Boolean).map(esc).join('<br>')}</p>` : ''));
  f('metafield_text', (m: any) => String(m?.value ?? m ?? ''));
  f('metafield_tag', (m: any) => esc(m?.value ?? m ?? ''));
  f('inline_asset_content', (name: any) => {
    const asset = files.get(`assets/${String(name ?? '').replace(/^\/?assets\//i, '').replace(/^\//, '')}`);
    return asset && asset.encoding === 'utf8' ? asset.content : '';
  });

  // ── hosted / asset urls ──
  f('asset_img_url', (name: any) => assetUrl(String(name ?? '')));
  f('file_url', (file: any) => String(typeof file === 'string' ? file : file?.url ?? file?.src ?? ''));
  f('file_img_url', (file: any) => String(typeof file === 'string' ? file : file?.url ?? file?.src ?? ''));
  f('global_asset_url', () => '');
  f('shopify_asset_url', () => '');
  f('product_img_url', (img: any) => String(typeof img === 'string' ? img : img?.src ?? img?.url ?? ''));
  f('collection_img_url', (img: any) => String(typeof img === 'string' ? img : img?.src ?? img?.url ?? ''));
  f('article_img_url', (img: any) => String(typeof img === 'string' ? img : img?.src ?? img?.url ?? ''));

  // ── colour ──
  f('brightness_difference', (a: any, b: any) => { const x = parseColor(a), y = parseColor(b); return x && y ? Math.abs(Math.round(brightness(x) - brightness(y))) : 0; });
  f('color_extract', (color: any, part: any) => {
    const c = parseColor(color); if (!c) return 0;
    const hsl = toHsl(c);
    return ({ red: c.r, green: c.g, blue: c.b, alpha: c.a, hue: hsl.h, saturation: hsl.s, lightness: hsl.l } as Record<string, number>)[String(part)] ?? 0;
  });
  f('color_mix', (a: any, b: any, pct: any) => {
    const x = parseColor(a), y = parseColor(b); if (!x || !y) return String(a ?? '');
    const w = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
    return rgbaString({ r: x.r * w + y.r * (1 - w), g: x.g * w + y.g * (1 - w), b: x.b * w + y.b * (1 - w), a: x.a * w + y.a * (1 - w) });
  });
  f('hex_to_rgba', (hex: any, alpha: any) => { const c = parseColor(hex); return c ? rgbaString({ ...c, a: alpha === undefined ? c.a : Number(alpha) }) : String(hex ?? ''); });

  // ── hashing / strings ──
  f('md5', (v: any) => createHash('md5').update(String(v ?? '')).digest('hex'));
  f('sha1', (v: any) => createHash('sha1').update(String(v ?? '')).digest('hex'));
  f('hmac_sha1', (v: any, key: any) => createHmac('sha1', String(key ?? '')).update(String(v ?? '')).digest('hex'));
  f('base64_url_safe_encode', (v: any) => Buffer.from(String(v ?? '')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
  f('base64_url_safe_decode', (v: any) => Buffer.from(String(v ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  f('camelcase', (v: any) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_m, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase()));
}
