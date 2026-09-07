/* eslint-disable prettier/prettier */
import type { SectionType } from '../schemas/section.schema';

/**
 * The typed contract for every `Section.settings`/`Block.settings` shape
 * this app actually has, mirrored field-for-field from the runtime checks in
 * `section-settings.validator.ts` — this file doesn't invent new shapes, it
 * gives the ones already enforced there a real static type so callers get
 * autocomplete/compile-time safety instead of `Record<string, any>`.
 *
 * `Section.settings`/`Block.settings` stay `Record<string, any>` at the
 * Mongoose/DTO layer (settings genuinely arrive as untrusted network JSON —
 * that's what the validator's job is), so these types are a documentary/
 * call-site contract, not a replacement for runtime validation. The one
 * place this DOES buy a real compile-time guarantee is exhaustiveness: see
 * `validateSectionSettings`'s `never`-typed default case, which fails to
 * compile the moment a new `SectionType` is added to `SECTION_TYPES` without
 * a matching branch here and in the validator.
 *
 * Frontend note: `solvexo/src/api/services/sectionSettingsTypes.ts` mirrors
 * this file's shapes for the same reason on the client side. The two repos
 * have no shared-package/codegen link today, so they're kept in sync by hand
 * — a real limitation, not a hidden one (flagged in the Phase 0 report).
 */

export interface BaseSectionSettings {
  heading?: string;
}

/** Shared by any block/section CTA — a nav link, footer link, or hero/image-with-text button. */
export interface LinkTarget {
  linkType: 'home' | 'page' | 'blog' | 'external' | 'category' | 'collection';
  pageSlug?: string;
  url?: string;
  categoryId?: string;
  collectionId?: string;
}

// ── Section settings, one per `SectionType` ─────────────────────────────────

export interface HeroSectionSettings extends BaseSectionSettings {
  heightPreset?: 'small' | 'medium' | 'large';
}
export interface RichTextSectionSettings extends BaseSectionSettings {
  alignment?: 'left' | 'center' | 'right';
}
export interface FeaturedProductsSectionSettings extends BaseSectionSettings {
  source: 'manual' | 'category' | 'collection' | 'bestsellers' | 'newArrivals' | 'trending' | 'pinned' | 'onSale';
  categoryId?: string;
  collectionId?: string;
  /** Required, 1-24 items, only when `source === 'manual'`. */
  productIds?: string[];
  /** 1-24. */
  limit?: number;
}
export interface ProductCatalogSectionSettings extends BaseSectionSettings {
  defaultSort?: 'newest' | 'price_asc' | 'price_desc' | 'best_rated';
  columns?: 2 | 3 | 4;
  /** At most one of categoryId/collectionId may be set. */
  categoryId?: string;
  collectionId?: string;
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-pattern, @typescript-eslint/no-empty-interface
export interface ImageWithTextSectionSettings extends BaseSectionSettings {}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TestimonialsSectionSettings extends BaseSectionSettings {}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FaqSectionSettings extends BaseSectionSettings {}
export interface VideoSectionSettings extends BaseSectionSettings {
  /** Must be a youtube.com/youtu.be/vimeo.com https:// link. */
  videoUrl: string;
  aspectRatio?: '16:9' | '4:3' | '1:1';
}
export interface FeaturedCategoryGridSectionSettings extends BaseSectionSettings {
  /** Required, 1-12 items. */
  categoryIds: string[];
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TrustBadgesSectionSettings extends BaseSectionSettings {}
export interface NewsletterSectionSettings extends BaseSectionSettings {
  subtext?: string;
}
/** Lists every real entry of one seller-defined Metaobject type (see
 *  `metaobjects/`) — `metaobjectType` is the definition's stable `type`
 *  slug, not its Mongo `_id` (matches how the public entries-by-type route
 *  is keyed). */
export interface MetaobjectListSectionSettings extends BaseSectionSettings {
  metaobjectType: string;
}
/** No `collectionId`/`heading` here (unlike `ProductCatalogSectionSettings`) — this section is contextual, always the collection the visitor is currently on. See `SECTION_TYPES`'s comment for why it's excluded from the general "Add Section" picker. */
export interface CollectionProductGridSectionSettings {
  defaultSort?: 'newest' | 'price_asc' | 'price_desc' | 'best_rated';
  columns?: 2 | 3 | 4;
  showFilters?: boolean;
}

// ── Theme-exclusive sections ─────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface EditorialLookbookSectionSettings extends BaseSectionSettings {}
export interface FarmStorySectionSettings extends BaseSectionSettings {
  subheading?: string;
  imageUrl?: string;
}
export interface DropCountdownSectionSettings extends BaseSectionSettings {
  subheading?: string;
  /** ISO date/time string — a countdown target, not validated against any particular format beyond being a string (an unparseable value just renders as "Dropped!" client-side). */
  targetDate?: string;
  ctaText?: string;
  ctaLink?: LinkTarget;
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CraftProcessSectionSettings extends BaseSectionSettings {}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TechSpecsCompareSectionSettings extends BaseSectionSettings {}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface SoftGallerySectionSettings extends BaseSectionSettings {}

// Compile-time-only helper — `T`'s keys must cover every member of `K` (extra
// keys on `T` are still allowed; TS's structural typing can't cheaply forbid
// those without losing the specific per-key value types, and the real risk
// here is a MISSING key, not an extra one). Used below so deleting/renaming a
// `SectionType`/`BlockType` without updating its settings map is a compile
// error, not a silent runtime gap.
type RequireAllKeys<K extends string, T extends Record<K, unknown>> = T;

/** One entry per `SectionType` (see `section.schema.ts#SECTION_TYPES`) — a missing key here is a compile error, which is what keeps this map honest as section types are added. */
export type SectionSettingsMap = RequireAllKeys<SectionType, {
  hero: HeroSectionSettings;
  rich_text: RichTextSectionSettings;
  featured_products: FeaturedProductsSectionSettings;
  product_catalog: ProductCatalogSectionSettings;
  image_with_text: ImageWithTextSectionSettings;
  testimonials: TestimonialsSectionSettings;
  faq: FaqSectionSettings;
  video: VideoSectionSettings;
  featured_category_grid: FeaturedCategoryGridSectionSettings;
  trust_badges: TrustBadgesSectionSettings;
  newsletter: NewsletterSectionSettings;
  metaobject_list: MetaobjectListSectionSettings;
  collection_product_grid: CollectionProductGridSectionSettings;
  editorial_lookbook: EditorialLookbookSectionSettings;
  farm_story: FarmStorySectionSettings;
  drop_countdown: DropCountdownSectionSettings;
  craft_process: CraftProcessSectionSettings;
  tech_specs_compare: TechSpecsCompareSectionSettings;
  soft_gallery: SoftGallerySectionSettings;
}>;

// ── Block settings, one per block `type` string ─────────────────────────────
// `Block.type` stays a plain, non-enum-locked string at the schema level
// (see block.schema.ts) since the valid set differs by parent context
// (header vs. footer vs. hero vs. rich_text, etc.) — `BLOCK_TYPES` here is
// the full catalog across every context, for validator typing only.

/** One level of dropdown children only — deliberately typed as `LinkTarget &
 *  {label}` rather than `NavLinkBlockSettings` itself, so a child link can
 *  never carry a `children` field of its own at the type level (grandchild
 *  dropdowns are out of scope — matches every real storefront nav pattern
 *  this app needs). The validator (section-settings.validator.ts) re-checks
 *  this at runtime too, since `settings` arrives as untrusted network JSON. */
export interface NavLinkChildSettings extends LinkTarget {
  label: string;
}
export interface NavLinkBlockSettings extends LinkTarget {
  label: string;
  highlight?: boolean;
  /** Real dropdown support — was previously 100% flat (a header nav link
   *  could never have a submenu). Omitted/empty = a plain link, unchanged
   *  from before. */
  children?: NavLinkChildSettings[];
}
export interface FooterColumnBlockSettings {
  heading: string;
  links: NavLinkBlockSettings[];
}
export interface SocialLinkBlockSettings {
  platform: 'facebook' | 'instagram' | 'x' | 'tiktok' | 'youtube' | 'linkedin' | 'whatsapp';
  url: string;
}
export interface CopyrightTextBlockSettings {
  text: string;
}
export interface HeroSlideBlockSettings {
  imageUrl: string;
  mobileImageUrl?: string;
  heading?: string;
  subheading?: string;
  ctaText?: string;
  ctaLink?: LinkTarget;
}
/** Dynamic Sources — when both `dynamicSourceNamespace`/`dynamicSourceKey`
 *  are set, `text` is optional (the real value is resolved at render time
 *  from the viewed resource's own metafield instead) and, if present, only
 *  used as an editor-preview fallback. Two flat scalar fields (not one
 *  nested object) to match the schema-driven settings editor's flat
 *  `Record<string, any>` field model — see `sectionRegistry.ts`'s
 *  `BLOCK_SCHEMAS.paragraph`. See `assertDynamicSource` in
 *  `section-settings.validator.ts`. */
export interface ParagraphBlockSettings {
  text?: string;
  dynamicSourceNamespace?: string;
  dynamicSourceKey?: string;
}
export interface HeadingBlockSettings {
  text: string;
  level?: 'h2' | 'h3' | 'h4';
}
export interface ImageBlockSettings {
  imageUrl: string;
  caption?: string;
  alt?: string;
}
export interface QuoteBlockSettings {
  text: string;
  author?: string;
}
export interface ListBlockSettings {
  items: string[];
  style?: 'bullet' | 'numbered';
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface DividerBlockSettings {}
export interface ImageTextPairBlockSettings {
  imageUrl: string;
  heading?: string;
  body?: string;
  ctaText?: string;
  ctaLink?: LinkTarget;
  imagePosition?: 'left' | 'right';
}
export interface TestimonialBlockSettings {
  quote: string;
  authorName: string;
  authorRole?: string;
  avatarUrl?: string;
  /** 1-5. */
  rating?: number;
}
export interface FaqItemBlockSettings {
  question: string;
  answer: string;
}
export interface TrustBadgeItemBlockSettings {
  icon: 'truck' | 'shield' | 'refresh' | 'headset' | 'lock';
  text: string;
}

// ── Theme-exclusive section blocks ───────────────────────────────────────
export interface LookbookItemBlockSettings {
  imageUrl: string;
  caption?: string;
}
export interface FarmStoryStepBlockSettings {
  icon: 'sprout' | 'leaf' | 'truck' | 'heart' | 'sun';
  title: string;
  body: string;
}
export interface CraftProcessStepBlockSettings {
  title: string;
  body: string;
}
export interface SpecRowBlockSettings {
  label: string;
  value: string;
}
export interface GalleryItemBlockSettings {
  imageUrl: string;
  caption?: string;
}

export const BLOCK_TYPES = [
  'nav_link',
  'footer_column',
  'social_link',
  'copyright_text',
  'hero_slide',
  'paragraph',
  'heading',
  'image',
  'quote',
  'list',
  'divider',
  'image_text_pair',
  'testimonial',
  'faq_item',
  'trust_badge_item',
  'lookbook_item',
  'farm_story_step',
  'craft_process_step',
  'spec_row',
  'gallery_item',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** One entry per `BlockType` — same exhaustiveness guarantee as `SectionSettingsMap`. */
export type BlockSettingsMap = RequireAllKeys<BlockType, {
  nav_link: NavLinkBlockSettings;
  footer_column: FooterColumnBlockSettings;
  social_link: SocialLinkBlockSettings;
  copyright_text: CopyrightTextBlockSettings;
  hero_slide: HeroSlideBlockSettings;
  paragraph: ParagraphBlockSettings;
  heading: HeadingBlockSettings;
  image: ImageBlockSettings;
  quote: QuoteBlockSettings;
  list: ListBlockSettings;
  divider: DividerBlockSettings;
  image_text_pair: ImageTextPairBlockSettings;
  testimonial: TestimonialBlockSettings;
  faq_item: FaqItemBlockSettings;
  trust_badge_item: TrustBadgeItemBlockSettings;
  lookbook_item: LookbookItemBlockSettings;
  farm_story_step: FarmStoryStepBlockSettings;
  craft_process_step: CraftProcessStepBlockSettings;
  spec_row: SpecRowBlockSettings;
  gallery_item: GalleryItemBlockSettings;
}>;

/** `SECTION_ALLOWED_BLOCK_TYPES`'s values are typed against this so a typo'd or retired block-type string in that map is a compile error, not a silent runtime gap. */
export type AllowedBlockTypesMap = Record<SectionType, readonly BlockType[]>;
