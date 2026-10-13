/* eslint-disable prettier/prettier */
import {
  PRODUCT_MAIN_BLOCK_TYPES,
  requiredCoreSectionTypesFor,
  buildCoreSections,
  findMissingCoreParts,
} from './core-sections.util';

describe('core-sections.util', () => {
  describe('requiredCoreSectionTypesFor', () => {
    it('requires product_main for every product template, regardless of templateKey', () => {
      expect(requiredCoreSectionTypesFor('product', 'default')).toEqual(['product_main']);
      expect(requiredCoreSectionTypesFor('product', 'minimal')).toEqual(['product_main']);
    });

    it('maps each page-bucket templateKey to its own core section(s)', () => {
      expect(requiredCoreSectionTypesFor('page', 'search')).toEqual(['search_results']);
      expect(requiredCoreSectionTypesFor('page', 'cart')).toEqual(['cart_items', 'cart_summary']);
      expect(requiredCoreSectionTypesFor('page', 'blog-index')).toEqual(['blog_post_list']);
      expect(requiredCoreSectionTypesFor('page', 'blog-article')).toEqual(['article_content']);
    });

    it('requires nothing for collection templates or an uncovered page templateKey', () => {
      expect(requiredCoreSectionTypesFor('collection', 'default')).toEqual([]);
      expect(requiredCoreSectionTypesFor('page', 'some-custom-starter')).toEqual([]);
    });
  });

  describe('buildCoreSections', () => {
    it('seeds product_main with all 7 required blocks enabled, plus the optional ones (rating on, the rest off)', () => {
      const sections = buildCoreSections('product', 'default');
      expect(sections).toHaveLength(1);
      expect(sections[0].type).toBe('product_main');
      const types = sections[0].blocks.map(b => b.type);
      for (const required of PRODUCT_MAIN_BLOCK_TYPES) expect(types).toContain(required);
      expect((sections[0].blocks as Array<{ type: string; enabled?: boolean }>).filter(b => (PRODUCT_MAIN_BLOCK_TYPES as readonly string[]).includes(b.type)).every(b => b.enabled === true)).toBe(true);
      const enabled = Object.fromEntries(sections[0].blocks.map(b => [b.type, b.enabled]));
      expect(enabled).toMatchObject({ product_rating: true, product_sku: false, product_wishlist: false, product_share: false, product_specs: false });
      // the rating is seeded right after the title, where it always showed
      expect(types.indexOf('product_rating')).toBe(types.indexOf('product_title') + 1);
    });

    it('seeds two blockless sections for the cart template, in order', () => {
      const sections = buildCoreSections('page', 'cart');
      expect(sections.map(s => s.type)).toEqual(['cart_items', 'cart_summary']);
      expect(sections.every(s => s.blocks.length === 0)).toBe(true);
    });

    it('seeds nothing for collection (unrelated, pre-existing seed lives elsewhere)', () => {
      expect(buildCoreSections('collection', 'default')).toEqual([]);
    });
  });

  describe('findMissingCoreParts', () => {
    it('flags a fully-missing required core section', () => {
      expect(findMissingCoreParts('page', 'search', [])).toEqual(['search_results']);
    });

    it('passes when the required section (with no required blocks) is present', () => {
      expect(findMissingCoreParts('page', 'search', [{ type: 'search_results' }])).toEqual([]);
    });

    it('flags each missing product_main block individually, by dotted name', () => {
      const sections = [{ type: 'product_main', blocks: [{ type: 'product_title' }, { type: 'product_price' }] }];
      const missing = findMissingCoreParts('product', 'default', sections);
      expect(missing).toContain('product_main.product_media');
      expect(missing).toContain('product_main.product_variant_picker');
      expect(missing).not.toContain('product_main.product_title');
      expect(missing).not.toContain('product_main.product_price');
    });

    it('passes when product_main carries all 7 required blocks (order-independent)', () => {
      const shuffled = [...PRODUCT_MAIN_BLOCK_TYPES].reverse().map(type => ({ type }));
      const sections = [{ type: 'product_main', blocks: shuffled }];
      expect(findMissingCoreParts('product', 'default', sections)).toEqual([]);
    });

    it('never flags anything for collection or an uncovered page templateKey', () => {
      expect(findMissingCoreParts('collection', 'default', [])).toEqual([]);
      expect(findMissingCoreParts('page', 'some-custom-starter', [])).toEqual([]);
    });
  });
});
