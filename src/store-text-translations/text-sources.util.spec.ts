/* eslint-disable prettier/prettier */
import { collectChromeBlockItems, collectFieldItems, collectSectionItems, collectTextPaths, isTranslatableText, TEXT_KEY_PATTERN } from './text-sources.util';

describe('text-sources.util', () => {
  it('lists section and block text under stable keys and ignores links, images and layout settings', () => {
    const items = collectSectionItems([
      { _id: 'abc123', type: 'hero', settings: { heading: 'Big sale', imageUrl: 'https://x/y.png', anchor: 'top' },
        blocks: [{ _id: 'b1', type: 'hero_slide', settings: { heading: 'Slide', ctaText: 'Shop now', ctaLink: { linkType: 'home' } } }] },
    ]);
    expect(items.map((i) => i.key)).toEqual(['s:abc123#heading', 'b:abc123:b1#heading', 'b:abc123:b1#ctaText']);
    expect(items.every((i) => TEXT_KEY_PATTERN.test(i.key))).toBe(true);
  });

  it('skips disabled sections and blocks and sections without an id', () => {
    expect(collectSectionItems([
      { _id: 'a', type: 'hero', enabled: false, settings: { heading: 'Hidden' }, blocks: [] },
      { type: 'hero', settings: { heading: 'No id' }, blocks: [] },
      { _id: 'c', type: 'hero', settings: {}, blocks: [{ _id: 'x', enabled: false, type: 't', settings: { heading: 'Off' } }] },
    ])).toEqual([]);
  });

  it('reaches nested menu children and never lists existing translations', () => {
    const keys = collectChromeBlockItems('hb', [{ _id: 'n1', type: 'nav_link', settings: { label: 'Shop', labelTranslations: { ur: 'x' }, children: [{ label: 'Hats' }] } }]).map((i) => i.key);
    expect(keys).toEqual(['hb:n1#label', 'hb:n1#children.0.label']);
  });

  it('treats urls, numbers and empty values as not translatable', () => {
    for (const v of ['', '   ', 'https://a.b/c', '/collections/all', '12.50', 'mailto:a@b.c']) expect(isTranslatableText(v)).toBe(false);
    expect(isTranslatableText('Free shipping over $50')).toBe(true);
    expect(collectTextPaths({ heading: 'Hi', url: 'https://x' })).toEqual([{ path: 'heading', text: 'Hi' }]);
  });

  it('builds plain-field keys and rejects unknown containers on save', () => {
    expect(collectFieldItems('store', { name: 'Shop', tagline: '' }, [['name', 'Store name'], ['tagline', 'Tagline']]).map((i) => i.key)).toEqual(['store#name']);
    expect(TEXT_KEY_PATTERN.test('announcement#moreMessages.0.message')).toBe(true);
    expect(TEXT_KEY_PATTERN.test('faq:507f1f77bcf86cd799439011#answer')).toBe(true);
    expect(TEXT_KEY_PATTERN.test('evil#x')).toBe(false);
    expect(TEXT_KEY_PATTERN.test('s:abc#../x')).toBe(false);
  });
});
