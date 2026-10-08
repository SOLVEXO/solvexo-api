import { buildShopifyPagination, findPaginatePageSize, renderThemePreview } from './theme-package.service';

describe('Liquid theme pagination', () => {
  it('uses the Liquid page size while respecting Shopify’s 250-item maximum', () => {
    expect(findPaginatePageSize([
      { path: 'sections/main-collection.liquid', encoding: 'utf8', content: '{% paginate collection.products by 36 %}{% endpaginate %}' },
    ] as any, 'collection.products')).toBe(36);
    expect(findPaginatePageSize([
      { path: 'sections/main-collection.liquid', encoding: 'utf8', content: '{% paginate collection.products by 300 %}{% endpaginate %}' },
    ] as any, 'collection.products')).toBe(250);
  });

  it('builds Shopify pagination links and preserves other query parameters', () => {
    const pagination = buildShopifyPagination(95, 20, 3, '/collections/all?sort_by=price-ascending&page=3');

    expect(pagination).toMatchObject({
      page_size: 20,
      current_page: 3,
      current_offset: 40,
      items: 20,
      pages: 5,
      previous: { title: 'Previous', url: '/collections/all?sort_by=price-ascending&page=2' },
      next: { title: 'Next', url: '/collections/all?sort_by=price-ascending&page=4' },
    });
    expect(pagination.parts.filter((part: any) => part.type === 'page').map((part: any) => part.title))
      .toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps paginate wrappers around the theme’s own product loop', async () => {
    const html = await renderThemePreview([
      {
        path: 'templates/collection.json',
        encoding: 'utf8',
        content: JSON.stringify({
          order: ['main'],
          sections: { main: { type: 'main', settings: {}, blocks: {}, block_order: [] } },
        }),
        size: 0,
        sha256: '',
      },
      {
        path: 'sections/main.liquid',
        encoding: 'utf8',
        content: '{% paginate collection.products by 2 %}<ul>{% for product in collection.products %}<li>{{ product.title }}</li>{% endfor %}</ul>{% if paginate.previous %}<a href="{{ paginate.previous.url }}">Previous</a>{% endif %}{% if paginate.next %}<a href="{{ paginate.next.url }}">Next</a>{% endif %}{% endpaginate %}',
        size: 0,
        sha256: '',
      },
    ], {
      collection: {
        products: [{ title: 'Third product' }, { title: 'Fourth product' }],
      },
      paginate: {
        previous: { url: '/collections/all?page=2' },
        next: { url: '/collections/all?page=4' },
      },
    }, '/collections/all?page=3');

    expect(html).toContain('<li>Third product</li><li>Fourth product</li>');
    expect(html).toContain('href="/collections/all?page=2">Previous</a>');
    expect(html).toContain('href="/collections/all?page=4">Next</a>');
    expect(html.match(/<li>/g)).toHaveLength(2);
  });
});
