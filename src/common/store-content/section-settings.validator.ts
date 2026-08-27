/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import type { SectionType } from '../schemas/section.schema';
import type {
  AllowedBlockTypesMap,
  FeaturedProductsSectionSettings,
  ProductCatalogSectionSettings,
  FeaturedCategoryGridSectionSettings,
  VideoSectionSettings,
  NewsletterSectionSettings,
  HeroSectionSettings,
  RichTextSectionSettings,
  CollectionProductGridSectionSettings,
  FarmStorySectionSettings,
  DropCountdownSectionSettings,
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

const MAX_BLOCKS_PER_SECTION = 20;

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
export const LINK_TYPES = ['home', 'page', 'blog', 'external', 'category', 'collection'] as const;

function assertLinkTarget(link: unknown, field: string): void {
  if (link === undefined || link === null) return;
  if (typeof link !== 'object') throw new BadRequestException(`${field} is invalid`);
  const l = link as Record<string, unknown>;
  oneOf(l.linkType, LINK_TYPES, `${field}.linkType`);
  if (l.linkType === 'page') required(l.pageSlug, `${field}.pageSlug`);
  if (l.linkType === 'external') assertHttpsUrl(l.url, `${field}.url`);
  if (l.linkType === 'category') required(l.categoryId, `${field}.categoryId`);
  if (l.linkType === 'collection') required(l.collectionId, `${field}.collectionId`);
}

// ── Section-level settings ──────────────────────────────────────────────────

export function validateSectionSettings(type: SectionType, settings: Record<string, any>): void {
  maxLen(settings.heading, 120, 'settings.heading');

  switch (type) {
    case 'hero': {
      const s = settings as HeroSectionSettings;
      oneOf(s.heightPreset, ['small', 'medium', 'large'] as const, 'settings.heightPreset');
      break;
    }
    case 'rich_text': {
      const s = settings as RichTextSectionSettings;
      oneOf(s.alignment, ['left', 'center', 'right'] as const, 'settings.alignment');
      break;
    }
    case 'featured_products': {
      const s = settings as FeaturedProductsSectionSettings;
      required(s.source, 'settings.source');
      oneOf(s.source, ['manual', 'category', 'collection', 'bestsellers', 'newArrivals', 'trending', 'pinned', 'onSale'] as const, 'settings.source');
      if (s.source === 'category') required(s.categoryId, 'settings.categoryId');
      if (s.source === 'collection') required(s.collectionId, 'settings.collectionId');
      if (s.source === 'manual') {
        if (!Array.isArray(s.productIds) || s.productIds.length === 0) {
          throw new BadRequestException('settings.productIds is required when source is "manual"');
        }
        if (s.productIds.length > 24) throw new BadRequestException('settings.productIds cannot exceed 24 products');
      }
      if (s.limit !== undefined && (typeof s.limit !== 'number' || s.limit < 1 || s.limit > 24)) {
        throw new BadRequestException('settings.limit must be between 1 and 24');
      }
      break;
    }
    case 'product_catalog': {
      const s = settings as ProductCatalogSectionSettings;
      oneOf(s.defaultSort, ['newest', 'price_asc', 'price_desc', 'best_rated'] as const, 'settings.defaultSort');
      if (s.columns !== undefined && ![2, 3, 4].includes(s.columns)) {
        throw new BadRequestException('settings.columns must be 2, 3, or 4');
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
      if (!Array.isArray(s.categoryIds) || s.categoryIds.length === 0) {
        throw new BadRequestException('settings.categoryIds is required');
      }
      if (s.categoryIds.length > 12) throw new BadRequestException('settings.categoryIds cannot exceed 12 categories');
      break;
    }
    case 'trust_badges':
      break; // content lives entirely in trust_badge_item blocks
    case 'newsletter': {
      const s = settings as NewsletterSectionSettings;
      maxLen(s.subtext, 200, 'settings.subtext');
      break;
    }
    case 'video': {
      const s = settings as VideoSectionSettings;
      required(s.videoUrl, 'settings.videoUrl');
      if (typeof s.videoUrl !== 'string' || !/^https:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//i.test(s.videoUrl)) {
        throw new BadRequestException('settings.videoUrl must be a YouTube or Vimeo link');
      }
      oneOf(s.aspectRatio, ['16:9', '4:3', '1:1'] as const, 'settings.aspectRatio');
      break;
    }
    case 'image_with_text':
    case 'testimonials':
    case 'faq':
      break; // content lives entirely in blocks, no section-level settings beyond heading
    case 'collection_product_grid': {
      const s = settings as CollectionProductGridSectionSettings;
      oneOf(s.defaultSort, ['newest', 'price_asc', 'price_desc', 'best_rated'] as const, 'settings.defaultSort');
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
  switch (blockType) {
    // Header/footer blocks (StoreTheme)
    case 'nav_link':
      required(settings.label, 'label');
      maxLen(settings.label, 40, 'label');
      required(settings.linkType, 'linkType');
      oneOf(settings.linkType, LINK_TYPES, 'linkType');
      if (settings.linkType === 'page') required(settings.pageSlug, 'pageSlug');
      if (settings.linkType === 'external') assertHttpsUrl(settings.url, 'url');
      if (settings.linkType === 'category') required(settings.categoryId, 'categoryId');
      if (settings.linkType === 'collection') required(settings.collectionId, 'collectionId');
      if (settings.highlight !== undefined && typeof settings.highlight !== 'boolean') {
        throw new BadRequestException('highlight must be a boolean');
      }
      // Real dropdown support (was previously 100% flat). One level only —
      // a child is validated with the exact same rules as a top-level
      // nav_link, but is explicitly forbidden from carrying a `children` key
      // of its own, enforcing the single-level limit at runtime too (not
      // just at the TypeScript layer, since `settings` arrives as untrusted
      // network JSON that never goes through that type).
      if (settings.children !== undefined) {
        if (!Array.isArray(settings.children)) throw new BadRequestException('children must be an array');
        if (settings.children.length > 8) throw new BadRequestException('A dropdown cannot have more than 8 items');
        for (const child of settings.children) {
          if (child && typeof child === 'object' && 'children' in child) {
            throw new BadRequestException('Dropdown items cannot themselves have a submenu');
          }
          required(child?.label, 'children[].label');
          maxLen(child?.label, 40, 'children[].label');
          required(child?.linkType, 'children[].linkType');
          oneOf(child?.linkType, LINK_TYPES, 'children[].linkType');
          if (child?.linkType === 'page') required(child?.pageSlug, 'children[].pageSlug');
          if (child?.linkType === 'external') assertHttpsUrl(child?.url, 'children[].url');
          if (child?.linkType === 'category') required(child?.categoryId, 'children[].categoryId');
          if (child?.linkType === 'collection') required(child?.collectionId, 'children[].collectionId');
        }
      }
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

    // hero section blocks
    case 'hero_slide':
      assertHttpsUrl(settings.imageUrl, 'imageUrl');
      if (settings.mobileImageUrl !== undefined) assertHttpsUrl(settings.mobileImageUrl, 'mobileImageUrl');
      maxLen(settings.heading, 100, 'heading');
      maxLen(settings.subheading, 200, 'subheading');
      maxLen(settings.ctaText, 40, 'ctaText');
      assertLinkTarget(settings.ctaLink, 'ctaLink');
      break;

    // rich_text / blog content blocks
    case 'paragraph':
      required(settings.text, 'text');
      maxLen(settings.text, 2000, 'text');
      break;
    case 'heading':
      required(settings.text, 'text');
      maxLen(settings.text, 150, 'text');
      oneOf(settings.level, ['h2', 'h3', 'h4'] as const, 'level');
      break;
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

    default:
      throw new BadRequestException(`Unknown block type: ${blockType}`);
  }
}

/** Validates every block in an array against the given expected type(s) — used when a section type only accepts one specific block type. */
export function validateBlocksOfType(blocks: { type: string; settings: Record<string, any> }[], allowedTypes: readonly string[]): void {
  if (blocks.length > MAX_BLOCKS_PER_SECTION) {
    throw new BadRequestException(`A section cannot have more than ${MAX_BLOCKS_PER_SECTION} blocks`);
  }
  for (const block of blocks) {
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
  collection_product_grid: [],
  editorial_lookbook: ['lookbook_item'],
  farm_story: ['farm_story_step'],
  drop_countdown: [],
  craft_process: ['craft_process_step'],
  tech_specs_compare: ['spec_row'],
  soft_gallery: ['gallery_item'],
};
