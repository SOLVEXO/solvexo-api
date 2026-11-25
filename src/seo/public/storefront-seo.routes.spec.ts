import { NotFoundException } from '@nestjs/common';
import { StorefrontSeoController } from './storefront-seo.controller';

const q = (value: unknown): any => ({ select: () => q(value), sort: () => q(value), lean: async () => value });

function make(overrides: { page?: unknown } = {}) {
  const db: any = {
    repositories: {
      storePageModel: { findOne: () => q(overrides.page ?? null) },
      productModel: { findOne: () => q(null) },
      collectionModel: { findOne: () => q(null) },
      categoryModel: { findOne: () => q(null) },
      blogModel: { findOne: () => q(null) },
      blogPostModel: { findOne: () => q(null) },
    },
  };
  const redirects: any = { resolve: async () => null };
  return new StorefrontSeoController(db, {} as any, redirects, {} as any);
}
const store: any = { _id: 'S1', name: 'Hello Shop', slug: 'hello' };
const meta = (c: StorefrontSeoController, path: string) => (c as any).routeMeta(store, 'S1', path);

describe('storefront SEO document: which addresses exist', () => {
  it('/collections is a real, indexable page (it used to answer 404)', async () => {
    const m = await meta(make(), '/collections');
    expect(m.noindex).toBe(false);
    expect(m.title).toBe('Collections - Hello Shop');
    expect(m.canonicalUrl).toBe('https://hello.solvexo.store/collections');
  });

  it('/faqs is a real, indexable page even when the seller made no page of that name', async () => {
    const m = await meta(make(), '/faqs');
    expect(m.noindex).toBe(false);
    expect(m.title).toBe('FAQs - Hello Shop');
  });

  it('a seller-made faqs page still wins', async () => {
    const m = await meta(make({ page: { title: 'Our questions', slug: 'faqs', seo: {} } }), '/faqs');
    expect(m.title).toBe('Our questions');
  });

  it('customer-area and digital pages exist for the app but stay out of search engines', async () => {
    for (const p of ['/library', '/memberships', '/licenses', '/learn', '/wholesale', '/subscriptions', '/messaging-preferences', '/discount/SAVE10', '/cod-confirm/abc', '/gift-cards/view/tok']) {
      const m = await meta(make(), p);
      expect(m.noindex).toBe(true);
    }
  });

  it('a made-up address is still a 404', async () => {
    await expect(meta(make(), '/definitely-not-a-page')).rejects.toBeInstanceOf(NotFoundException);
    await expect(meta(make(), '/collections/nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
