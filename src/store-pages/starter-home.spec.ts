import { starterHomeSections, validateSections } from './store-pages.service';
import { filterSectionsToTheme } from '../common/store-content/theme-section-capabilities';

describe('starter home page for a new store', () => {
  const sections = starterHomeSections();

  it('passes the same validation as anything the seller saves later', () => {
    expect(() => validateSections(sections as any)).not.toThrow();
  });

  it('is fully supported by the default theme (nothing gets filtered out)', () => {
    expect(filterSectionsToTheme(sections, 'theme-03-fashion')).toHaveLength(sections.length);
  });

  it('is a real, designed page: banner, trust row, new arrivals, best sellers, sign-up', () => {
    expect(sections.map(s => s.type)).toEqual(['image_banner', 'trust_badges', 'featured_products', 'featured_products', 'newsletter']);
    expect(sections.filter(s => s.type === 'featured_products').map(s => s.settings.source)).toEqual(['newArrivals', 'bestsellers']);
  });

  it('never ships an image the seller did not choose, or invented claims like free shipping', () => {
    const text = JSON.stringify(sections).toLowerCase();
    expect(text).not.toContain('http');
    expect(text).not.toContain('free shipping');
    expect(text).not.toContain('returns');
  });
});
