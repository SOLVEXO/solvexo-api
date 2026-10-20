import { BadRequestException } from '@nestjs/common';
import { validateBlockSettings, validateSectionSettings, SECTION_ALLOWED_BLOCK_TYPES } from './section-settings.validator';
import { assertThemeSupportsSections, filterSectionsToTheme } from './theme-section-capabilities';

describe('theme-declared sections (theme_section / theme_block)', () => {
  it('accepts a section with simple fields, lists and a link object', () => {
    expect(() => validateSectionSettings('theme_section', {
      sectionKey: 'maison.lookbook', heading: 'Looks', columns: 3, showTitle: true, tags: ['a', 'b'],
      link: { linkType: 'collection', collectionId: 'abc' },
    })).not.toThrow();
  });

  it('requires a short lowercase sectionKey', () => {
    for (const bad of [undefined, '', 'Maison.Lookbook', 'has space', 'x'.repeat(61), 5]) {
      expect(() => validateSectionSettings('theme_section', { sectionKey: bad as never })).toThrow(BadRequestException);
    }
  });

  it('rejects odd field names and unsupported or oversized values', () => {
    const key = 'a.b';
    expect(() => validateSectionSettings('theme_section', { sectionKey: key, '$where': 1 })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('theme_section', { sectionKey: key, '__proto__x': 1 })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('theme_section', { sectionKey: key, text: 'x'.repeat(5001) })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('theme_section', { sectionKey: key, n: Number.NaN })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('theme_section', { sectionKey: key, deep: { a: { b: { c: 1 } } } })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('theme_section', { sectionKey: key, list: Array.from({ length: 51 }, () => 'x') })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('theme_section', { sectionKey: key, fn: (() => 1) as never })).toThrow(BadRequestException);
  });

  it('caps the number of fields and the total size', () => {
    const many = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`f${i}`, 1]));
    expect(() => validateSectionSettings('theme_section', { sectionKey: 'a.b', ...many })).toThrow(BadRequestException);
    const big = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, 'x'.repeat(4000)]));
    expect(() => validateSectionSettings('theme_section', { sectionKey: 'a.b', ...big })).toThrow(BadRequestException);
  });

  it('validates blocks by blockKey and allows them only inside a theme_section', () => {
    expect(() => validateBlockSettings('theme_block', { blockKey: 'maison.lookbook.look', title: 'Look 1', imageUrl: 'https://x.test/a.jpg' })).not.toThrow();
    expect(() => validateBlockSettings('theme_block', { title: 'no key' })).toThrow(BadRequestException);
    expect(SECTION_ALLOWED_BLOCK_TYPES.theme_section).toEqual(['theme_block']);
    expect(SECTION_ALLOWED_BLOCK_TYPES.hero).not.toContain('theme_block');
  });

  it('accepts the new tablet / large visibility values and still rejects unknown ones', () => {
    for (const visibility of ['all', 'desktop', 'mobile', 'tablet', 'large', 'mobile-tablet']) {
      expect(() => validateSectionSettings('rich_text', { visibility })).not.toThrow();
    }
    expect(() => validateSectionSettings('rich_text', { visibility: 'watch' })).toThrow(BadRequestException);
  });
});

describe('theme section capabilities', () => {
  it('a theme with no server-side rule (or an unknown theme id) accepts every platform section type', () => {
    expect(() => assertThemeSupportsSections([{ type: 'hero' }, { type: 'theme_section' }, { type: 'video' }], 'theme-03-fashion')).not.toThrow();
    expect(() => assertThemeSupportsSections([{ type: 'hero' }], 'a-theme-the-backend-never-heard-of')).not.toThrow();
  });

  it('still rejects a missing theme id and a section type the platform does not know', () => {
    expect(() => assertThemeSupportsSections([{ type: 'hero' }], null)).toThrow(BadRequestException);
    expect(() => assertThemeSupportsSections([{ type: 'not_a_section' }], 'theme-03-fashion')).toThrow(BadRequestException);
  });

  it('filterSectionsToTheme drops only unknown types', () => {
    const kept = filterSectionsToTheme([{ type: 'hero' }, { type: 'bogus' }, { type: 'theme_section' }], 'theme-03-fashion');
    expect(kept.map(s => s.type)).toEqual(['hero', 'theme_section']);
  });
});
