/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

/**
 * Strict, dependency-free validation + normalisation of the product fields the dashboard sends to
 * add-physical-product / add-digital-product / edit-product. The bodies are untyped (`any`), so this is where every
 * limit lives; the service only ever stores what comes out of here.
 */
export const PRODUCT_LIMITS = {
  nameMax: 255,
  descriptionMax: 50_000,
  imagesMax: 50,
  imageUrlMax: 2048,
  tagsMax: 100,
  tagMax: 60,
  skuMax: 64,
  barcodeMax: 64,
} as const;

const STATUSES = ['active', 'inactive', 'draft', 'scheduled'] as const;
export type ProductStatus = (typeof STATUSES)[number];

const isHttpUrl = (v: string) => /^https?:\/\/\S+$/i.test(v);

export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('Product name is required');
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) throw new BadRequestException('Product name is required');
  if (name.length > PRODUCT_LIMITS.nameMax) throw new BadRequestException(`Product name must be at most ${PRODUCT_LIMITS.nameMax} characters`);
  return name;
}

export function normalizeDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new BadRequestException('Description must be text');
  if (raw.length > PRODUCT_LIMITS.descriptionMax) throw new BadRequestException(`Description must be at most ${PRODUCT_LIMITS.descriptionMax} characters`);
  return raw;
}

export function normalizeImages(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('images must be a list of URLs');
  if (raw.length > PRODUCT_LIMITS.imagesMax) throw new BadRequestException(`A product can have at most ${PRODUCT_LIMITS.imagesMax} images`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequestException('Each image must be a URL');
    const url = item.trim();
    if (!url) continue;
    if (url.length > PRODUCT_LIMITS.imageUrlMax || !isHttpUrl(url)) throw new BadRequestException('Each image must be a valid http(s) URL');
    out.push(url);
  }
  return out;
}

/** Optional product video: '' (none) or any https link (an uploaded file, YouTube / Vimeo, a direct video file or a page). */
export function normalizeVideoUrl(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new BadRequestException('videoUrl must be a link');
  const url = raw.trim();
  if (!url) return '';
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new BadRequestException('Product video must be a valid link'); }
  if (parsed.protocol !== 'https:' || url.length > PRODUCT_LIMITS.imageUrlMax) throw new BadRequestException('Product video must be a valid https link');
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || /^[\d.]+$/.test(host) || host.includes(':')) {
    throw new BadRequestException('Product video must be a public https link');
  }
  if (host === 'res.cloudinary.com' && !/\/video\/upload\//.test(parsed.pathname)) {
    throw new BadRequestException('Upload a video file (not an image) as the product video');
  }
  return url;
}

export function normalizeTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('tags must be a list');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequestException('Each tag must be text');
    const tag = item.replace(/\s+/g, ' ').trim();
    if (!tag) continue;
    if (tag.length > PRODUCT_LIMITS.tagMax) throw new BadRequestException(`A tag must be at most ${PRODUCT_LIMITS.tagMax} characters`);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > PRODUCT_LIMITS.tagsMax) throw new BadRequestException(`A product can have at most ${PRODUCT_LIMITS.tagsMax} tags`);
  return out;
}

export function normalizeStatus(raw: unknown, fallback: ProductStatus = 'draft'): ProductStatus {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' || !(STATUSES as readonly string[]).includes(raw)) {
    throw new BadRequestException(`status must be one of: ${STATUSES.join(', ')}`);
  }
  return raw as ProductStatus;
}

/**
 * A scheduled product needs a real, future publish time. A past time would be activated by the next cron tick, which is
 * almost never what a seller meant — reject it (a minute of clock skew is tolerated). Returns null for any other status.
 */
export function resolveScheduledAt(status: ProductStatus, raw: unknown, now = new Date()): Date | null {
  if (status !== 'scheduled') return null;
  if (raw === undefined || raw === null || raw === '') throw new BadRequestException('scheduledAt is required when status is scheduled');
  const when = new Date(raw as any);
  if (Number.isNaN(when.getTime())) throw new BadRequestException('scheduledAt is not a valid date');
  if (when.getTime() < now.getTime() - 60_000) throw new BadRequestException('scheduledAt must be in the future');
  return when;
}

/** Trimmed SKU (null when blank). SKUs are matched exactly, so case is kept as typed. */
export function normalizeSku(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new BadRequestException('SKU must be text');
  const sku = raw.trim();
  if (!sku) return null;
  if (sku.length > PRODUCT_LIMITS.skuMax) throw new BadRequestException(`SKU must be at most ${PRODUCT_LIMITS.skuMax} characters`);
  if (/\s/.test(sku)) throw new BadRequestException('SKU cannot contain spaces');
  return sku;
}

export function normalizeBarcode(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') throw new BadRequestException('Barcode must be text');
  const barcode = String(raw).trim();
  if (!barcode) return null;
  if (barcode.length > PRODUCT_LIMITS.barcodeMax) throw new BadRequestException(`Barcode must be at most ${PRODUCT_LIMITS.barcodeMax} characters`);
  return barcode;
}

/** Non-negative finite number (price, compare-at, stock...). */
export function assertMoney(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new BadRequestException(`${label} must be a number that is 0 or more`);
  return Math.round(value * 100) / 100;
}

export function assertStockQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new BadRequestException('Stock quantity must be a whole number that is 0 or more');
  }
  return value;
}

/**
 * Picks SKUs for variants that did not get one: `SKU-<product tail>-<n>`, unique inside the product and never one that is
 * already taken. Deterministic (no clock), so two quick calls can't collide.
 */
export function generateSkus(productId: string, count: number, taken: Iterable<string>, startAt = 1): string[] {
  const used = new Set<string>(taken);
  const tail = productId.slice(-6).toUpperCase();
  const out: string[] = [];
  let n = startAt;
  while (out.length < count) {
    const candidate = `SKU-${tail}-${n}`;
    n += 1;
    if (used.has(candidate)) continue;
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

/** The first SKU that appears more than once in `skus` (case-sensitive), or null. */
export function findDuplicateSku(skus: (string | null | undefined)[]): string | null {
  const seen = new Set<string>();
  for (const sku of skus) {
    if (!sku) continue;
    if (seen.has(sku)) return sku;
    seen.add(sku);
  }
  return null;
}

/** "ABC-1" -> "ABC-1-COPY", "ABC-1-COPY" -> "ABC-1-COPY-2" ... first one not in `taken`. Used when a product is duplicated. */
export function copySku(sku: string, taken: Set<string>): string {
  let candidate = `${sku}-COPY`.slice(0, PRODUCT_LIMITS.skuMax);
  let n = 2;
  while (taken.has(candidate)) {
    const suffix = `-COPY-${n}`;
    candidate = `${sku.slice(0, PRODUCT_LIMITS.skuMax - suffix.length)}${suffix}`;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}
