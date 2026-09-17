/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import {
  validateSectionSettings,
  validateBlockSettings,
  validateBlocksOfType,
  SECTION_ALLOWED_BLOCK_TYPES,
} from './section-settings.validator';
import { SECTION_TYPES } from '../schemas/section.schema';

describe('section-settings.validator', () => {
  describe('validateSectionSettings — behavior preserved through the typed-cast refactor', () => {
    it('accepts every real SectionType with a minimally-valid settings object (exhaustiveness guard never fires for a real type)', () => {
      const minimalSettings: Record<string, Record<string, any>> = {
        hero: {},
        rich_text: {},
        featured_products: { source: 'bestsellers' },
        product_catalog: {},
        image_with_text: {},
        testimonials: {},
        faq: {},
        video: { videoUrl: 'https://www.youtube.com/watch?v=abc' },
        featured_category_grid: { categoryIds: ['c1'] },
        trust_badges: {},
        newsletter: {},
        collection_product_grid: {},
      };
      for (const type of SECTION_TYPES) {
        expect(() => validateSectionSettings(type, minimalSettings[type])).not.toThrow();
      }
    });

    it('rejects a heading over 120 characters on any section type', () => {
      expect(() => validateSectionSettings('hero', { heading: 'x'.repeat(121) })).toThrow(BadRequestException);
    });

    it('featured_products: requires productIds (non-empty, <=24) when source is "manual"', () => {
      expect(() => validateSectionSettings('featured_products', { source: 'manual' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('featured_products', { source: 'manual', productIds: [] })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('featured_products', { source: 'manual', productIds: Array(25).fill('p') })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('featured_products', { source: 'manual', productIds: ['p1', 'p2'] })).not.toThrow();
    });

    it('featured_products: requires categoryId/collectionId only for their matching source', () => {
      expect(() => validateSectionSettings('featured_products', { source: 'category' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('featured_products', { source: 'category', categoryId: 'c1' })).not.toThrow();
      expect(() => validateSectionSettings('featured_products', { source: 'collection' })).toThrow(BadRequestException);
    });

    it('product_catalog: rejects setting both categoryId and collectionId at once', () => {
      expect(() =>
        validateSectionSettings('product_catalog', { categoryId: 'c1', collectionId: 'col1' }),
      ).toThrow(BadRequestException);
    });

    it('product_catalog: rejects an invalid columns value', () => {
      expect(() => validateSectionSettings('product_catalog', { columns: 5 })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('product_catalog', { columns: 3 })).not.toThrow();
    });

    it('featured_category_grid: requires 1-12 categoryIds', () => {
      expect(() => validateSectionSettings('featured_category_grid', { categoryIds: [] })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('featured_category_grid', { categoryIds: Array(13).fill('c') })).toThrow(BadRequestException);
    });

    it('video: requires a YouTube/Vimeo https:// link, rejects anything else', () => {
      expect(() => validateSectionSettings('video', { videoUrl: 'https://evil.example.com/x' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('video', { videoUrl: 'javascript:alert(1)' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('video', { videoUrl: 'https://vimeo.com/12345' })).not.toThrow();
    });

    it('collection_product_grid: rejects an invalid columns/defaultSort/showFilters value, accepts a valid one', () => {
      expect(() => validateSectionSettings('collection_product_grid', { columns: 5 })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('collection_product_grid', { defaultSort: 'random' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('collection_product_grid', { showFilters: 'yes' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('collection_product_grid', { columns: 3, defaultSort: 'newest', showFilters: true })).not.toThrow();
    });
  });

  describe('validateBlockSettings', () => {
    it('nav_link: rejects a javascript:/data: URL for an external link (the XSS guard)', () => {
      expect(() =>
        validateBlockSettings('nav_link', { label: 'Home', linkType: 'external', url: 'javascript:alert(1)' }),
      ).toThrow(BadRequestException);
    });

    it('nav_link: accepts a real https:// external link', () => {
      expect(() =>
        validateBlockSettings('nav_link', { label: 'Docs', linkType: 'external', url: 'https://example.com' }),
      ).not.toThrow();
    });

    it('footer_column: validates each nested link recursively as a nav_link', () => {
      expect(() =>
        validateBlockSettings('footer_column', {
          heading: 'Company',
          links: [{ label: 'About', linkType: 'external', url: 'javascript:alert(1)' }],
        }),
      ).toThrow(BadRequestException);
    });

    it('hero_slide: rejects a non-https imageUrl', () => {
      expect(() => validateBlockSettings('hero_slide', { imageUrl: 'http://insecure.example.com/a.png' })).toThrow(BadRequestException);
    });

    it('testimonial: rejects a rating outside 1-5', () => {
      expect(() =>
        validateBlockSettings('testimonial', { quote: 'Great!', authorName: 'A', rating: 6 }),
      ).toThrow(BadRequestException);
    });

    it('throws a clear error for a genuinely unknown block type (the real runtime guard — not a compile-time concern)', () => {
      expect(() => validateBlockSettings('not_a_real_block_type', {})).toThrow(BadRequestException);
    });
  });

  describe('SECTION_ALLOWED_BLOCK_TYPES / validateBlocksOfType', () => {
    it('rejects a block type that is not on the section\'s allow-list', () => {
      expect(() =>
        validateBlocksOfType([{ type: 'faq_item', settings: { question: 'Q', answer: 'A' } }], SECTION_ALLOWED_BLOCK_TYPES.hero),
      ).toThrow(BadRequestException);
    });

    it('accepts a block type that is on the allow-list', () => {
      expect(() =>
        validateBlocksOfType(
          [{ type: 'hero_slide', settings: { imageUrl: 'https://example.com/a.png' } }],
          SECTION_ALLOWED_BLOCK_TYPES.hero,
        ),
      ).not.toThrow();
    });

    it('every SectionType has an (possibly empty) entry in the allow-list map', () => {
      for (const type of SECTION_TYPES) {
        expect(SECTION_ALLOWED_BLOCK_TYPES[type]).toBeDefined();
      }
    });
  });
});
