import { BadRequestException } from '@nestjs/common';
import { SECTION_TYPES } from '../schemas/section.schema';

/**
 * Which section types a theme accepts.
 *
 * The theme itself decides what it renders (its own renderer registry on the frontend, which also drives the
 * editor's "Add section" list), so the backend does NOT need an edit when a theme is added: a theme with no entry
 * here accepts every section type the platform knows (`SECTION_TYPES`). A theme id the backend has never heard of
 * (a retired theme, a brand-new one) behaves the same way.
 *
 * Add an entry only to NARROW a theme on the server as well (a hard rule, not just the editor's list).
 */
export const THEME_SECTION_TYPES: Record<string, ReadonlySet<string>> = {};

const ALL_SECTION_TYPES: ReadonlySet<string> = new Set<string>(SECTION_TYPES);

const capabilitiesOf = (themeDefinitionId: string): ReadonlySet<string> => THEME_SECTION_TYPES[themeDefinitionId] ?? ALL_SECTION_TYPES;

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
