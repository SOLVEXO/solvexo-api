/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import {
  validateSectionSettings,
  validateBlockSettings,
  validateBlocksOfType,
  SECTION_ALLOWED_BLOCK_TYPES,
  MAX_BLOCKS_PER_SECTION,
  assertSectionCount,
} from './section-settings.validator';
import { SECTION_TYPES } from '../schemas/section.schema';

describe('section-settings.validator', () => {
  describe('Shopify limits (25 sections / 50 blocks)', () => {
    it('allows 25 sections and refuses 26 with a friendly message', () => {
      expect(() => assertSectionCount(25)).not.toThrow();
      expect(() => assertSectionCount(26)).toThrow('A page can have up to 25 sections');
      // a page saved under the old higher limit may be saved again while it does not grow
      expect(() => assertSectionCount(30, 30)).not.toThrow();
      expect(() => assertSectionCount(28, 30)).not.toThrow();
      expect(() => assertSectionCount(31, 30)).toThrow('A page can have up to 25 sections');
    });

    it('allows 50 blocks per section and refuses 51 with a friendly message', () => {
      const blocks = (n: number) => Array.from({ length: n }, () => ({ type: 'text', settings: {} }));
      expect(MAX_BLOCKS_PER_SECTION).toBe(50);
      expect(() => validateBlocksOfType(blocks(51), ['text'] as any)).toThrow('A section can have up to 50 blocks');
    });
  });

  it('accepts optional section spacing within the supported range', () => {
    expect(() => validateSectionSettings('rich_text', { spacingTop: 0, spacingBottom: 160 })).not.toThrow();
  });

  it('accepts inner padding in range and rejects it out of range', () => {
    expect(() => validateSectionSettings('rich_text', { paddingTop: 0, paddingBottom: 160 })).not.toThrow();
    expect(() => validateSectionSettings('rich_text', { paddingTop: 161 })).toThrow();
    expect(() => validateSectionSettings('rich_text', { paddingBottom: -4 })).toThrow();
  });

  it('space above/below is a margin: a minus number is allowed down to -160, inner space (padding) is not', () => {
    expect(() => validateSectionSettings('rich_text', { spacingTop: -40, spacingBottom: -160 })).not.toThrow();
    expect(() => validateSectionSettings('rich_text', { spacingTop: -161 })).toThrow();
    expect(() => validateSectionSettings('rich_text', { spacingBottom: -161 })).toThrow();
    expect(() => validateSectionSettings('rich_text', { paddingTop: -1 })).toThrow();
  });

  it.each([-161, 161, Number.NaN, '24'])('rejects invalid section spacing: %s', spacing => {
    expect(() => validateSectionSettings('rich_text', { spacingTop: spacing })).toThrow();
  });
  describe('design v2 (phone values, gradient/video, text style, motion, show-when rules)', () => {
    const ok = (settings: Record<string, any>) => expect(() => validateSectionSettings('rich_text', settings)).not.toThrow();
    const bad = (settings: Record<string, any>) => expect(() => validateSectionSettings('rich_text', settings)).toThrow(BadRequestException);

    it('phone-only spacing 0-160', () => {
      ok({ paddingTopMobile: 0, paddingBottomMobile: 160, spacingTopMobile: 8, spacingBottomMobile: 8 });
      bad({ paddingTopMobile: 161 });
      ok({ spacingTopMobile: -30, spacingBottomMobile: -1 }); // margins may be negative
      bad({ spacingBottomMobile: -161 });
      bad({ paddingTopMobile: -1 }); // padding may not
      bad({ spacingTopMobile: '8' });
    });
    it('gradient colours and angle', () => {
      ok({ gradientFrom: '#112233', gradientTo: '#AABBCC', gradientAngle: 90 });
      bad({ gradientFrom: 'red' });
      bad({ gradientTo: '#12345' });
      bad({ gradientAngle: 361 });
    });
    it('background video: https link without quotes or brackets', () => {
      ok({ backgroundVideoUrl: 'https://cdn.example.com/a/b.mp4' });
      ok({ backgroundVideoUrl: '' });
      bad({ backgroundVideoUrl: 'http://cdn.example.com/a.mp4' });
      bad({ backgroundVideoUrl: 'https://cdn.example.com/a.mp4" onload="x' });
      bad({ backgroundVideoUrl: 'https://cdn.example.com/a b.mp4' });
      bad({ backgroundVideoUrl: 'javascript:alert(1)' });
    });
    it('text style choices and colours', () => {
      ok({ textAlign: 'center', textAlignMobile: 'default', headingWeight: 'bold', headingCase: 'none', textColor: '#111111', headingColor: '#222222' });
      bad({ textAlign: 'justify' });
      bad({ headingWeight: 'heavy' });
      bad({ headingCase: 'lower' });
      bad({ textColor: 'blue' });
    });
    it('entrance animation, sticky', () => {
      ok({ animation: 'slide-up', animationSpeed: 'slow', animationDelay: 2000, sticky: true, stickyOffset: 72 });
      bad({ animation: 'spin' });
      bad({ animationSpeed: 'warp' });
      bad({ animationDelay: 2001 });
      bad({ sticky: 'yes' });
      bad({ stickyOffset: 301 });
    });
    it('show-when rules', () => {
      ok({ showTo: 'customers', showFrom: '2026-12-01T04:30:00.000Z', showUntil: '2026-12-31T19:00:00.000Z', showCountries: 'PK, AE', hideCountries: 'US', showLanguages: 'en, ur, pt-BR' });
      ok({ showFrom: '', showUntil: null });
      bad({ showTo: 'vip' });
      bad({ showFrom: 'tomorrow-ish' });
      bad({ showCountries: 'Pakistan' });
      bad({ hideCountries: 'US;<script>' });
      bad({ showLanguages: 'english' });
    });
  });
  describe('featured products: rule-based lists', () => {
    const ok = (settings: Record<string, any>) => expect(() => validateSectionSettings('featured_products', settings)).not.toThrow();
    const bad = (settings: Record<string, any>) => expect(() => validateSectionSettings('featured_products', settings)).toThrow(BadRequestException);

    it('accepts the rules source with every rule, and leaves older sources alone', () => {
      ok({ source: 'rules' });
      ok({ source: 'rules', ruleTags: ['summer', 'sale'], ruleVendors: ['Nike'], rulePriceMin: 10, rulePriceMax: 100, ruleType: 'physical', ruleStock: 'in_stock', ruleOnSale: true, ruleSort: 'price_asc', limit: 12 });
      ok({ source: 'rules', rulePriceMin: null, ruleTags: null });
      ok({ source: 'bestsellers', hideSoldOut: true });
      ok({ source: 'newArrivals' });
      ok({ source: 'category', categoryId: 'c1' });
    });
    it('tags and vendors: a short list of plain values', () => {
      bad({ source: 'rules', ruleTags: 'summer' });
      bad({ source: 'rules', ruleTags: ['a,b'] });
      bad({ source: 'rules', ruleTags: ['<b>'] });
      bad({ source: 'rules', ruleVendors: [''] });
      bad({ source: 'rules', ruleTags: Array.from({ length: 21 }, (_, i) => 't' + i) });
    });
    it('price range: numbers, low not above high', () => {
      bad({ source: 'rules', rulePriceMin: -1 });
      bad({ source: 'rules', rulePriceMax: '5' });
      bad({ source: 'rules', rulePriceMin: 50, rulePriceMax: 10 });
    });
    it('choices and switches', () => {
      bad({ source: 'rules', ruleType: 'bundle' });
      bad({ source: 'rules', ruleStock: 'out_of_stock' });
      bad({ source: 'rules', ruleSort: 'random' });
      bad({ source: 'rules', ruleOnSale: 'yes' });
      bad({ source: 'rules', hideSoldOut: 1 });
      bad({ source: 'unknown' });
    });
  });
  describe('navigation items: badge, show-when rules, mega panel columns and promo cards', () => {
    const base = { label: 'Shop', linkType: 'home' };
    const promo = { imageUrl: 'https://cdn.example.com/a.jpg', title: 'Summer sale', text: 'Up to 50% off', buttonLabel: 'Shop now', link: { linkType: 'collection', collectionId: 'c1' } };
    const ok = (extra: Record<string, any>) => expect(() => validateBlockSettings('nav_link', { ...base, ...extra })).not.toThrow();
    const bad = (extra: Record<string, any>, re?: RegExp) => {
      if (re) expect(() => validateBlockSettings('nav_link', { ...base, ...extra })).toThrow(re);
      else expect(() => validateBlockSettings('nav_link', { ...base, ...extra })).toThrow(BadRequestException);
    };

    it('accepts a badge, the show-when rules and the mega options', () => {
      ok({});
      ok({ badge: 'New', badgeColor: '#ff0000', showTo: 'customers', showFrom: '2026-12-01T04:30:00.000Z', showUntil: '2026-12-31T19:00:00.000Z', showCountries: 'PK, AE', hideCountries: 'US', showLanguages: 'en, ur' });
      ok({ badge: '', badgeColor: '', showTo: null });
      ok({ menuStyle: 'mega', megaColumns: 4, megaPromos: [promo, { title: 'Only a title' }] });
      ok({ children: [{ label: 'Kids', linkType: 'home', badge: 'Hot', showTo: 'guests', children: [{ label: 'Boys', linkType: 'home', badge: 'Sale' }] }] });
    });
    it('badge: short, plain text, a real colour', () => {
      bad({ badge: 'x'.repeat(13) }, /badge/);
      bad({ badge: '<b>' }, /badge/);
      bad({ badgeColor: 'red' }, /badgeColor/);
    });
    it('show-when rules: the same checks sections use', () => {
      bad({ showTo: 'vip' }, /showTo/);
      bad({ showFrom: 'soon' }, /showFrom/);
      bad({ showCountries: 'Pakistan' }, /showCountries/);
      bad({ showLanguages: 'english' }, /showLanguages/);
    });
    it('mega columns 0-6 and at most two promo cards with only known fields', () => {
      bad({ megaColumns: 7 }, /megaColumns/);
      bad({ megaColumns: 2.5 }, /megaColumns/);
      bad({ megaPromos: [promo, promo, promo] }, /at most 2/);
      bad({ megaPromos: [{ title: 'x', onclick: 'a()' }] }, /not a promo card field/);
      bad({ megaPromos: [{ imageUrl: 'http://x.com/a.jpg', title: 't' }] }, /https/);
      bad({ megaPromos: [{ text: 'no picture or title' }] }, /picture or a title/);
      bad({ megaPromos: [{ title: '<script>' }] }, /title/);
      bad({ megaPromos: [{ title: 't', link: { linkType: 'external', url: 'javascript:alert(1)' } }] }, /https/);
      bad({ megaPromos: [{ title: 't', link: { linkType: 'collection' } }] }, /collectionId/);
    });
    it('mega options belong to the top-level item, and a child badge is checked too', () => {
      bad({ children: [{ label: 'Kids', linkType: 'home', megaColumns: 3 }] }, /top-level/);
      bad({ children: [{ label: 'Kids', linkType: 'home', megaPromos: [promo] }] }, /top-level/);
      bad({ children: [{ label: 'Kids', linkType: 'home', badge: 'y'.repeat(20) }] }, /children.*badge/);
    });
  });
  describe('Shopify-parity library sections', () => {
    it('multicolumn / logo_list / marquee / image_banner accept valid settings and reject bad ones', () => {
      expect(() => validateSectionSettings('multicolumn', { columns: 3, textAlign: 'center', imageRatio: 'square' })).not.toThrow();
      expect(() => validateSectionSettings('multicolumn', { columns: 5 })).not.toThrow();
      expect(() => validateSectionSettings('multicolumn', { columns: 9 })).toThrow(BadRequestException);
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
      expect(() => validateBlockSettings('collection_item', { collectionId: 'abc', title: 'Pre-Primary', icon: 'book', ctaText: 'Shop', ctaLink: { linkType: 'home' } })).not.toThrow();
      expect(() => validateBlockSettings('collection_item', { imageUrl: 'http://insecure' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('collection_item', { title: 'x'.repeat(121) })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('marquee_item', { text: 'Free shipping' })).not.toThrow();
      expect(() => validateBlockSettings('marquee_item', { text: '' })).toThrow(BadRequestException);
    });
  });

  it('related_products (Product Recommendations): every source validates, older sections without one still pass', () => {
    // Sections saved before `source` existed must keep saving.
    expect(() => validateSectionSettings('related_products', { heading: 'You may also like', columns: 4, limit: 4 })).not.toThrow();
    expect(() => validateSectionSettings('related_products', { source: 'related' })).not.toThrow();
    expect(() => validateSectionSettings('related_products', { source: 'complementary', limit: 3, columns: 3 })).not.toThrow();
    expect(() => validateSectionSettings('related_products', { source: 'category', categoryId: 'cat1' })).not.toThrow();
    expect(() => validateSectionSettings('related_products', { source: 'collection', collectionId: 'col1' })).not.toThrow();
    expect(() => validateSectionSettings('related_products', { source: 'manual', productIds: ['p1', 'p2'] })).not.toThrow();
    // Rejected
    expect(() => validateSectionSettings('related_products', { source: 'random' })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('related_products', { source: 'category' })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('related_products', { source: 'collection' })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('related_products', { source: 'manual', productIds: 'p1' })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('related_products', { source: 'manual', productIds: Array.from({ length: 25 }, (_, i) => `p${i}`) })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('related_products', { source: 'manual', productIds: [1, 2] })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('related_products', { limit: 1 })).toThrow(BadRequestException);
    expect(() => validateSectionSettings('related_products', { columns: 5 })).not.toThrow();
    expect(() => validateSectionSettings('related_products', { columns: 0 })).toThrow(BadRequestException);
  });

  it('validates configurable grid columns and filter visibility', () => {
    expect(() => validateSectionSettings('featured_products', { source: 'bestsellers', columns: 4 })).not.toThrow();
    expect(() => validateSectionSettings('featured_category_grid', { categoryIds: ['c1'], columns: 2 })).not.toThrow();
    expect(() => validateSectionSettings('product_catalog', { columns: 3, showFilters: false })).not.toThrow();
    // Columns is a free number box: any whole number from 1 to 8
    for (const ok of [1, 5, 6, 8]) expect(() => validateSectionSettings('featured_products', { source: 'bestsellers', columns: ok })).not.toThrow();
    for (const bad of [0, 9, 2.5, '4']) expect(() => validateSectionSettings('featured_products', { source: 'bestsellers', columns: bad })).toThrow();
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
        // A theme-owned section must name which of the theme's own sections it is.
        theme_section: { sectionKey: 'hero' },
        saved_section: { savedSectionId: '0123456789abcdef01234567' },
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

    it('featured_products: hand-picked list may be empty while choosing, max 24 string ids', () => {
      expect(() => validateSectionSettings('featured_products', { source: 'manual' })).not.toThrow();
      expect(() => validateSectionSettings('featured_products', { source: 'manual', productIds: [] })).not.toThrow();
      expect(() => validateSectionSettings('featured_products', { source: 'manual', productIds: Array(25).fill('p') })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('featured_products', { source: 'manual', productIds: [1, 2] })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('featured_products', { source: 'pinned', productIds: ['p1'] })).not.toThrow();
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
      expect(() => validateSectionSettings('product_catalog', { columns: 9 })).toThrow(BadRequestException); // columns are 1-8 since main's 7b90f79
      expect(() => validateSectionSettings('product_catalog', { columns: 5 })).not.toThrow();
      expect(() => validateSectionSettings('product_catalog', { columns: 3 })).not.toThrow();
    });

    it('featured_category_grid: 0-12 categoryIds (empty = freshly added, renders nothing)', () => {
      expect(() => validateSectionSettings('featured_category_grid', { categoryIds: [] })).not.toThrow();
      expect(() => validateSectionSettings('featured_category_grid', {})).not.toThrow();
      expect(() => validateSectionSettings('featured_category_grid', { categoryIds: 'c1' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('featured_category_grid', { categoryIds: Array(13).fill('c') })).toThrow(BadRequestException);
    });

    it('video: an empty, freshly added section is allowed', () => {
      expect(() => validateSectionSettings('video', {})).not.toThrow();
    });

    it('faq: source is blocks or store', () => {
      expect(() => validateSectionSettings('faq', { source: 'store' })).not.toThrow();
      expect(() => validateSectionSettings('faq', { source: 'blocks' })).not.toThrow();
      expect(() => validateSectionSettings('faq', { source: 'other' })).toThrow(BadRequestException);
    });

    it('common design settings: show-on, full width, background, anchor and scoped CSS', () => {
      const ok = { visibility: 'mobile', fullWidth: true, backgroundImageUrl: 'https://cdn.x/a.jpg', backgroundOverlay: 40, anchorId: 'our-story', customCss: 'h2 { color: red; }' };
      expect(() => validateSectionSettings('rich_text', ok)).not.toThrow();
      expect(() => validateSectionSettings('rich_text', { visibility: 'tv' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('rich_text', { fullWidth: 'yes' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('rich_text', { backgroundImageUrl: 'javascript:alert(1)' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('rich_text', { backgroundOverlay: 90 })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('rich_text', { anchorId: 'bad id!' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('rich_text', { customCss: '</style><script>x</script>' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('rich_text', { customCss: 'a { background: url(javascript:x) }' })).toThrow(BadRequestException);
    });

    it('copy overrides: text with a length cap, showEyebrow boolean', () => {
      expect(() => validateSectionSettings('newsletter', { eyebrow: 'Join us', buttonLabel: 'Join', showEyebrow: false })).not.toThrow();
      expect(() => validateSectionSettings('newsletter', { eyebrow: 'x'.repeat(61) })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('newsletter', { buttonLabel: 5 })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('newsletter', { showEyebrow: 'no' })).toThrow(BadRequestException);
    });

    it('rich text bodies (multirow row, image with text, column, paragraph): long editor HTML ok, unsafe markup refused', () => {
      const html = '<h2>Our story</h2>' + '<p>Paragraph text.</p>'.repeat(200);
      expect(html.length).toBeGreaterThan(1000);
      for (const type of ['multirow_row', 'multicolumn_column'] as const) {
        expect(() => validateBlockSettings(type, { body: html })).not.toThrow();
        expect(() => validateBlockSettings(type, { body: 'x'.repeat(20001) })).toThrow(BadRequestException);
        expect(() => validateBlockSettings(type, { body: '<p onclick="x()">hi</p>' })).toThrow(BadRequestException);
        expect(() => validateBlockSettings(type, { body: '<script>alert(1)</script>' })).toThrow(BadRequestException);
        expect(() => validateBlockSettings(type, { body: '<a href="javascript:alert(1)">x</a>' })).toThrow(BadRequestException);
      }
      expect(() => validateBlockSettings('image_text_pair', { imageUrl: 'https://a.com/i.jpg', body: html })).not.toThrow();
      expect(() => validateBlockSettings('paragraph', { text: html })).not.toThrow();
      expect(() => validateBlockSettings('paragraph', { text: '<iframe src="https://x"></iframe>' })).toThrow(BadRequestException);
      // plain text that merely mentions the word is fine
      expect(() => validateBlockSettings('paragraph', { text: 'Learn javascript: it is fun' })).not.toThrow();
    });

    it('category_product_grid (the Category page grid): same settings as the collection grid, columns 1 to 8', () => {
      expect(() => validateSectionSettings('category_product_grid', { defaultSort: 'price_asc', columns: 6, showFilters: false })).not.toThrow();
      expect(() => validateSectionSettings('category_product_grid', { columns: 9 })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('category_product_grid', { defaultSort: 'random' })).toThrow(BadRequestException);
    });

    it('hero: custom height, image fit and max width', () => {
      expect(() => validateSectionSettings('hero', { heightPreset: 'custom', customHeight: 600, mobileHeightPreset: 'custom', mobileCustomHeight: 380, imageFit: 'whole', maxWidth: 1200 })).not.toThrow();
      for (const bad of [{ customHeight: 100 }, { customHeight: 1500 }, { customHeight: 600.5 }, { mobileCustomHeight: '400' }, { maxWidth: 100 }, { maxWidth: 3000 }, { imageFit: 'stretch' }, { heightPreset: 'huge' }]) {
        expect(() => validateSectionSettings('hero', bad as never)).toThrow(BadRequestException);
      }
    });

    it('video: accepts any https:// link, rejects non-https schemes', () => {
      expect(() => validateSectionSettings('video', { videoUrl: 'https://example.com/clip.mp4' })).not.toThrow();
      expect(() => validateSectionSettings('video', { videoUrl: 'http://example.com/clip.mp4' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('video', { videoUrl: 'javascript:alert(1)' })).toThrow(BadRequestException);
      expect(() => validateSectionSettings('video', { videoUrl: 'https://vimeo.com/12345' })).not.toThrow();
    });

    it('collection_product_grid: rejects an invalid columns/defaultSort/showFilters value, accepts a valid one', () => {
      expect(() => validateSectionSettings('collection_product_grid', { columns: 9 })).toThrow(BadRequestException); // 1-8 since main's 7b90f79
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

  describe('Main Product added blocks', () => {
    it('variant picker style: buttons, dropdown, colour swatches or picture tiles', () => {
      for (const pickerStyle of ['pills', 'dropdown', 'swatches', 'images']) {
        expect(() => validateBlockSettings('product_variant_picker', { pickerStyle })).not.toThrow();
      }
      expect(() => validateBlockSettings('product_variant_picker', { pickerStyle: 'grid' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_variant_picker', {})).not.toThrow();
    });
    it('swatch shape and size', () => {
      expect(() => validateBlockSettings('product_variant_picker', { pickerStyle: 'swatches', swatchShape: 'square', swatchSize: 'lg' })).not.toThrow();
      expect(() => validateBlockSettings('product_variant_picker', { swatchShape: 'hexagon' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_variant_picker', { swatchSize: 'huge' })).toThrow(BadRequestException);
    });
    it('collapsible tab needs a title; size chart image must be https', () => {
      expect(() => validateBlockSettings('product_collapsible_tab', { title: 'Care', content: 'Wash cold' })).not.toThrow();
      expect(() => validateBlockSettings('product_collapsible_tab', { content: 'x' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_size_chart', { imageUrl: 'http://x/a.png' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_size_chart', { label: 'Sizes', content: 'S M L' })).not.toThrow();
      expect(() => validateBlockSettings('product_buy_now', { label: 'x'.repeat(41) })).toThrow(BadRequestException);
    });
    it('pickup block: optional heading up to 60 characters', () => {
      expect(() => validateBlockSettings('product_share', {})).not.toThrow();
      expect(() => validateBlockSettings('product_share', { linkedin: 'show', x: 'hide' })).not.toThrow();
      expect(() => validateBlockSettings('product_share', { telegram: 'maybe' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_share', { customLinks: 'Reddit | https://www.reddit.com/submit?url={url}&title={title}' })).not.toThrow();
      expect(() => validateBlockSettings('product_share', { customLinks: 'Bad | http://x.com/?u={url}' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_share', { customLinks: 'NoUrl | https://x.com/' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_questions', { heading: 'Ask us', showForm: false })).not.toThrow();
      expect(() => validateBlockSettings('product_questions', { showForm: 'yes' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_frequently_bought', { heading: 'Bought together', maxItems: 2, buttonLabel: 'Add all' })).not.toThrow();
      expect(() => validateBlockSettings('product_frequently_bought', { maxItems: 5 })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_frequently_bought', { maxItems: 1.5 })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_trust_badges', { layout: 'grid', style: 'boxed', items: [{ icon: 'truck', title: 'Free shipping', text: 'Over $50' }] })).not.toThrow();
      expect(() => validateBlockSettings('product_trust_badges', { items: [{ icon: 'rocket', title: 'x' }] })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_trust_badges', { items: Array.from({ length: 7 }, () => ({ icon: 'check', title: 'x' })) })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_trust_badges', { layout: 'diagonal' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_media', { layout: 'grid', aspect: 'square', zoom: false })).not.toThrow();
      expect(() => validateBlockSettings('product_media', { layout: 'carousel' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_media', { zoom: 'yes' })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_pickup', {})).not.toThrow();
      expect(() => validateBlockSettings('product_pickup', { heading: 'Collect in store' })).not.toThrow();
      expect(() => validateBlockSettings('product_pickup', { heading: 'x'.repeat(61) })).toThrow(BadRequestException);
    });
    it('text block: short note, size small/medium/large', () => {
      expect(() => validateBlockSettings('product_text', { text: 'Free returns within 14 days', size: 'small' })).not.toThrow();
      expect(() => validateBlockSettings('product_text', {})).not.toThrow();
      expect(() => validateBlockSettings('product_text', { text: 'x'.repeat(1001) })).toThrow(BadRequestException);
      expect(() => validateBlockSettings('product_text', { size: 'huge' })).toThrow(BadRequestException);
    });
  });
});
