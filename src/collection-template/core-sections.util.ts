/* eslint-disable prettier/prettier */
import type { SectionType } from '../common/schemas/section.schema';
import type { ResourceTemplateType } from './schemas/collection-template.schema';

/**
 * Core/locked sections (Phase 4 of the Online Store theme-editor rebuild).
 *
 * Product, Search, Cart and Blog templates used to seed an EMPTY
 * `sections`/`draft.sections` array (see the old `starterSections`), since
 * their real commerce/listing content (gallery+price+buy-buttons, the
 * search results grid, cart line items+summary, the blog post list, an
 * article's body) is fixed chrome that already renders unconditionally
 * inside each theme's own page component (`AtelierProductPage` etc.) —
 * outside the section system entirely, per this app's established
 * architectural boundary. That made the Customize editor's section list
 * (and its live preview) look genuinely blank for these templates, even
 * though the real storefront page was never blank — confusing, not a bug in
 * the storefront itself.
 *
 * This file is the one shared source of truth for which "core" section
 * type(s) a given (resourceType, templateKey) requires, and what a fresh
 * one looks like — used both to SEED a template (new doc, or lazily
 * backfilled onto a pre-existing one — see `CollectionTemplateService`) and
 * to REJECT a save that would remove one (`findMissingCoreParts`, called
 * from `updateSections`). The real fixed chrome itself is never touched —
 * only the Customize editor's list/live-preview representation of it.
 */

/** The 7 fixed blocks every `product_main` section always carries — a
 *  merchant may hide (via each block's existing `enabled` toggle) or
 *  reorder them, but never add a different one or remove one outright.
 *  Order here is the seeded/required order. */
export const PRODUCT_MAIN_BLOCK_TYPES = [
  'product_media',
  'product_title',
  'product_price',
  'product_variant_picker',
  'product_quantity',
  'product_buy_buttons',
  'product_description',
] as const;
export type ProductMainBlockType = (typeof PRODUCT_MAIN_BLOCK_TYPES)[number];

const PRODUCT_MAIN_BLOCK_LABELS: Record<ProductMainBlockType, string> = {
  product_media: 'Product media',
  product_title: 'Title',
  product_price: 'Price',
  product_variant_picker: 'Variant picker',
  product_quantity: 'Quantity',
  product_buy_buttons: 'Buy buttons',
  product_description: 'Description',
};

/** Every core/locked section type — see `SECTION_TYPES`'s own doc comment
 *  (`common/schemas/section.schema.ts`) for the full architectural note. */
export const CORE_SECTION_TYPES: readonly SectionType[] = [
  'product_main',
  'search_results',
  'cart_items',
  'cart_summary',
  'blog_post_list',
  'article_content',
];

/** Which core section type(s) a (resourceType, templateKey) pair requires,
 *  in seeded/required order. Empty for `collection` (its own
 *  `collection_product_grid` pre-seed predates this feature and is
 *  unrelated) and for any `page`-bucket `templateKey` this pass doesn't
 *  cover (e.g. a real custom-page starter template) — those keep seeding
 *  `[]`, byte-identical to before this feature existed. Product's alternate
 *  templates (`allowAltTemplates: true`) all require the same
 *  `product_main` regardless of `templateKey` — every alternate layout
 *  still needs the core commerce block. */
export function requiredCoreSectionTypesFor(resourceType: ResourceTemplateType, templateKey: string): SectionType[] {
  if (resourceType === 'product') return ['product_main'];
  if (resourceType === 'page') {
    if (templateKey === 'search') return ['search_results'];
    if (templateKey === 'cart') return ['cart_items', 'cart_summary'];
    if (templateKey === 'blog-index') return ['blog_post_list'];
    if (templateKey === 'blog-article') return ['article_content'];
  }
  return [];
}

function buildCoreSection(type: SectionType) {
  if (type === 'product_main') {
    return {
      type,
      settings: {},
      blocks: PRODUCT_MAIN_BLOCK_TYPES.map(blockType => ({
        type: blockType as string,
        settings: { label: PRODUCT_MAIN_BLOCK_LABELS[blockType] },
        enabled: true,
      })),
    };
  }
  return { type, settings: {}, blocks: [] as { type: string; settings: Record<string, any> }[] };
}

/** The full seeded core-section list for a fresh (resourceType, templateKey)
 *  — one entry per `requiredCoreSectionTypesFor`, in order. `[]` for
 *  `collection`/uncovered `page` buckets. */
export function buildCoreSections(resourceType: ResourceTemplateType, templateKey: string) {
  return requiredCoreSectionTypesFor(resourceType, templateKey).map(buildCoreSection);
}

/** Returns a human-readable list of what a save would remove/corrupt (a
 *  missing required core section type, or a missing required block inside
 *  `product_main`) — empty when nothing required is missing. Called from
 *  `CollectionTemplateService.updateSections` so a direct API call can't
 *  silently delete required core content any more than the editor UI (which
 *  hides the Remove control for these) already prevents. */
export function findMissingCoreParts(
  resourceType: ResourceTemplateType,
  templateKey: string,
  sections: { type: string; blocks?: { type: string }[] }[],
): string[] {
  const missing: string[] = [];
  for (const requiredType of requiredCoreSectionTypesFor(resourceType, templateKey)) {
    const match = sections.find(s => s.type === requiredType);
    if (!match) {
      missing.push(requiredType);
      continue;
    }
    if (requiredType === 'product_main') {
      const presentBlockTypes = new Set((match.blocks ?? []).map(b => b.type));
      for (const requiredBlock of PRODUCT_MAIN_BLOCK_TYPES) {
        if (!presentBlockTypes.has(requiredBlock)) missing.push(`${requiredType}.${requiredBlock}`);
      }
    }
  }
  return missing;
}
