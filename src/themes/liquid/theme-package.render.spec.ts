import { renderThemePreview } from './theme-package.service';

describe('renderThemePreview', () => {
  it('renders section blocks, snippets, Shopify style/script tags, and common filters', async () => {
    const html = await renderThemePreview([
      {
        path: 'templates/index.json',
        encoding: 'utf8',
        content: JSON.stringify({
          order: ['main'],
          sections: {
            main: {
              type: 'main',
              settings: { title: 'Theme header' },
              blocks: { copy: { type: 'text', settings: { text: 'Block content' } } },
              block_order: ['copy'],
            },
          },
        }),
        size: 0,
        sha256: '',
      },
      {
        path: 'sections/main.liquid',
        encoding: 'utf8',
        content: '{% style %}.hero { color: red; }{% endstyle %}<div>{% render \'greeting\', label: section.settings.title %}{% content_for \'blocks\' %}</div>{% javascript %}window.themeReady = true;{% endjavascript %}',
        size: 0,
        sha256: '',
      },
      {
        path: 'snippets/greeting.liquid',
        encoding: 'utf8',
        content: '<h1>{{ label }}</h1>',
        size: 0,
        sha256: '',
      },
      {
        path: 'blocks/text.liquid',
        encoding: 'utf8',
        content: '<p>{{ block.settings.text }} | {{ 12345 | money_without_currency }} | {{ 12345 | money_without_trailing_zeros }} | {{ \'Foo Bar\' | handleize }} | {{ \'Baz Qux\' | handle }}</p>',
        size: 0,
        sha256: '',
      },
      {
        path: 'layout/theme.liquid',
        encoding: 'utf8',
        content: '<html><head>{% content_for_header %}</head><body>{{ content_for_layout }}</body></html>',
        size: 0,
        sha256: '',
      },
    ]);

    expect(html).toContain('<style>.hero { color: red; }</style>');
    expect(html).toContain('<script>window.themeReady = true;</script>');
    expect(html).toContain('<h1>Theme header</h1>');
    expect(html).toContain('<p>Block content | 123.45 | $123.45 | foo-bar | baz-qux</p>');
  });

  it('does not render hidden sections or hidden blocks', async () => {
    const html = await renderThemePreview([
      {
        path: 'templates/index.json',
        encoding: 'utf8',
        content: JSON.stringify({
          order: ['hidden', 'visible'],
          sections: {
            hidden: { type: 'main', disabled: true, settings: {}, blocks: {}, block_order: [] },
            visible: {
              type: 'main',
              settings: {},
              blocks: {
                visible: { type: 'text', settings: { text: 'Shown block' } },
                hidden: { type: 'text', disabled: true, settings: { text: 'Hidden block' } },
              },
              block_order: ['visible', 'hidden'],
            },
          },
        }),
        size: 0,
        sha256: '',
      },
      {
        path: 'sections/main.liquid',
        encoding: 'utf8',
        content: '<section>{% content_for \'blocks\' %}</section>',
        size: 0,
        sha256: '',
      },
      {
        path: 'blocks/text.liquid',
        encoding: 'utf8',
        content: '<p>{{ block.settings.text }}</p>',
        size: 0,
        sha256: '',
      },
    ]);

    expect(html).toContain('Shown block');
    expect(html).not.toContain('Hidden block');
    expect(html.match(/<section>/g)).toHaveLength(1);
  });

  it('resolves selected theme image assets through Shopify image filters', async () => {
    const html = await renderThemePreview([
      {
        path: 'templates/index.liquid',
        encoding: 'utf8',
        content: '<img src="{{ settings.hero | image_url }}"><img src="{{ \'hero.png\' | asset_url }}">',
        size: 0,
        sha256: '',
      },
      {
        path: 'assets/hero.png',
        encoding: 'base64',
        content: 'cG5n',
        size: 3,
        sha256: '',
      },
    ], { settings: { hero: 'assets/hero.png' } });

    expect(html.match(/data:image\/png;base64,cG5n/g)).toHaveLength(2);
  });

  it('resolves selected resource IDs to Shopify-shaped objects in sections and blocks', async () => {
    const product = { title: 'Selected product', handle: 'selected-product' };
    const collection = { title: 'Selected collection', handle: 'selected-collection' };
    const html = await renderThemePreview([
      {
        path: 'templates/index.json',
        encoding: 'utf8',
        content: JSON.stringify({
          order: ['main'],
          sections: {
            main: {
              type: 'main',
              settings: { featured: 'product-id', collections: ['collection-id'] },
              blocks: { product: { type: 'text', settings: { linked_product: 'product-id' } } },
              block_order: ['product'],
            },
          },
        }),
        size: 0,
        sha256: '',
      },
      {
        path: 'sections/main.liquid',
        encoding: 'utf8',
        content: '<h1>{{ section.settings.featured.title }}</h1>{% for collection in section.settings.collections %}<p>{{ collection.title }}</p>{% endfor %}{% content_for \'blocks\' %}',
        size: 0,
        sha256: '',
      },
      {
        path: 'blocks/text.liquid',
        encoding: 'utf8',
        content: '<p>{{ block.settings.linked_product.title }}</p>',
        size: 0,
        sha256: '',
      },
    ], { __resources: { 'product-id': product, 'collection-id': collection } });

    expect(html).toContain('<h1>Selected product</h1>');
    expect(html).toContain('<p>Selected collection</p>');
    expect(html).toContain('<p>Selected product</p>');
  });
});
