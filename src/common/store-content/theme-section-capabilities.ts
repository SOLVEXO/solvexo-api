import { BadRequestException } from '@nestjs/common';

const COMMON_SECTION_TYPES = new Set([
  'hero', 'rich_text', 'featured_products', 'product_catalog', 'image_with_text',
  'testimonials', 'faq', 'featured_category_grid', 'trust_badges', 'newsletter',
  'blog_posts', 'metaobject_list', 'collection_product_grid', 'product_main',
  'search_results', 'cart_items', 'cart_summary', 'blog_post_list', 'article_content',
  'multicolumn', 'logo_list', 'marquee', 'custom_html', 'image_banner',
  'collection_list', 'store_locations', 'gallery_grid', 'contact_form', 'related_products',
  'divider', 'multirow', 'collage', 'featured_product', 'collection_banner', 'recently_viewed',
]);

/** Theme renderer capability catalog; keep aligned with frontend section registries. */
export const THEME_SECTION_TYPES: Record<string, ReadonlySet<string>> = {
  'theme-03-fashion': new Set([...COMMON_SECTION_TYPES, 'video', 'drop_countdown']),
};

const DEFAULT_THEME_ID = 'theme-03-fashion';

/** A theme id the catalog does not know (e.g. a retired theme) is served like the default theme, the same fallback the storefront applies when it renders. */
const capabilitiesOf = (themeDefinitionId: string) => THEME_SECTION_TYPES[themeDefinitionId] ?? THEME_SECTION_TYPES[DEFAULT_THEME_ID];

export function assertThemeSupportsSections(sections: { type: string }[], themeDefinitionId?: string | null) {
  if (!themeDefinitionId) {
    throw new BadRequestException('The active theme has no registered section capabilities');
  }
  const supported = capabilitiesOf(themeDefinitionId);
  const unsupported = sections.find(section => !supported.has(section.type));
  if (unsupported) throw new BadRequestException(`Section "${unsupported.type}" is not available in this theme`);
}

export function filterSectionsToTheme<T extends { type: string }>(sections: T[], themeDefinitionId: string): T[] {
  const supported = capabilitiesOf(themeDefinitionId);
  return sections.filter(section => supported.has(section.type));
}
