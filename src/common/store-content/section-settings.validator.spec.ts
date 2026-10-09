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
  it('accepts optional section spacing within the supported range', () => {
    expect(() => validateSectionSettings('rich_text', { spacingTop: 0, spacingBottom: 160 })).not.toThrow();
  });

  it.each([-1, 161, Number.NaN, '24'])('rejects invalid section spacing: %s', spacing => {
    expect(() => validateSectionSettings('rich_text', { spacingTop: spacing })).toThrow();
  });
  describe('Shopify-parity library sections', () => {
    it('multicolumn / logo_list / marquee / image_banner accept valid settings and reject bad ones', () => {
      expect(() => validateSectionSettings('multicolumn', { columns: 3, textAlign: 'center', imageRatio: 'square' })).not.toThrow();
      expect(() => validateSectionSettings('multicolumn', { columns: 5 })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('logo_list', { logoHeight: 48, grayscale: true })).not.toThrow();
      expect(() => validateSectionSettings('logo_list', { logoHeight: 10 })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('marquee', { speed: 'fast', direction: 'right' })).not.toThrow();
      expect(() => validateSectionSettings('marquee', { speed: 'warp' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('image_banner', { imageUrl: 'https://x.test/a.jpg', overlayOpacity: 30, textColor: '#fff' })).not.toThrow();
      expect(() => validateSectionSettings('image_banner', { imageUrl: 'javascript:alert(1)' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('image_banner', { overlayOpacity: 90 })).toThrow(BadRequestException);
    });

    it('custom_html rejects scripts, iframes, forms, event handlers and javascript: links', () => {
      expect(() => validateSectionSettings('custom_html', { html: '<h2 style="color:red">Hi</h2><p>ok</p>' })).not.toThrow();
      for (const html of ['<script>alert(1)</script>', '<iframe src="https://x"></iframe>', '<form></form>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>']) {
        expect(() => validateSectionSettings('custom_html', { html })).toThrow(BadRequestException);
      }
      expect(() => validateSectionSettings('custom_html', { html: 'x'.repeat(20001) })).toThrow(BadRequestException);
    });

    it('validates the new block types', () => {
      expect(() => validateBlockSettings('multicolumn_column', { heading: 'Fast', body: 'text', ctaText: 'Go', ctaLink: { linkType: 'home' } })).not.toThrow();
      expect(() => validateBlockSettings('multicolumn_column', { imageUrl: 'http://insecure' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('logo_item', { imageUrl: 'https://x.test/l.png' })).not.toThrow();
      expect(() => validateBlockSettings('logo_item', {})).toThrow(BadRequestException);
      expect(() => validateBlockSettings('marquee_item', { text: 'Free shipping' })).not.toThrow();
      expect(() => validateBlockSettings('marquee_item', { text: '' })).toThrow(BadRequestException);
    });
  });

  it('validates configurable grid columns and filter visibility', () => {
    expect(() => validateSectionSettings('featured_products', { source: 'bestsellers', columns: 4 })).not.toThrow();
    expect(() => validateSectionSettings('featured_category_grid', { categoryIds: ['c1'], columns: 2 })).not.toThrow();
    expect(() => validateSectionSettings('product_catalog', { columns: 3, showFilters: false })).not.toThrow();
    expect(() => validateSectionSettings('featured_products', { source: 'bestsellers', columns: 5 })).toThrow();
    expect(() => validateSectionSettings('product_catalog', { showFilters: 'no' })).toThrow();
  });
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
        metaobject_list: { metaobjectType: 'team_member' },
        editorial_lookbook: {},
        farm_story: {},
        drop_countdown: {},
        craft_process: {},
        tech_specs_compare: {},
        soft_gallery: {},
        feature_list: {},
        team_grid: {},
        stats_counter: {},
        gallery_grid: {},
      };
      for (const type of SECTION_TYPES) {
        // `?? {}` — a section type not yet listed above (this map has
        // drifted from SECTION_TYPES more than once as new section types
        // were added) now fails with validateSectionSettings' own clear
        // BadRequestException for a genuinely-required field, instead of a
        // confusing "Cannot read properties of undefined" from indexing a
        // missing map entry — a real type still needing an entry here shows
        // up as an actionable assertion failure either way.
        expect(() => validateSectionSettings(type, minimalSettings[type] ?? {})).not.toThrow();
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

    it('hero: accepts the image-fit / slideshow settings and rejects bad values', () => {
      expect(() => validateSectionSettings('hero', {
        heightPreset: 'adapt', mobileHeightPreset: 'same', mobileTextLayout: 'below',
        autoplay: true, autoplaySeconds: 5, showArrows: false, showPauseButton: false, pagination: 'dots', transition: 'fade',
      })).not.toThrow();
      expect(() => validateSectionSettings('hero', { heightPreset: 'huge' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('hero', { mobileHeightPreset: 'tiny' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('hero', { mobileTextLayout: 'side' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('hero', { showPauseButton: 'yes' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('hero', { autoplaySeconds: 2 })).toThrow(BadRequestException);
    });

    it('featured_category_grid / blog_posts: validate imageRatio', () => {
      expect(() => validateSectionSettings('featured_category_grid', { categoryIds: ['c1'], imageRatio: 'adapt' })).not.toThrow();
      expect(() => validateSectionSettings('featured_category_grid', { categoryIds: ['c1'], imageRatio: 'wide' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('blog_posts', { imageRatio: 'portrait' })).not.toThrow();
      expect(() => validateSectionSettings('blog_posts', { imageRatio: 'banner' })).toThrow(BadRequestException);
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

    it('video: accepts any https:// link, rejects non-https schemes', () => {
      expect(() => validateSectionSettings('video', { videoUrl: 'https://example.com/clip.mp4' })).not.toThrow();
      expect(() => validateSectionSettings('video', { videoUrl: 'http://example.com/clip.mp4' })).toThrow(BadRequestException);
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

    it('nav_link: accepts three navigation levels and rejects a fourth', () => {
      const levelThree = {
        label: 'Shop', linkType: 'home', children: [{
          label: 'Clothing', linkType: 'home', children: [{ label: 'Shirts', linkType: 'home' }],
        }],
      };
      expect(() => validateBlockSettings('nav_link', levelThree)).not.toThrow();
      expect(() => validateBlockSettings('nav_link', {
        ...levelThree,
        children: [{ label: 'Clothing', linkType: 'home', children: [{
          label: 'Shirts', linkType: 'home', children: [{ label: 'T-shirts', linkType: 'home' }],
        }] }],
      })).toThrow(BadRequestException);
    });

    it('nav_link: accepts menuStyle dropdown|mega and rejects anything else', () => {
      const base = { label: 'Shop', linkType: 'home' };
      expect(() => validateBlockSettings('nav_link', { ...base, menuStyle: 'mega' })).not.toThrow();
      expect(() => validateBlockSettings('nav_link', { ...base, menuStyle: 'dropdown' })).not.toThrow();
      expect(() => validateBlockSettings('nav_link', { ...base, menuStyle: 'fullscreen' })).toThrow(BadRequestException);
    });

    it('nav_link: mega tile imageUrl must be https (or empty) on every level', () => {
      const withImage = (imageUrl: unknown) => ({
        label: 'Shop', linkType: 'home', menuStyle: 'mega', imageUrl,
        children: [{ label: 'Room', linkType: 'home', imageUrl, children: [{ label: 'Sofas', linkType: 'home', imageUrl }] }],
      });
      expect(() => validateBlockSettings('nav_link', withImage('https://cdn.example.com/a.jpg'))).not.toThrow();
      expect(() => validateBlockSettings('nav_link', withImage(''))).not.toThrow();
      expect(() => validateBlockSettings('nav_link', withImage(null))).not.toThrow();
      expect(() => validateBlockSettings('nav_link', withImage('javascript:alert(1)'))).toThrow(BadRequestException);
      expect(() => validateBlockSettings('nav_link', {
        label: 'Shop', linkType: 'home',
        children: [{ label: 'Room', linkType: 'home', children: [{ label: 'Sofas', linkType: 'home', imageUrl: 'http://insecure.example.com/a.jpg' }] }],
      })).toThrow(BadRequestException);
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

    it('hero_slide / image_text_pair: validate focalPoint, imageRatio, overlay and text colour', () => {
      const img = { imageUrl: 'https://example.com/a.png' };
      expect(() => validateBlockSettings('hero_slide', { ...img, focalPoint: 'top left', contentAlign: 'center', overlayOpacity: 40, textColor: '#ffffff' })).not.toThrow();
      expect(() => validateBlockSettings('hero_slide', { ...img, focalPoint: 'middle' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('hero_slide', { ...img, overlayOpacity: 90 })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('hero_slide', { ...img, textColor: 'red' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('image_text_pair', { ...img, imageRatio: 'adapt', focalPoint: 'bottom' })).not.toThrow();
      expect(() => validateBlockSettings('image_text_pair', { ...img, imageRatio: 'tall' })).toThrow(BadRequestException);
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
