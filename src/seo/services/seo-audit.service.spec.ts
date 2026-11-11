import { SeoAuditService, computeScore } from './seo-audit.service';
import { FakeModel } from '../../digital-access/testing/fake-db.kit-spec';

/** The audit judges the title and description a visitor really gets (the storefront falls back to automatic text), and scores fairly. */

function setup(store: any, products: any[], categories: any[] = []) {
  const m = { storeModel: new FakeModel(), productModel: new FakeModel(), categoryModel: new FakeModel(), seoAuditResultModel: new FakeModel() };
  m.storeModel.rows.push({ _id: 's1', name: 'Shop One', ...store });
  products.forEach((p, i) => m.productModel.rows.push({ _id: `p${i + 1}`, storeId: 's1', isDelete: false, images: ['a.jpg'], description: 'x'.repeat(200), ...p }));
  categories.forEach((c) => m.categoryModel.rows.push(c));
  const svc = new SeoAuditService(
    { repositories: m } as any,
    { log: async () => undefined } as any,
    { getSettings: async () => ({ rules: [] }) } as any,
    { getChecklist: async () => [] } as any,
    {} as any,
    {} as any,
  );
  return { svc, m };
}
const codes = (r: any) => r.issues.map((i: any) => i.code);
const storeOk = { description: 'A good shop that sells good things.', seo: {} };

describe('SEO audit judges what the storefront really serves', () => {
  it('a product with no meta title is fine: the storefront shows "Name – Store"', async () => {
    const { svc } = setup(storeOk, [{ name: 'Mug', seo: {} }]);
    const r: any = await svc.run('s1');
    expect(codes(r).includes('title_length')).toBe(false);
  });
  it('a meta title the seller wrote is still checked for length', async () => {
    const { svc } = setup(storeOk, [{ name: 'Mug', seo: { metaTitle: 'x'.repeat(80) } }]);
    const r: any = await svc.run('s1');
    expect(codes(r)).toContain('title_length');
  });
  it('a title inherited from the category or store counts as a title too (and is checked for length)', async () => {
    const withCat = setup(storeOk, [{ name: 'Mug', categoryId: 'c1', seo: {} }], [{ _id: 'c1', seo: { metaTitle: 'y'.repeat(90) } }]);
    expect(codes(await withCat.svc.run('s1'))).toContain('title_length');
    const fine = setup(storeOk, [{ name: 'Mug', categoryId: 'c1', seo: {} }], [{ _id: 'c1', seo: { metaTitle: 'Mugs' } }]);
    expect(codes(await fine.svc.run('s1')).includes('title_length')).toBe(false);
  });
  it('a product with a description but no meta description is fine (the description is used)', async () => {
    const { svc } = setup(storeOk, [{ name: 'Mug', seo: {}, description: 'A hand made ceramic mug. '.repeat(10) }]);
    expect(codes(await svc.run('s1')).includes('description_length')).toBe(false);
  });
  it('no meta description AND no product description is reported', async () => {
    const { svc } = setup(storeOk, [{ name: 'Mug', seo: {}, description: '' }]);
    const r: any = await svc.run('s1');
    expect(r.issues.some((i: any) => i.code === 'description_length' && i.entityType === 'product')).toBe(true);
  });
  it('a meta description outside the ideal length is an info, not a warning', async () => {
    const { svc } = setup(storeOk, [{ name: 'Mug', seo: { metaDescription: 'short' } }]);
    const r: any = await svc.run('s1');
    expect(r.issues.find((i: any) => i.code === 'description_length').severity).toBe('info');
  });
  it('the store home page is fine with just a name and a description', async () => {
    const { svc } = setup(storeOk, []);
    const r: any = await svc.run('s1');
    expect(r.issues.filter((i: any) => i.entityType === 'store')).toEqual([]);
  });
  it('a store with no description anywhere is reported', async () => {
    const { svc } = setup({ description: '', seo: {} }, []);
    const r: any = await svc.run('s1');
    expect(r.issues.some((i: any) => i.entityType === 'store' && i.code === 'description_length')).toBe(true);
  });
});

describe('duplicate titles are judged on the title each product really gets', () => {
  it('two products with different names and automatic titles are not duplicates', async () => {
    const { svc } = setup(storeOk, [{ name: 'Mug', seo: {} }, { name: 'Plate', seo: {} }]);
    expect(codes(await svc.run('s1')).includes('duplicate_meta')).toBe(false);
  });
  it('two products that share a written title are reported', async () => {
    const { svc } = setup(storeOk, [{ name: 'Mug', seo: { metaTitle: 'Best Mugs' } }, { name: 'Cup', seo: { metaTitle: 'best mugs' } }]);
    expect(codes(await svc.run('s1'))).toContain('duplicate_meta');
  });
  it('two products with the same name (so the same automatic title) are reported', async () => {
    const { svc } = setup(storeOk, [{ name: 'Mug', seo: {} }, { name: 'Mug', seo: {} }]);
    expect(codes(await svc.run('s1'))).toContain('duplicate_meta');
  });
  it('products that only share a category title are reported', async () => {
    const { svc } = setup(storeOk, [{ name: 'A', categoryId: 'c1', seo: {} }, { name: 'B', categoryId: 'c1', seo: {} }], [{ _id: 'c1', seo: { metaTitle: 'Mugs' } }]);
    expect(codes(await svc.run('s1'))).toContain('duplicate_meta');
  });
});

describe('the score', () => {
  const warn = { severity: 'warning' as const, code: 'x', message: 'm' };
  it('is 100 on content when there are no issues', () => {
    expect(computeScore([], 100, 10)).toBe(100);
  });
  it('a large store is not scored 0 just because it is large', () => {
    const issues = Array.from({ length: 100 }, () => warn); // 100 warnings, spread over 500 products
    expect(computeScore(issues, 0, 501) >= 75).toBe(true);
  });
  it('a small store where every page has problems scores low', () => {
    const issues = Array.from({ length: 5 * 5 }, () => ({ ...warn, severity: 'error' as const })); // 5 pages with 5 errors each
    expect(computeScore(issues, 0, 5) < 40).toBe(true);
  });
  it('more issues never raise the score', () => {
    const few = computeScore([warn], 50, 10);
    const many = computeScore([warn, warn, warn, warn], 50, 10);
    expect(many <= few).toBe(true);
  });
  it('stays between 0 and 100', () => {
    expect(computeScore(Array.from({ length: 999 }, () => warn), 0, 1)).toBe(0);
    expect(computeScore([], 100, 1)).toBe(100);
  });
});
