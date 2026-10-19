import { BadRequestException } from '@nestjs/common';
import { validateSections } from '../store-pages/store-pages.service';

describe('header and footer section groups', () => {
  it('accepts content strips (what the editor offers)', () => {
    expect(() => validateSections([
      { type: 'newsletter', settings: { heading: 'Stay in the loop' }, blocks: [] },
      { type: 'trust_badges', settings: {}, blocks: [{ type: 'trust_badge_item', settings: { icon: 'lock', text: 'Secure checkout' } }] },
    ] as any)).not.toThrow();
  });

  it('still rejects invalid settings inside such a section', () => {
    expect(() => validateSections([
      { type: 'trust_badges', settings: {}, blocks: [{ type: 'trust_badge_item', settings: { icon: 'nope', text: 'x' } }] },
    ] as any)).toThrow(BadRequestException);
  });
});

import { assertChromeSections } from './store-theme.service';

describe('assertChromeSections', () => {
  const strip = { type: 'marquee', settings: { speed: 'medium', direction: 'left', pauseOnHover: true }, blocks: [] };

  it('allows content strips', () => {
    expect(() => assertChromeSections([strip, { type: 'rich_text', settings: { heading: 'About' }, blocks: [] }] as any)).not.toThrow();
  });

  it('rejects sections that need a product, cart or page context', () => {
    for (const type of ['product_main', 'cart_items', 'collection_product_grid', 'search_results', 'featured_products']) {
      expect(() => assertChromeSections([{ type, settings: {}, blocks: [] }] as any)).toThrow(BadRequestException);
    }
  });

  it('caps the number of sections', () => {
    expect(() => assertChromeSections(Array.from({ length: 7 }, () => strip) as any)).toThrow(/at most 6/);
  });
});
