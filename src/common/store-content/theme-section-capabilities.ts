import { BadRequestException } from '@nestjs/common';

const COMMON_SECTION_TYPES = new Set([
  'hero', 'rich_text', 'featured_products', 'product_catalog', 'image_with_text',
  'testimonials', 'faq', 'featured_category_grid', 'trust_badges', 'newsletter',
  'blog_posts', 'metaobject_list', 'collection_product_grid', 'product_main',
  'search_results', 'cart_items', 'cart_summary', 'blog_post_list', 'article_content',
  'multicolumn', 'logo_list', 'marquee', 'custom_html', 'image_banner',
]);

/** Theme renderer capability catalog; keep aligned with frontend section registries. */
export const THEME_SECTION_TYPES: Record<string, ReadonlySet<string>> = {
  'theme-01-atelier': new Set([...COMMON_SECTION_TYPES, 'video', 'drop_countdown']),
  // Nova renders video + drop_countdown too (the section files exist) — keep the two themes' capability lists aligned.
  'theme-02-nova': new Set([...COMMON_SECTION_TYPES, 'video', 'drop_countdown']),
};

export function assertThemeSupportsSections(sections: { type: string }[], themeDefinitionId?: string | null) {
  if (!themeDefinitionId) {
    throw new BadRequestException('The active theme has no registered section capabilities');
  }
  const supported = THEME_SECTION_TYPES[themeDefinitionId];
  if (!supported) {
    throw new BadRequestException(`Theme "${themeDefinitionId}" has no registered section capabilities`);
  }
  const unsupported = sections.find(section => !supported.has(section.type));
  if (unsupported) throw new BadRequestException(`Section "${unsupported.type}" is not available in this theme`);
}

export function filterSectionsToTheme<T extends { type: string }>(sections: T[], themeDefinitionId: string): T[] {
  const supported = THEME_SECTION_TYPES[themeDefinitionId];
  if (!supported) throw new BadRequestException(`Theme "${themeDefinitionId}" has no registered section capabilities`);
  return sections.filter(section => supported.has(section.type));
}
