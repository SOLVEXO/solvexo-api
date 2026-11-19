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

  it('only holds what the seller must fill in: a banner and one empty hand-picked slot (no auto lists)', () => {
    expect(sections.map(s => s.type)).toEqual(['image_banner', 'featured_products']);
    const featured = sections.filter(s => s.type === 'featured_products');
    expect(featured.map(s => s.settings.source)).toEqual(['manual']);
    expect((featured[0].settings as any).productIds).toEqual([]);
    const text = JSON.stringify(sections);
    for (const auto of ['bestsellers', 'newArrivals', 'trending', 'onSale']) expect(text).not.toContain(auto);
  });

  it('never ships an image the seller did not choose, or invented claims like free shipping', () => {
    const text = JSON.stringify(sections).toLowerCase();
    expect(text).not.toContain('http');
    expect(text).not.toContain('free shipping');
    expect(text).not.toContain('returns');
  });
});
