/* eslint-disable prettier/prettier */
// Solvexo products only carry `images`/`featured_image`. Real Shopify themes (Dawn, Horizon, most 2.0 themes) read `featured_media`,
// `media`, image width/height and `product.image`. Add those Shopify fields to every product object the theme can reach.

const DEFAULT_SIZE = 1000;

function toImage(value: any, index: number, fallbackAlt: string) {
  const src = typeof value === 'string' ? value : value?.src ?? value?.url ?? '';
  if (!src) return null;
  const width = Number(value?.width) > 0 ? Number(value.width) : DEFAULT_SIZE;
  const height = Number(value?.height) > 0 ? Number(value.height) : DEFAULT_SIZE;
  return { ...(typeof value === 'object' && value ? value : {}), id: value?.id ?? index + 1, position: index + 1, src, url: src, alt: value?.alt ?? fallbackAlt, width, height, aspect_ratio: width / height };
}

/** A product video as a Shopify media entry: `external_video` for YouTube / Vimeo, `video` for an uploaded file. */
function videoMedia(rawUrl: unknown, poster: any, alt: string) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const base = { id: 'video', media_type: 'video', alt, preview_image: poster ?? null };
  const yt = host === 'youtu.be' ? u.pathname.split('/')[1] : host.endsWith('youtube.com') ? (u.searchParams.get('v') ?? u.pathname.split('/').pop()) : null;
  if (yt) return { ...base, media_type: 'external_video', host: 'youtube', external_id: yt };
  const vm = host.endsWith('vimeo.com') ? u.pathname.match(/(\d{5,})/)?.[1] : null;
  if (vm) return { ...base, media_type: 'external_video', host: 'vimeo', external_id: vm };
  if (host === 'res.cloudinary.com') return { ...base, sources: [{ url, mime_type: 'video/mp4', format: 'mp4', width: 1280, height: 720 }] };
  return null;
}

function enrichProduct(product: any) {
  if (product.__shopifyEnriched) return;
  const alt = String(product.title ?? product.name ?? '');
  const sources: any[] = Array.isArray(product.images) ? product.images : [];
  const images = sources.map((img, i) => toImage(img, i, alt)).filter(Boolean) as any[];
  const featured = toImage(product.featured_image, 0, alt) ?? images[0] ?? null;
  const media = images.map((img) => ({ id: img.id, position: img.position, media_type: 'image', alt: img.alt, src: img.src, width: img.width, height: img.height, aspect_ratio: img.aspect_ratio, preview_image: img }));
  const video = videoMedia(product.video_url, images[0] ?? null, alt);
  if (video) { if (product.video_first) media.unshift(video as any); else media.push(video as any); }
  Object.defineProperty(product, '__shopifyEnriched', { value: true, enumerable: false });
  product.images = images;
  product.featured_image = featured;
  product.image = product.image ?? featured;
  product.media = Array.isArray(product.media) && product.media.length ? product.media : media;
  product.featured_media = product.featured_media ?? (product.media[0] ?? null);
  if (Array.isArray(product.variants)) {
    for (const variant of product.variants) {
      if (!variant || typeof variant !== 'object') continue;
      variant.featured_image = toImage(variant.featured_image, 0, alt) ?? featured;
      variant.featured_media = variant.featured_media ?? (variant.featured_image ? { media_type: 'image', alt: variant.featured_image.alt, src: variant.featured_image.src, width: variant.featured_image.width, height: variant.featured_image.height, aspect_ratio: variant.featured_image.aspect_ratio, preview_image: variant.featured_image } : null);
    }
  }
}

/** Walks the Liquid context (bounded depth, cycle-safe) and enriches every object that looks like a product. */
export function enrichLiquidObjects(root: any, depth = 0, seen = new WeakSet<object>()) {
  if (!root || typeof root !== 'object' || depth > 6 || seen.has(root)) return;
  seen.add(root);
  if (Array.isArray(root)) { for (const item of root) enrichLiquidObjects(item, depth + 1, seen); return; }
  if (Array.isArray(root.variants) && (root.handle || root.url) && ('images' in root || 'featured_image' in root)) enrichProduct(root);
  for (const key of Object.keys(root)) {
    if (key.startsWith('__')) continue;
    const value = root[key];
    if (value && typeof value === 'object') enrichLiquidObjects(value, depth + 1, seen);
  }
}
