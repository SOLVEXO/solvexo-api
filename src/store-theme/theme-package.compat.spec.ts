import { buildStoredZip, readThemeZip, renderThemePreview, validateThemePackage } from './theme-package.service';

const f = (path: string, content: string) => ({ path, encoding: 'utf8' as const, content, size: content.length, sha256: '' });
const LAYOUT = '<html><body>{{ content_for_layout }}</body></html>';

describe('real-world Shopify theme compatibility', () => {
  it('imports a GitHub-style ZIP: wrapper folder, README/.github ignored, commented JSON template, section without schema', async () => {
    const files: Array<[string, string]> = [
      ['my-theme-main/README.md', '# theme'],
      ['my-theme-main/.github/workflows/ci.yml', 'name: ci'],
      ['my-theme-main/layout/theme.liquid', LAYOUT],
      ['my-theme-main/templates/index.json', '/* auto-generated */\n{"sections":{"a":{"type":"plain"}},"order":["a"],}'],
      ['my-theme-main/sections/plain.liquid', '<p>no schema here</p>'],
    ];
    const zip = buildStoredZip(files.map(([path, c]) => ({ path, data: Buffer.from(c) })));
    const parsed = await readThemeZip(zip);
    expect(parsed.map((x) => x.path).sort()).toEqual(['layout/theme.liquid', 'sections/plain.liquid', 'templates/index.json']);
    expect(() => validateThemePackage(parsed)).not.toThrow();
    expect(await renderThemePreview(parsed)).toContain('no schema here');
  });

  it('accepts a classic theme whose home page is templates/index.liquid and renders per-page liquid templates', async () => {
    const files = [
      f('layout/theme.liquid', LAYOUT),
      f('templates/index.liquid', '<h1>HOME</h1>'),
      f('templates/product.liquid', '<h1>PRODUCT {{ product.title }}</h1>'),
    ];
    expect(() => validateThemePackage(files)).not.toThrow();
    const html = await renderThemePreview(files, { product: { id: 1, title: 'Mug' }, request: { page_type: 'product' } }, '/products/mug');
    expect(html).toContain('PRODUCT Mug');
  });

  it('renders snippets that use form/doc/stylesheet and a render inside a {% liquid %} block', async () => {
    const files = [
      f('layout/theme.liquid', LAYOUT),
      f('templates/index.json', JSON.stringify({ sections: { m: { type: 'main' } }, order: ['m'] })),
      f('sections/main.liquid', "{% liquid\n  assign x = 1\n  render 'card'\n%}"),
      f('snippets/card.liquid', "{% doc %}@param a{% enddoc %}{% form 'product', product %}<button>Add</button>{% endform %}{% stylesheet %}.a{color:red}{% endstylesheet %}"),
    ];
    const html = await renderThemePreview(files);
    expect(html).toContain('<button>Add</button>');
    expect(html).toContain('<style>.a{color:red}</style>');
    expect(html).not.toContain('@param');
  });

  it('exposes section.blocks as an ordered array and supports content_for blocks (nested) and static blocks', async () => {
    const files = [
      f('layout/theme.liquid', LAYOUT),
      f('templates/index.json', JSON.stringify({
        sections: { m: { type: 'main', blocks: { b1: { type: 'row', blocks: { c1: { type: 'leaf', settings: { t: 'one' } }, c2: { type: 'leaf', settings: { t: 'two' } } }, block_order: ['c1', 'c2'] } }, block_order: ['b1'] } },
        order: ['m'],
      })),
      f('sections/main.liquid', "[{% for block in section.blocks %}{{ block.type }}:{{ block.id }}{% endfor %}]{% content_for 'blocks' %}{% content_for 'block', type: 'leaf', id: 'static-1' %}"),
      f('blocks/row.liquid', '<row>{% content_for "blocks" %}</row>'),
      f('blocks/leaf.liquid', '<leaf>{{ block.settings.t }}|{{ block.id }}</leaf>'),
    ];
    const html = await renderThemePreview(files);
    expect(html).toContain('[row:b1]');
    expect(html).toContain('<row><leaf>one|c1</leaf>\n<leaf>two|c2</leaf></row>'.replace('\n', ''));
    expect(html).toContain('<leaf>|static-1</leaf>');
  });
});

describe('what real theme JavaScript and templates rely on', () => {
  const layout = f('layout/theme.liquid', '<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>');
  const product = { id: 1, handle: 'mug', url: '/products/mug', title: 'Mug', vendor: 'Acme', images: ['https://x.test/a.jpg', 'https://x.test/b.jpg'], variants: [{ id: 5, price: 100 }] };

  it('gives products Shopify media fields (featured_media, media) and the Shopify global for theme scripts', async () => {
    const html = await renderThemePreview([
      layout,
      f('templates/product.liquid', '[{{ product.featured_media.src }}|{{ product.media.size }}|{{ product.featured_media.preview_image.width }}]'),
    ], { product, request: { page_type: 'product' } }, '/products/mug');
    expect(html).toContain('[https://x.test/a.jpg|2|1000]');
    expect(html).toContain('window.Shopify=');
  });

  it('evaluates Liquid / dynamic sources stored in settings and wraps sections like Shopify', async () => {
    const html = await renderThemePreview([
      layout,
      f('templates/product.json', JSON.stringify({ sections: { main: { type: 'main', settings: { text: '{{ product.vendor }}' } } }, order: ['main'] })),
      f('sections/main.liquid', '<b>{{ section.settings.text }}</b>'),
    ], { product, request: { page_type: 'product' } }, '/products/mug');
    expect(html).toContain('<b>Acme</b>');
    expect(html).toContain('id="shopify-section-main" class="shopify-section"');
  });

  it('supports inline_asset_content and preload_tag instead of printing their input', async () => {
    const html = await renderThemePreview([
      layout,
      f('templates/index.liquid', "{{ 'icon.svg' | inline_asset_content }}{{ 'a.css' | asset_url | preload_tag: as: 'style' }}"),
      f('assets/icon.svg', '<svg id="i"></svg>'),
      f('assets/a.css', 'a{}'),
    ]);
    expect(html).toContain('<svg id="i"></svg>');
    expect(html).toContain('<link rel="preload"');
  });

  it('lets the browser load theme assets from the API origin (CSP), not only data: URIs', async () => {
    const html = await renderThemePreview([layout, f('templates/index.liquid', 'x')]);
    expect(html).toMatch(/style-src 'unsafe-inline' data: https?:\/\//);
    expect(html).toMatch(/font-src data: https?:\/\//);
    expect(html).toMatch(/script-src 'unsafe-inline' data: https?:\/\//);
  });
});
