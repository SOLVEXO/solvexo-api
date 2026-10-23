/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import type { SectionType } from '../schemas/section.schema';
import { isAppBlockType } from './app-block.util';
import type {
  AllowedBlockTypesMap,
  FeaturedProductsSectionSettings,
  ProductCatalogSectionSettings,
  FeaturedCategoryGridSectionSettings,
  VideoSectionSettings,
  NewsletterSectionSettings,
  BlogPostsSectionSettings,
  HeroSectionSettings,
  RichTextSectionSettings,
  CollectionProductGridSectionSettings,
  FarmStorySectionSettings,
  DropCountdownSectionSettings,
  MetaobjectListSectionSettings,
} from './section-settings.types';

/**
 * Imperative per-type validation for seller-authored storefront content
 * (`Section.settings`/`Block.settings` on `StorePage`/`StoreTheme`, and later
 * `BlogPost.content` blocks). Mongoose keeps these fields loosely typed
 * (`Object`) so the shape can evolve without a migration; this is the one
 * place that actually enforces required keys, allow-lists, length caps, and —
 * the part that must never be skipped — link/image scheme sanitization.
 *
 * This matters more here than for admin-authored blobs (e.g.
 * `SeoLandingPage.content`) because these are seller-supplied and render on a
 * public page with zero platform chrome protecting it: an unvalidated `url`/
 * `imageUrl` field is a real XSS/open-redirect surface (`javascript:`,
 * `data:`, etc.), not just a data-quality concern.
 */

/** Shopify limits. Keep in sync with solvexo-web `features/seller/store/Dashboard/OnlineStore/builder/editorLimits.ts`. */
export const MAX_BLOCKS_PER_SECTION = 50;
export const MAX_SECTIONS_PER_PAGE = 25;

/** Throws a friendly error when a page / template holds more sections than allowed. A page that already had more (saved
 *  under the old, higher limit) can still be saved as long as it does not grow, so existing stores are never locked out. */
export function assertSectionCount(count: number, previousCount = 0) {
  if (count > MAX_SECTIONS_PER_PAGE && count > previousCount) {
    throw new BadRequestException(`A page can have up to ${MAX_SECTIONS_PER_PAGE} sections`);
  }
}

/** Where the important part of an image sits — used as CSS `object-position` when the image has to be cropped. */
export const FOCAL_POINTS = ['top left', 'top', 'top right', 'left', 'center', 'right', 'bottom left', 'bottom', 'bottom right'] as const;
/** `default` = the section's own built-in ratio; `adapt` = show the whole image, no cropping. */
export const IMAGE_RATIOS = ['default', 'adapt', 'portrait', 'square', 'landscape'] as const;

function required(value: unknown, field: string): void {
  if (value === undefined || value === null || value === '') {
    throw new BadRequestException(`${field} is required`);
  }
}

function maxLen(value: unknown, max: number, field: string): void {
  if (typeof value === 'string' && value.length > max) {
    throw new BadRequestException(`${field} must be ${max} characters or fewer`);
  }
}

const FOOTER_COLUMN_BLOCKS = new Set(['footer_brand', 'footer_column', 'footer_text', 'footer_contact', 'footer_newsletter', 'footer_image']);
const FOOTER_COLUMN_WIDTHS = ['auto', 'quarter', 'third', 'half', 'full'] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): void {
  if (value !== undefined && !allowed.includes(value as T)) {
    throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}`);
  }
}

/** Every image/external-link field on a seller storefront must be a real https:// URL from the real upload/authoring flow — this alone rules out `javascript:`/`data:`/relative-path injection. */
function assertHttpsUrl(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)) {
    throw new BadRequestException(`${field} must be a valid https:// URL`);
  }
}

// 'category'/'collection' let a nav link, footer link, or hero/image-with-text
// CTA point at the store's own category-browse or collection-detail page —
// see the Store Builder plan's Phase 4. Shape-only validation here (is a real
// id string present); the SERVICE layer (store-theme.service.ts,
// store-pages.service.ts) is responsible for confirming the referenced
// category/collection actually belongs to this store before saving — this
// validator has no DB access and never invents ownership guarantees it can't
// actually check.
export const LINK_TYPES = ['home', 'page', 'blog', 'search', 'external', 'category', 'collection', 'product', 'cart', 'account', 'faqs', 'email', 'phone'] as const;
/** Menu items only: a label that opens its dropdown on hover and goes nowhere on click. */
export const NAV_LINK_TYPES = [...LINK_TYPES, 'none'] as const;

/** Dynamic Sources — a `paragraph` block can bind to a real metafield
 *  (resolved at render time against whichever product a Product Template's
 *  sections are currently rendering for) instead of a static `text` value,
 *  via two flat scalar fields (`dynamicSourceNamespace`/`dynamicSourceKey`)
 *  rather than one nested object — matches the schema-driven settings
 *  editor's flat field model. See `PublicMetafieldsController`'s own doc
 *  comment — the read side has existed since the metafields system was
 *  built; this is the first real consumer. Only checks "both set or both
 *  absent" — whether they actually match a real `MetafieldDefinition` is a
 *  render-time concern (a stale/renamed reference just resolves to nothing,
 *  same "never throws, never a broken section" convention as
 *  `Section.colorSchemeId`). */
function assertDynamicSource(namespace: unknown, key: unknown, field: string): void {
  const hasNamespace = namespace !== undefined && namespace !== null && namespace !== '';
  const hasKey = key !== undefined && key !== null && key !== '';
  if (hasNamespace !== hasKey) {
    throw new BadRequestException(`${field}Namespace and ${field}Key must both be set together, or both left blank`);
  }
}

/**
 * Phase 9 — Dynamic Sources. Every place in the schema a section/block
 * settings object carries a `dynamicSourceNamespace`/`dynamicSourceKey`
 * pair (bare, unprefixed — safe since each of these 3 lives in its own
 * settings object with no sibling bindable field, see each site's own
 * comment): the `rich_text` SECTION's own `heading`, and the `heading`/
 * `paragraph` BLOCK's own `text`. Walked once here (not per-caller) so the
 * DB-aware existence/type-compatibility check (`MetafieldsService.
 * assertDynamicSourceBindingsValid`, called right after this file's pure
 * validation, same two-layer pattern Phase 8's `AppsService.
 * assertBlocksAllowed` established for app blocks) has one real list of
 * every binding a save actually contains, instead of re-deriving it.
 */
export function collectDynamicSourceBindings(sections: { type: string; settings?: Record<string, any>; blocks?: { type: string; settings?: Record<string, any> }[] }[]): { namespace: string; key: string }[] {
  const out: { namespace: string; key: string }[] = [];
  const push = (settings: Record<string, any> | undefined) => {
    if (settings?.dynamicSourceNamespace && settings?.dynamicSourceKey) {
      out.push({ namespace: settings.dynamicSourceNamespace, key: settings.dynamicSourceKey });
    }
  };
  for (const section of sections) {
    push(section.settings);
    for (const block of section.blocks ?? []) push(block.settings);
  }
  return out;
}

export function assertLinkTarget(link: unknown, field: string): void {
  if (link === undefined || link === null) return;
  if (typeof link !== 'object') throw new BadRequestException(`${field} is invalid`);
  const l = link as Record<string, unknown>;
  oneOf(l.linkType, LINK_TYPES, `${field}.linkType`);
  if (l.linkType === 'page') required(l.pageSlug, `${field}.pageSlug`);
  if (l.linkType === 'external') assertHttpsUrl(l.url, `${field}.url`);
  if (l.linkType === 'category') required(l.categoryId, `${field}.categoryId`);
  if (l.linkType === 'collection') required(l.collectionId, `${field}.collectionId`);
  if (l.linkType === 'product') required(l.productId, `${field}.productId`);
}

// ── Section-level settings ──────────────────────────────────────────────────

/** "Design & visibility" settings every section may carry (rendered by each
 *  theme's section wrapper): show-on, full width, background image + overlay,
 *  anchor id and section-scoped custom CSS. All optional. */
/** Seller overrides for a theme's own words (labels, button text). Blank = theme default. */
const COPY_OVERRIDE_LIMITS: Record<string, number> = {
  eyebrow: 60, viewAllLabel: 30, placeholder: 60, buttonLabel: 30, successMessage: 200, endedText: 60,
  nameLabel: 40, emailLabel: 40, phoneLabel: 40, messageLabel: 40, directionsLabel: 40,
};
function validateCopyOverrides(settings: Record<string, any>, prefix: string): void {
  if (settings.showEyebrow !== undefined && typeof settings.showEyebrow !== 'boolean') {
    throw new BadRequestException(`${prefix}.showEyebrow must be true or false`);
  }
  for (const [key, max] of Object.entries(COPY_OVERRIDE_LIMITS)) {
    const v = settings[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new BadRequestException(`${prefix}.${key} must be text`);
    maxLen(v, max, `${prefix}.${key}`);
  }
}

function validateCommonSectionDesign(settings: Record<string, any>): void {
  validateCopyOverrides(settings, 'settings');
  oneOf(settings.visibility, ['all', 'desktop', 'mobile', 'tablet', 'large', 'mobile-tablet'] as const, 'settings.visibility');
  if (settings.fullWidth !== undefined && typeof settings.fullWidth !== 'boolean') {
    throw new BadRequestException('settings.fullWidth must be true or false');
  }
  if (settings.backgroundImageUrl !== undefined && settings.backgroundImageUrl !== null && settings.backgroundImageUrl !== '') {
    assertHttpsUrl(settings.backgroundImageUrl, 'settings.backgroundImageUrl');
    maxLen(settings.backgroundImageUrl, 2000, 'settings.backgroundImageUrl');
  }
  const overlay = settings.backgroundOverlay;
  if (overlay !== undefined && overlay !== null && (typeof overlay !== 'number' || !Number.isFinite(overlay) || overlay < 0 || overlay > 80)) {
    throw new BadRequestException('settings.backgroundOverlay must be a number between 0 and 80');
  }
  if (settings.anchorId !== undefined && settings.anchorId !== null && settings.anchorId !== '') {
    if (typeof settings.anchorId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(settings.anchorId.trim())) {
      throw new BadRequestException('settings.anchorId may only use letters, numbers, - and _ (max 40)');
    }
  }
  if (settings.customCss !== undefined && settings.customCss !== null && settings.customCss !== '') {
    if (typeof settings.customCss !== 'string') throw new BadRequestException('settings.customCss must be text');
    maxLen(settings.customCss, 5000, 'settings.customCss');
    // Same rule as the theme-wide custom CSS: nothing that leaves the <style> tag or runs script.
    if (/</.test(settings.customCss) || /javascript\s*:/i.test(settings.customCss) || /expression\s*\(/i.test(settings.customCss)) {
      throw new BadRequestException('settings.customCss: script or HTML is not allowed');
    }
  }
}

/**
 * Generic rules for fields a THEME declares (the backend does not know the theme's schema): simple key names, at most 60
 * fields, text <= 5000 chars, finite numbers, booleans, null, short lists of text, and small plain objects (links,
 * image focal points) up to 2 levels, whole payload <= 20 KB. Themes must render text as text (React escapes).
 */
const THEME_FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const THEME_ITEM_KEY = /^[a-z][a-z0-9_.-]{0,59}$/;

function isThemeFieldValue(v: unknown, depth: number): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 5000;
  if (depth >= 2) return false;
  if (Array.isArray(v)) return v.length <= 50 && v.every(x => isThemeFieldValue(x, depth + 1));
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length <= 30 && entries.every(([k, x]) => THEME_FIELD_KEY.test(k) && isThemeFieldValue(x, depth + 1));
  }
  return false;
}

function validateThemeFields(settings: Record<string, any>, idKey: 'sectionKey' | 'blockKey', path: string): void {
  const id = settings[idKey];
  if (typeof id !== 'string' || !THEME_ITEM_KEY.test(id)) throw new BadRequestException(`${path}.${idKey} must be a short lowercase key`);
  const entries = Object.entries(settings).filter(([k]) => k !== idKey);
  if (entries.length > 60) throw new BadRequestException(`${path}: too many fields`);
  for (const [k, v] of entries) {
    if (!THEME_FIELD_KEY.test(k) && !k.startsWith('copy')) throw new BadRequestException(`${path}.${k}: invalid field name`);
    if (!isThemeFieldValue(v, 0)) throw new BadRequestException(`${path}.${k}: unsupported or too large value`);
  }
  if (JSON.stringify(settings).length > 20000) throw new BadRequestException(`${path}: too much content`);
}

export function validateSectionSettings(type: SectionType, settings: Record<string, any>): void {
  maxLen(settings.heading, 120, 'settings.heading');
  for (const key of ['spacingTop', 'spacingBottom', 'paddingTop', 'paddingBottom'] as const) {
    const value = settings[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 160)) {
      throw new BadRequestException(`settings.${key} must be a number between 0 and 160`);
    }
  }
  validateCommonSectionDesign(settings);

  switch (type) {
    case 'hero': {
      const s = settings as HeroSectionSettings;
      oneOf(s.heightPreset, ['small', 'medium', 'large', 'adapt'] as const, 'settings.heightPreset');
      oneOf(s.mobileHeightPreset, ['same', 'small', 'medium', 'large', 'adapt'] as const, 'settings.mobileHeightPreset');
      oneOf(s.mobileTextLayout, ['overlay', 'below'] as const, 'settings.mobileTextLayout');
      oneOf(s.pagination, ['dots', 'counter', 'none'] as const, 'settings.pagination');
      oneOf(s.transition, ['slide', 'fade'] as const, 'settings.transition');
      for (const key of ['autoplay', 'showArrows', 'showPauseButton'] as const) {
        if (s[key] !== undefined && typeof s[key] !== 'boolean') {
          throw new BadRequestException(`settings.${key} must be true or false`);
        }
      }
      if (s.autoplaySeconds !== undefined
        && (typeof s.autoplaySeconds !== 'number' || !Number.isFinite(s.autoplaySeconds) || s.autoplaySeconds < 3 || s.autoplaySeconds > 10)) {
        throw new BadRequestException('settings.autoplaySeconds must be a number between 3 and 10');
      }
      break;
    }
    case 'rich_text': {
      const s = settings as RichTextSectionSettings;
      oneOf(s.alignment, ['left', 'center', 'right'] as const, 'settings.alignment');
      // Dynamic Sources — the section's own heading can bind to a real
      // metafield too (a section SETTING, not a block one), same
      // presence-pairing check `paragraph`'s block-level binding already
      // uses. `settings.heading` itself stays optional either way (a
      // rich_text section's heading was always optional).
      assertDynamicSource(s.dynamicSourceNamespace, s.dynamicSourceKey, 'dynamicSource');
      break;
    }
    case 'featured_products': {
      const s = settings as FeaturedProductsSectionSettings;
      required(s.source, 'settings.source');
      oneOf(s.source, ['manual', 'category', 'collection', 'bestsellers', 'newArrivals', 'trending', 'pinned', 'onSale'] as const, 'settings.source');
      if (s.source === 'category') required(s.categoryId, 'settings.categoryId');
      if (s.source === 'collection') required(s.collectionId, 'settings.collectionId');
      // Hand-picked (or the older pin list): an empty pick is allowed while the
      // seller is still choosing (falls back to the store pins, else nothing).
      if (s.productIds !== undefined && s.productIds !== null) {
        if (!Array.isArray(s.productIds) || s.productIds.some((id: unknown) => typeof id !== 'string')) {
          throw new BadRequestException('settings.productIds must be a list of product ids');
        }
        if (s.productIds.length > 24) throw new BadRequestException('settings.productIds cannot exceed 24 products');
      }
      if (s.limit !== undefined && (typeof s.limit !== 'number' || s.limit < 1 || s.limit > 24)) {
        throw new BadRequestException('settings.limit must be between 1 and 24');
      }
      if (s.columns !== undefined && ![2, 3, 4].includes(s.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3, or 4');
      }
      break;
    }
    case 'product_catalog': {
      const s = settings as ProductCatalogSectionSettings;
      oneOf(s.defaultSort, ['newest', 'price_asc', 'price_desc', 'best_rated', 'best_selling'] as const, 'settings.defaultSort');
      if (s.columns !== undefined && ![2, 3, 4].includes(s.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3, or 4');
      }
      if (s.showFilters !== undefined && typeof s.showFilters !== 'boolean') {
        throw new BadRequestException('settings.showFilters must be a boolean');
      }
      // Optional merchandising filter — at most one of the two (a catalog
      // scoped to both a category AND a collection at once isn't a
      // meaningful combination in this builder, and would silently mean
      // "intersection" to the reader when nothing computes that).
      if (s.categoryId !== undefined && typeof s.categoryId !== 'string') {
        throw new BadRequestException('settings.categoryId must be a string');
      }
      if (s.collectionId !== undefined && typeof s.collectionId !== 'string') {
        throw new BadRequestException('settings.collectionId must be a string');
      }
      if (s.categoryId && s.collectionId) {
        throw new BadRequestException('settings.categoryId and settings.collectionId cannot both be set');
      }
      break;
    }
    case 'featured_category_grid': {
      const s = settings as FeaturedCategoryGridSectionSettings;
      // Empty is allowed (a freshly added section, Shopify-style); it renders nothing until filled.
      if (s.categoryIds !== undefined && !Array.isArray(s.categoryIds)) {
        throw new BadRequestException('settings.categoryIds must be a list');
      }
      if (!Array.isArray(s.categoryIds)) s.categoryIds = [];
      if (s.categoryIds.length > 12) throw new BadRequestException('settings.categoryIds cannot exceed 12 categories');
      if (s.columns !== undefined && ![2, 3, 4].includes(s.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3, or 4');
      }
      oneOf(s.imageRatio, IMAGE_RATIOS, 'settings.imageRatio');
      break;
    }
    case 'trust_badges':
      break; // content lives entirely in trust_badge_item blocks
    case 'blog_posts': {
      const s = settings as BlogPostsSectionSettings;
      if (s.limit !== undefined && (typeof s.limit !== 'number' || s.limit < 1 || s.limit > 12)) {
        throw new BadRequestException('settings.limit must be between 1 and 12');
      }
      oneOf(s.imageRatio, IMAGE_RATIOS, 'settings.imageRatio');
      break;
    }
    case 'newsletter': {
      const s = settings as NewsletterSectionSettings;
      maxLen(s.subtext, 200, 'settings.subtext');
      break;
    }
    case 'metaobject_list': {
      const s = settings as MetaobjectListSectionSettings;
      required(s.metaobjectType, 'settings.metaobjectType');
      break;
    }
    case 'video': {
      const s = settings as VideoSectionSettings;
      // Either an uploaded file (our own Cloudinary-hosted https URL) or a YouTube/Vimeo link.
      if (s.videoFileUrl) {
        if (typeof s.videoFileUrl !== 'string' || !/^https:\/\/res\.cloudinary\.com\//i.test(s.videoFileUrl)) {
          throw new BadRequestException('settings.videoFileUrl must be an uploaded video file');
        }
      } else if (s.videoUrl) {
        // Empty is allowed (a freshly added section); it renders nothing until a video is set.
        // Any https link: YouTube/Vimeo play as an embed, anything else as a direct video file.
        if (typeof s.videoUrl !== 'string' || !/^https:\/\/[^\s]+$/i.test(s.videoUrl)) {
          throw new BadRequestException('settings.videoUrl must be a valid https:// video link, or upload a video file');
        }
      }
      oneOf(s.aspectRatio, ['16:9', '4:3', '1:1'] as const, 'settings.aspectRatio');
      break;
    }
    case 'image_with_text':
    case 'testimonials':
    case 'faq':
      // Questions from the section's blocks, or the store's own FAQ list.
      oneOf(settings.source, ['blocks', 'store'] as const, 'settings.source');
      break;
    case 'feature_list':
    case 'team_grid':
    case 'stats_counter':
    case 'store_locations':
      break; // content lives entirely in blocks, no section-level settings beyond heading
    case 'gallery_grid': {
      if (settings.columns !== undefined && ![2, 3, 4, 5].includes(settings.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3, 4 or 5');
      }
      oneOf(settings.imageRatio, IMAGE_RATIOS, 'settings.imageRatio');
      break;
    }
    case 'related_products': {
      oneOf(settings.source, ['related', 'complementary', 'category', 'collection', 'manual'] as const, 'settings.source');
      if (settings.productIds !== undefined) {
        if (!Array.isArray(settings.productIds) || settings.productIds.length > 24 || settings.productIds.some((x: unknown) => typeof x !== 'string')) {
          throw new BadRequestException('settings.productIds must be a list of up to 24 product ids');
        }
      }
      if (settings.source === 'category') required(settings.categoryId, 'settings.categoryId');
      if (settings.source === 'collection') required(settings.collectionId, 'settings.collectionId');
      if (settings.columns !== undefined && ![2, 3, 4].includes(settings.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3 or 4');
      }
      const limit = settings.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 2 || limit > 12)) {
        throw new BadRequestException('settings.limit must be a whole number from 2 to 12');
      }
      break;
    }
    case 'contact_form': {
      maxLen(settings.intro, 300, 'settings.intro');
      maxLen(settings.buttonLabel, 30, 'settings.buttonLabel');
      maxLen(settings.successMessage, 200, 'settings.successMessage');
      if (settings.showPhone !== undefined && typeof settings.showPhone !== 'boolean') {
        throw new BadRequestException('settings.showPhone must be true or false');
      }
      break;
    }
    case 'divider':
      oneOf(settings.style, ['line', 'space'] as const, 'settings.style');
      if (settings.height !== undefined && (typeof settings.height !== 'number' || settings.height < 0 || settings.height > 160)) {
        throw new BadRequestException('settings.height must be a number between 0 and 160');
      }
      break;
    case 'multirow':
      oneOf(settings.imageRatio, IMAGE_RATIOS, 'settings.imageRatio');
      if (settings.alternate !== undefined && typeof settings.alternate !== 'boolean') throw new BadRequestException('settings.alternate must be true or false');
      break;
    case 'collage':
      oneOf(settings.layout, ['left', 'right'] as const, 'settings.layout');
      break;
    case 'featured_product':
      if (settings.productIds !== undefined && settings.productIds !== null
        && (!Array.isArray(settings.productIds) || settings.productIds.length > 1 || settings.productIds.some((id: unknown) => typeof id !== 'string'))) {
        throw new BadRequestException('settings.productIds must hold at most one product id');
      }
      maxLen(settings.buttonLabel, 30, 'settings.buttonLabel');
      break;
    case 'collection_banner':
      if (settings.collectionId !== undefined && settings.collectionId !== null && typeof settings.collectionId !== 'string') {
        throw new BadRequestException('settings.collectionId must be text');
      }
      for (const k of ['showImage', 'showDescription'] as const) {
        if (settings[k] !== undefined && typeof settings[k] !== 'boolean') throw new BadRequestException(`settings.${k} must be true or false`);
      }
      break;
    case 'recently_viewed':
      if (settings.limit !== undefined && (!Number.isInteger(settings.limit) || settings.limit < 2 || settings.limit > 12)) {
        throw new BadRequestException('settings.limit must be a whole number from 2 to 12');
      }
      if (settings.columns !== undefined && ![2, 3, 4].includes(settings.columns)) throw new BadRequestException('settings.columns must be 2, 3 or 4');
      break;
    case 'collection_list': {
      if (settings.columns !== undefined && ![2, 3, 4].includes(settings.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3 or 4');
      }
      const limit = settings.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 24)) {
        throw new BadRequestException('settings.limit must be a whole number from 1 to 24');
      }
      oneOf(settings.imageRatio, IMAGE_RATIOS, 'settings.imageRatio');
      if (settings.showDescription !== undefined && typeof settings.showDescription !== 'boolean') {
        throw new BadRequestException('settings.showDescription must be true or false');
      }
      break;
    }
    case 'multicolumn': {
      if (settings.columns !== undefined && ![1, 2, 3, 4].includes(settings.columns)) {
        throw new BadRequestException('settings.columns must be 1, 2, 3, or 4');
      }
      oneOf(settings.textAlign, ['left', 'center'] as const, 'settings.textAlign');
      oneOf(settings.imageRatio, IMAGE_RATIOS, 'settings.imageRatio');
      break;
    }
    case 'logo_list': {
      const h = settings.logoHeight;
      if (h !== undefined && (typeof h !== 'number' || !Number.isFinite(h) || h < 24 || h > 120)) {
        throw new BadRequestException('settings.logoHeight must be a number between 24 and 120');
      }
      if (settings.grayscale !== undefined && typeof settings.grayscale !== 'boolean') {
        throw new BadRequestException('settings.grayscale must be true or false');
      }
      break;
    }
    case 'marquee': {
      oneOf(settings.speed, ['slow', 'medium', 'fast'] as const, 'settings.speed');
      oneOf(settings.direction, ['left', 'right'] as const, 'settings.direction');
      if (settings.pauseOnHover !== undefined && typeof settings.pauseOnHover !== 'boolean') {
        throw new BadRequestException('settings.pauseOnHover must be true or false');
      }
      break;
    }
    case 'custom_html': {
      if (settings.html !== undefined && typeof settings.html !== 'string') {
        throw new BadRequestException('settings.html must be text');
      }
      maxLen(settings.html, 20000, 'settings.html');
      // Defence in depth — the storefront sanitizes again at render time.
      if (typeof settings.html === 'string' && /<\s*(script|iframe|object|embed|link|meta|base|form)\b|\son[a-z]+\s*=|javascript\s*:/i.test(settings.html)) {
        throw new BadRequestException('Custom HTML cannot contain scripts, iframes, forms, event handlers or javascript: links');
      }
      break;
    }
    case 'image_banner': {
      if (settings.imageUrl) assertHttpsUrl(settings.imageUrl, 'settings.imageUrl');
      oneOf(settings.focalPoint, FOCAL_POINTS, 'settings.focalPoint');
      maxLen(settings.subheading, 200, 'settings.subheading');
      maxLen(settings.ctaText, 40, 'settings.ctaText');
      assertLinkTarget(settings.ctaLink, 'settings.ctaLink');
      oneOf(settings.heightPreset, ['small', 'medium', 'large', 'adapt'] as const, 'settings.heightPreset');
      oneOf(settings.contentAlign, ['left', 'center', 'right'] as const, 'settings.contentAlign');
      oneOf(settings.contentPosition, ['top', 'middle', 'bottom'] as const, 'settings.contentPosition');
      const o = settings.overlayOpacity;
      if (o !== undefined && (typeof o !== 'number' || !Number.isFinite(o) || o < 0 || o > 80)) {
        throw new BadRequestException('settings.overlayOpacity must be a number between 0 and 80');
      }
      if (settings.textColor !== undefined && settings.textColor !== '' && !/^#[0-9a-f]{3,8}$/i.test(settings.textColor)) {
        throw new BadRequestException('settings.textColor must be a hex colour');
      }
      break;
    }
    case 'collection_product_grid': {
      const s = settings as CollectionProductGridSectionSettings;
      oneOf(s.defaultSort, ['newest', 'price_asc', 'price_desc', 'best_rated', 'best_selling'] as const, 'settings.defaultSort');
      if (s.columns !== undefined && ![2, 3, 4].includes(s.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3, or 4');
      }
      if (s.showFilters !== undefined && typeof s.showFilters !== 'boolean') {
        throw new BadRequestException('settings.showFilters must be a boolean');
      }
      break;
    }
    case 'editorial_lookbook':
    case 'craft_process':
    case 'tech_specs_compare':
    case 'soft_gallery':
      break; // content lives entirely in blocks, no section-level settings beyond heading
    case 'farm_story': {
      const s = settings as FarmStorySectionSettings;
      maxLen(s.subheading, 200, 'settings.subheading');
      if (s.imageUrl !== undefined) assertHttpsUrl(s.imageUrl, 'settings.imageUrl');
      break;
    }
    case 'drop_countdown': {
      const s = settings as DropCountdownSectionSettings;
      maxLen(s.subheading, 200, 'settings.subheading');
      maxLen(s.ctaText, 40, 'settings.ctaText');
      assertLinkTarget(s.ctaLink, 'settings.ctaLink');
      break;
    }
    case 'theme_section':
      validateThemeFields(settings, 'sectionKey', 'settings');
      break;
    case 'product_main':
    case 'search_results':
    case 'cart_items':
    case 'cart_summary':
    case 'blog_post_list':
    case 'article_content':
    case 'page_content':
      break; // core/locked sections — no section-level settings, see SECTION_TYPES's comment
    default: {
      // Exhaustiveness guard: if a new SectionType is ever added to
      // SECTION_TYPES without a case above, `type` here is no longer `never`
      // and this line fails to compile — the old hand-maintained switch had
      // no such safety net, so a new type could silently skip validation.
      const _exhaustive: never = type;
      throw new BadRequestException(`Unhandled section type: ${_exhaustive as string}`);
    }
  }
}

// ── Block-level settings (context = the block's `type` string) ─────────────

export function validateBlockSettings(blockType: string, settings: Record<string, any>): void {
  validateCopyOverrides(settings, 'settings');
  if (FOOTER_COLUMN_BLOCKS.has(blockType) && settings.width !== null) oneOf(settings.width, FOOTER_COLUMN_WIDTHS, 'width');
  switch (blockType) {
    // Header/footer blocks (StoreTheme)
    case 'nav_link':
      required(settings.label, 'label');
      maxLen(settings.label, 40, 'label');
      required(settings.linkType, 'linkType');
      oneOf(settings.linkType, NAV_LINK_TYPES, 'linkType');
      if (settings.linkType === 'page') required(settings.pageSlug, 'pageSlug');
      if (settings.linkType === 'external') assertHttpsUrl(settings.url, 'url');
      if (settings.linkType === 'category') required(settings.categoryId, 'categoryId');
      if (settings.linkType === 'collection') required(settings.collectionId, 'collectionId');
      if (settings.linkType === 'product') required(settings.productId, 'productId');
      assertLinkContact(settings, '');
      if (settings.highlight !== undefined && typeof settings.highlight !== 'boolean') {
        throw new BadRequestException('highlight must be a boolean');
      }
      oneOf(settings.menuStyle, NAV_MENU_STYLES, 'menuStyle');
      assertOptionalImageUrl(settings.imageUrl, 'imageUrl');
      validateNavChildren(settings, 1);
      break;
    case 'footer_column':
      required(settings.heading, 'heading');
      maxLen(settings.heading, 60, 'heading');
      if (!Array.isArray(settings.links)) throw new BadRequestException('links must be an array');
      if (settings.links.length > 10) throw new BadRequestException('links cannot exceed 10 per column');
      for (const link of settings.links) validateBlockSettings('nav_link', link);
      break;
    case 'social_link':
      required(settings.platform, 'platform');
      oneOf(settings.platform, ['facebook', 'instagram', 'x', 'tiktok', 'youtube', 'linkedin', 'whatsapp'] as const, 'platform');
      assertHttpsUrl(settings.url, 'url');
      break;
    case 'copyright_text':
      required(settings.text, 'text');
      maxLen(settings.text, 200, 'text');
      break;
    case 'footer_text':
      required(settings.text, 'text');
      maxLen(settings.heading, 60, 'heading');
      maxLen(settings.text, 600, 'text');
      break;
    case 'footer_brand':
      maxLen(settings.text, 600, 'text');
      for (const k of ['showTagline', 'showSocial']) {
        if (settings[k] !== undefined && typeof settings[k] !== 'boolean') throw new BadRequestException(`${k} must be true or false`);
      }
      break;
    case 'footer_newsletter':
      maxLen(settings.heading, 60, 'heading');
      maxLen(settings.text, 160, 'text');
      break;
    case 'footer_image':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.heading, 60, 'heading');
      maxLen(settings.alt, 120, 'alt');
      assertLinkTarget(settings.link, 'link');
      // `width` is the column width (a preset string); the image's own pixel width is `imageWidth`.
      if (settings.imageWidth !== undefined && settings.imageWidth !== null
        && (typeof settings.imageWidth !== 'number' || settings.imageWidth < 40 || settings.imageWidth > 400)) {
        throw new BadRequestException('imageWidth must be a number from 40 to 400');
      }
      break;
    case 'footer_contact': {
      maxLen(settings.email, 120, 'email');
      maxLen(settings.phone, 40, 'phone');
      maxLen(settings.address, 240, 'address');
      maxLen(settings.hours, 160, 'hours');
      for (const k of ['email', 'phone', 'address', 'hours']) {
        if (settings[k] !== undefined && settings[k] !== null && typeof settings[k] !== 'string') throw new BadRequestException(`${k} must be text`);
      }
      if (!['email', 'phone', 'address', 'hours'].some(k => typeof settings[k] === 'string' && settings[k].trim())) {
        throw new BadRequestException('Add at least one contact detail');
      }
      if (settings.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.email)) throw new BadRequestException('email is not a valid address');
      break;
    }
    case 'footer_payment_icons':
      if (!Array.isArray(settings.icons)) throw new BadRequestException('icons must be an array');
      if (settings.icons.length > 12) throw new BadRequestException('icons cannot exceed 12');
      for (const icon of settings.icons) oneOf(icon, PAYMENT_ICONS, 'icons[]');
      break;

    // hero section blocks
    case 'hero_slide':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.heading, 100, 'heading');
      maxLen(settings.subheading, 200, 'subheading');
      maxLen(settings.ctaText, 40, 'ctaText');
      assertLinkTarget(settings.ctaLink, 'ctaLink');
      oneOf(settings.focalPoint, FOCAL_POINTS, 'focalPoint');
      oneOf(settings.contentAlign, ['left', 'center', 'right'] as const, 'contentAlign');
      if (settings.overlayOpacity !== undefined && settings.overlayOpacity !== null
        && (typeof settings.overlayOpacity !== 'number' || !Number.isFinite(settings.overlayOpacity) || settings.overlayOpacity < 0 || settings.overlayOpacity > 80)) {
        throw new BadRequestException('overlayOpacity must be a number between 0 and 80');
      }
      if (settings.textColor !== undefined && settings.textColor !== null && settings.textColor !== ''
        && (typeof settings.textColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(settings.textColor))) {
        throw new BadRequestException('textColor must be a #RRGGBB colour');
      }
      break;

    // rich_text / blog content blocks
    case 'paragraph': {
      // Dynamic Sources: a paragraph bound to a metafield doesn't need its
      // own static text — the real value is resolved at render time instead.
      const boundToMetafield = !!settings.dynamicSourceNamespace && !!settings.dynamicSourceKey;
      if (!boundToMetafield) required(settings.text, 'text');
      maxLen(settings.text, 2000, 'text');
      assertDynamicSource(settings.dynamicSourceNamespace, settings.dynamicSourceKey, 'dynamicSource');
      break;
    }
    case 'heading': {
      // Dynamic Sources — same optional-when-bound convention as `paragraph`.
      const boundToMetafield = !!settings.dynamicSourceNamespace && !!settings.dynamicSourceKey;
      if (!boundToMetafield) required(settings.text, 'text');
      maxLen(settings.text, 150, 'text');
      oneOf(settings.level, ['h2', 'h3', 'h4'] as const, 'level');
      assertDynamicSource(settings.dynamicSourceNamespace, settings.dynamicSourceKey, 'dynamicSource');
      break;
    }
    case 'image':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.caption, 200, 'caption');
      maxLen(settings.alt, 150, 'alt');
      break;
    case 'quote':
      required(settings.text, 'text');
      maxLen(settings.text, 500, 'text');
      maxLen(settings.author, 100, 'author');
      break;
    case 'list':
      if (!Array.isArray(settings.items) || settings.items.length === 0 || settings.items.length > 20) {
        throw new BadRequestException('items must be an array of 1-20 strings');
      }
      for (const item of settings.items) maxLen(item, 200, 'items[]');
      oneOf(settings.style, ['bullet', 'numbered'] as const, 'style');
      break;
    case 'divider':
      break;

    // image_with_text section blocks
    case 'image_text_pair':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.heading, 120, 'heading');
      maxLen(settings.body, 1000, 'body');
      maxLen(settings.ctaText, 40, 'ctaText');
      assertLinkTarget(settings.ctaLink, 'ctaLink');
      oneOf(settings.imagePosition, ['left', 'right'] as const, 'imagePosition');
      oneOf(settings.imageRatio, IMAGE_RATIOS, 'imageRatio');
      oneOf(settings.focalPoint, FOCAL_POINTS, 'focalPoint');
      break;

    // testimonials section blocks
    case 'testimonial':
      required(settings.quote, 'quote');
      maxLen(settings.quote, 500, 'quote');
      required(settings.authorName, 'authorName');
      maxLen(settings.authorName, 100, 'authorName');
      maxLen(settings.authorRole, 100, 'authorRole');
      if (settings.avatarUrl !== undefined) assertHttpsUrl(settings.avatarUrl, 'avatarUrl');
      if (settings.rating !== undefined && (typeof settings.rating !== 'number' || settings.rating < 1 || settings.rating > 5)) {
        throw new BadRequestException('rating must be between 1 and 5');
      }
      break;

    // faq section blocks
    case 'faq_item':
      required(settings.question, 'question');
      maxLen(settings.question, 200, 'question');
      required(settings.answer, 'answer');
      maxLen(settings.answer, 2000, 'answer');
      break;

    // trust_badges section blocks
    case 'trust_badge_item':
      required(settings.icon, 'icon');
      oneOf(settings.icon, ['truck', 'shield', 'refresh', 'headset', 'lock'] as const, 'icon');
      required(settings.text, 'text');
      maxLen(settings.text, 80, 'text');
      break;

    // editorial_lookbook / soft_gallery section blocks
    case 'lookbook_item':
    case 'gallery_item':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.caption, 150, 'caption');
      break;

    // farm_story section blocks
    case 'farm_story_step':
      required(settings.icon, 'icon');
      oneOf(settings.icon, ['sprout', 'leaf', 'truck', 'heart', 'sun'] as const, 'icon');
      required(settings.title, 'title');
      maxLen(settings.title, 60, 'title');
      required(settings.body, 'body');
      maxLen(settings.body, 300, 'body');
      break;

    // craft_process section blocks
    case 'craft_process_step':
      required(settings.title, 'title');
      maxLen(settings.title, 60, 'title');
      required(settings.body, 'body');
      maxLen(settings.body, 300, 'body');
      break;

    // tech_specs_compare section blocks
    case 'spec_row':
      required(settings.label, 'label');
      maxLen(settings.label, 60, 'label');
      required(settings.value, 'value');
      maxLen(settings.value, 120, 'value');
      break;

    // feature_list section blocks
    case 'feature_item':
      required(settings.icon, 'icon');
      maxLen(settings.icon, 40, 'icon');
      required(settings.title, 'title');
      maxLen(settings.title, 80, 'title');
      required(settings.description, 'description');
      maxLen(settings.description, 300, 'description');
      break;

    // team_grid section blocks
    case 'team_member':
      required(settings.name, 'name');
      maxLen(settings.name, 80, 'name');
      required(settings.role, 'role');
      maxLen(settings.role, 80, 'role');
      maxLen(settings.bio, 300, 'bio');
      break;

    // stats_counter section blocks
    case 'stat_item':
      required(settings.value, 'value');
      maxLen(settings.value, 20, 'value');
      required(settings.label, 'label');
      maxLen(settings.label, 60, 'label');
      break;

    // gallery_grid section blocks
    case 'gallery_image':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.alt, 150, 'alt');
      if (settings.link) assertLinkTarget(settings.link, 'link');
      break;

    // store_locations section blocks
    case 'location_item':
      required(settings.name, 'name');
      maxLen(settings.name, 80, 'name');
      maxLen(settings.address, 240, 'address');
      maxLen(settings.phone, 40, 'phone');
      maxLen(settings.email, 120, 'email');
      maxLen(settings.hours, 160, 'hours');
      if (settings.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.email)) throw new BadRequestException('email is not a valid address');
      if (settings.mapUrl) { assertHttpsUrl(settings.mapUrl, 'mapUrl'); maxLen(settings.mapUrl, 500, 'mapUrl'); }
      break;

    // multicolumn section blocks
    case 'multicolumn_column':
      if (settings.imageUrl) assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.heading, 120, 'heading');
      maxLen(settings.body, 1000, 'body');
      maxLen(settings.ctaText, 40, 'ctaText');
      assertLinkTarget(settings.ctaLink, 'ctaLink');
      break;

    // logo_list section blocks
    case 'logo_item':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.alt, 120, 'alt');
      assertLinkTarget(settings.link, 'link');
      break;

    // marquee section blocks
    case 'marquee_item':
      required(settings.text, 'text');
      maxLen(settings.text, 120, 'text');
      assertLinkTarget(settings.link, 'link');
      break;

    // product_main's 7 fixed blocks (Phase 4) — no settings, purely
    // enable/disable + reorder of an already-real, already-rendered piece
    // of the product page. See `core-sections.util.ts`.
    case 'multirow_row':
      if (settings.imageUrl) assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.heading, 120, 'heading');
      maxLen(settings.body, 1000, 'body');
      maxLen(settings.ctaText, 40, 'ctaText');
      assertLinkTarget(settings.ctaLink, 'ctaLink');
      break;
    case 'collage_item':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      maxLen(settings.heading, 80, 'heading');
      assertLinkTarget(settings.link, 'link');
      break;
    case 'product_variant_picker':
      oneOf(settings.pickerStyle, ['pills', 'dropdown'] as const, 'settings.pickerStyle');
      break;
    // Blocks a seller adds to Main Product (Shopify Dawn): plain text only.
    case 'product_buy_now':
      maxLen(settings.label, 40, 'settings.label');
      break;
    case 'product_collapsible_tab':
      required(settings.title, 'settings.title');
      maxLen(settings.title, 80, 'settings.title');
      maxLen(settings.content, 5000, 'settings.content');
      if (settings.openByDefault !== undefined && typeof settings.openByDefault !== 'boolean') {
        throw new BadRequestException('settings.openByDefault must be true or false');
      }
      break;
    case 'product_size_chart':
      maxLen(settings.label, 40, 'settings.label');
      maxLen(settings.title, 80, 'settings.title');
      maxLen(settings.content, 5000, 'settings.content');
      if (settings.imageUrl) assertHttpsUrl(settings.imageUrl, 'settings.imageUrl');
      break;
    case 'product_buy_buttons':
      for (const k of ['addToCartLabel', 'soldOutLabel', 'preorderLabel', 'addedLabel'] as const) maxLen(settings[k], 30, `settings.${k}`);
      break;
    case 'product_description':
      maxLen(settings.heading, 40, 'settings.heading');
      break;
    case 'product_media':
    case 'product_title':
    case 'product_price':
    case 'product_quantity':
    case 'product_rating':
    case 'product_sku':
    case 'product_wishlist':
    case 'product_share':
    case 'product_specs':
      break;

    case 'theme_block':
      validateThemeFields(settings, 'blockKey', 'settings');
      break;

    default:
      throw new BadRequestException(`Unknown block type: ${blockType}`);
  }
}

const NAV_MENU_STYLES = ['dropdown', 'mega'] as const;
const PAYMENT_ICONS = ['visa', 'mastercard', 'amex', 'paypal', 'applepay', 'googlepay', 'jazzcash', 'easypaisa', 'cod'] as const;

/** email / phone links keep their value in `url`; every link may ask to open in a new tab. */
function assertLinkContact(link: Record<string, any>, prefix: string): void {
  if (link?.linkType === 'email') {
    required(link.url, `${prefix}url`);
    if (typeof link.url !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(link.url) || link.url.length > 120) {
      throw new BadRequestException(`${prefix}url must be a valid email address`);
    }
  }
  if (link?.linkType === 'phone') {
    required(link.url, `${prefix}url`);
    if (typeof link.url !== 'string' || !/^\+?[\d\s().-]{5,25}$/.test(link.url)) {
      throw new BadRequestException(`${prefix}url must be a valid phone number`);
    }
  }
  if (link?.newTab !== undefined && link.newTab !== null && typeof link.newTab !== 'boolean') {
    throw new BadRequestException(`${prefix}newTab must be a boolean`);
  }
}

/** Menu tile images are optional (the seller can clear one: '' / null) but, when present, must be a real https:// URL. */
function assertOptionalImageUrl(value: unknown, field: string): void {
  if (value === undefined || value === null || value === '') return;
  assertHttpsUrl(value, field);
  maxLen(value, 2048, field);
}

function validateNavChildren(item: Record<string, any>, depth: number): void {
  if (item.children === undefined) return;
  if (!Array.isArray(item.children)) throw new BadRequestException('children must be an array');
  if (depth >= 3 && item.children.length) throw new BadRequestException('Navigation menus cannot exceed 3 levels');
  for (const child of item.children) {
    required(child?.label, 'children[].label');
    maxLen(child?.label, 40, 'children[].label');
    required(child?.linkType, 'children[].linkType');
    oneOf(child?.linkType, NAV_LINK_TYPES, 'children[].linkType');
    if (child?.linkType === 'page') required(child?.pageSlug, 'children[].pageSlug');
    if (child?.linkType === 'external') assertHttpsUrl(child?.url, 'children[].url');
    if (child?.linkType === 'category') required(child?.categoryId, 'children[].categoryId');
    if (child?.linkType === 'collection') required(child?.collectionId, 'children[].collectionId');
    if (child?.linkType === 'product') required(child?.productId, 'children[].productId');
    assertLinkContact(child, 'children[].');
    assertOptionalImageUrl(child?.imageUrl, 'children[].imageUrl');
    if (child?.children !== undefined) validateNavChildren(child, depth + 1);
  }
}

// ── Header/footer block-array validation (StoreTheme header/footer, and the
// ThemeDefinition catalog's own header/footer, which must satisfy the exact
// same rule) — shared here rather than duplicated/cross-imported between
// `store-theme` and `theme-catalog`. ─────────────────────────────────────

export const HEADER_ALLOWED_BLOCK_TYPES = ['nav_link'];
export const FOOTER_ALLOWED_BLOCK_TYPES = ['footer_column', 'social_link', 'copyright_text', 'footer_text', 'footer_contact', 'footer_payment_icons',
  'footer_brand', 'footer_newsletter', 'footer_image'];

export function validateBlocks(blocks: { type: string; settings: Record<string, any> }[], allowed: readonly string[], max: number): void {
  if (blocks.length > max) throw new BadRequestException(`Cannot have more than ${max} items`);
  for (const block of blocks) {
    if (!allowed.includes(block.type)) throw new BadRequestException(`Block type "${block.type}" is not allowed here`);
    validateBlockSettings(block.type, block.settings ?? {});
  }
}

/** Validates every block in an array against the given expected type(s) —
 *  used when a section type only accepts one specific block type.
 *
 *  Phase 8 — `allowAppBlocks` (default false, so every pre-existing call
 *  site is unaffected) lets an app-provided block (`Block.type` shaped
 *  `app:<appId>:<blockKey>`, see `app-block.util.ts`) through this
 *  first-party check untouched — it's validated separately, WITH real
 *  database access (is the app installed for this store? is this section
 *  type actually in that app's own supported list?), by
 *  `AppsService.assertBlocksAllowed`, called from the same service right
 *  after this function — this file stays a pure, DB-free validator, same
 *  as before this feature existed. */
export function validateBlocksOfType(blocks: { type: string; settings: Record<string, any> }[], allowedTypes: readonly string[], allowAppBlocks = false): void {
  if (blocks.length > MAX_BLOCKS_PER_SECTION) {
    throw new BadRequestException(`A section can have up to ${MAX_BLOCKS_PER_SECTION} blocks`);
  }
  for (const block of blocks) {
    if (allowAppBlocks && isAppBlockType(block.type)) continue;
    if (!allowedTypes.includes(block.type)) {
      throw new BadRequestException(`Block type "${block.type}" is not allowed in this section`);
    }
    validateBlockSettings(block.type, block.settings ?? {});
  }
}

/** Maps a section type to the block type(s) its `blocks` array is allowed to contain — empty array means the section takes no blocks. Typed against `BlockType` (not `string`) so a typo'd or retired block-type name here is a compile error, not a silent runtime gap. */
export const SECTION_ALLOWED_BLOCK_TYPES: AllowedBlockTypesMap = {
  hero: ['hero_slide'],
  rich_text: ['paragraph', 'heading', 'image', 'quote', 'list', 'divider'],
  featured_products: [],
  product_catalog: [],
  image_with_text: ['image_text_pair'],
  testimonials: ['testimonial'],
  faq: ['faq_item'],
  video: [],
  featured_category_grid: [],
  trust_badges: ['trust_badge_item'],
  newsletter: [],
  blog_posts: [],
  metaobject_list: [],
  collection_product_grid: [],
  editorial_lookbook: ['lookbook_item'],
  farm_story: ['farm_story_step'],
  drop_countdown: [],
  craft_process: ['craft_process_step'],
  tech_specs_compare: ['spec_row'],
  soft_gallery: ['gallery_item'],
  feature_list: ['feature_item'],
  team_grid: ['team_member'],
  stats_counter: ['stat_item'],
  gallery_grid: ['gallery_image'],
  multicolumn: ['multicolumn_column'],
  logo_list: ['logo_item'],
  marquee: ['marquee_item'],
  custom_html: [],
  image_banner: [],
  collection_list: [],
  divider: [],
  multirow: ['multirow_row'],
  collage: ['collage_item'],
  featured_product: [],
  collection_banner: [],
  recently_viewed: [],
  store_locations: ['location_item'],
  contact_form: [],
  related_products: [],
  product_main: ['product_media', 'product_title', 'product_price', 'product_variant_picker', 'product_quantity', 'product_buy_buttons', 'product_description', 'product_rating', 'product_sku', 'product_wishlist', 'product_share', 'product_specs', 'product_buy_now', 'product_collapsible_tab', 'product_size_chart'],
  search_results: [],
  cart_items: [],
  cart_summary: [],
  blog_post_list: [],
  article_content: [],
  page_content: [],
  theme_section: ['theme_block'],
};
