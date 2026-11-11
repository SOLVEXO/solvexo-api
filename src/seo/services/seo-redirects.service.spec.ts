import { SeoRedirectsService, redirectKey, MAX_REDIRECT_CHAIN } from './seo-redirects.service';
import { FakeModel } from '../../digital-access/testing/fake-db.kit-spec';

const actor = { id: 'a1' };

function setup() {
  const model = new FakeModel({ isActive: true, isDelete: false, hitCount: 0 });
  const db: any = { repositories: { seoRedirectModel: model, storeModel: new FakeModel() } };
  const svc = new SeoRedirectsService(db, { log: async () => undefined } as any);
  const add = (source: string, destination: string, over: any = {}) => svc.create('s1', { source, destination, ...over } as any, actor);
  return { svc, model, add };
}

describe('redirectKey: how two paths are compared', () => {
  it('ignores case, a trailing slash, the query string and the #hash', () => {
    expect(redirectKey('/Shop/Old-Page/?ref=x#top')).toBe('/shop/old-page');
    expect(redirectKey('/shop/old-page')).toBe('/shop/old-page');
  });
  it('reduces a full address to its path and decodes %-escapes', () => {
    expect(redirectKey('https://shop.example.com/old%20page/')).toBe('/old page');
  });
  it('collapses doubled slashes and treats the home page as "/"', () => {
    expect(redirectKey('//a//b//')).toBe('/a/b');
    expect(redirectKey('/')).toBe('/');
    expect(redirectKey('')).toBe('/');
  });
});

describe('finding a redirect for a requested page', () => {
  it('matches however the visitor types it: other case, trailing slash, with a query string', async () => {
    const { svc, add } = setup();
    await add('/old-product', '/product/new');
    for (const asked of ['/old-product', '/OLD-Product', '/old-product/', '/old-product?utm=x', '/old-product/?a=1&b=2']) {
      expect((await svc.resolve('s1', asked) as any)?.destination).toBe('/product/new');
    }
  });
  it('a source saved with a trailing slash or a query string is cleaned and still matches', async () => {
    const { svc, add, model } = setup();
    await add(' /Summer-Sale/?x=1 ', '/collections/sale');
    expect(model.rows[0].source).toBe('/Summer-Sale');
    expect(model.rows[0].sourceKey).toBe('/summer-sale');
    expect((await svc.resolve('s1', '/summer-sale') as any)?.destination).toBe('/collections/sale');
  });
  it('an older rule (saved without a lower-case key) is still found by its exact path', async () => {
    const { svc, model } = setup();
    model.rows.push({ _id: 'old1', storeId: 's1', source: '/legacy', destination: '/new', statusCode: 301, isActive: true, isDelete: false });
    expect((await svc.resolve('s1', '/legacy') as any)?.destination).toBe('/new');
    expect((await svc.resolve('s1', '/legacy/') as any)?.destination).toBe('/new');
  });
  it('never returns a rule that points a page at itself', async () => {
    const { svc, model } = setup();
    model.rows.push({ _id: 'x', storeId: 's1', source: '/same', sourceKey: '/same', destination: '/Same/', isActive: true, isDelete: false });
    expect(await svc.resolve('s1', '/same')).toBeNull();
  });
  it('another store\'s redirects are never used', async () => {
    const { svc, model } = setup();
    model.rows.push({ _id: 'o', storeId: 's2', source: '/a', sourceKey: '/a', destination: '/b', isActive: true, isDelete: false });
    expect(await svc.resolve('s1', '/a')).toBeNull();
  });
  it('an inactive or deleted rule is ignored', async () => {
    const { svc, model } = setup();
    model.rows.push({ _id: 'i', storeId: 's1', source: '/a', sourceKey: '/a', destination: '/b', isActive: false, isDelete: false });
    model.rows.push({ _id: 'd', storeId: 's1', source: '/c', sourceKey: '/c', destination: '/d', isActive: true, isDelete: true });
    expect(await svc.resolve('s1', '/a')).toBeNull();
    expect(await svc.resolve('s1', '/c')).toBeNull();
  });
});

describe('redirect loops are refused when the rule is saved', () => {
  it('a page can not redirect to itself, in any spelling', async () => {
    const { add } = setup();
    await expect(add('/a', '/a')).rejects.toThrow();
    await expect(add('/a', '/A/')).rejects.toThrow();
    await expect(add('/a', '/a?x=1')).rejects.toThrow();
  });
  it('a two-step circle /a -> /b -> /a is refused, and the message shows the circle', async () => {
    const { add } = setup();
    await add('/a', '/b');
    let message = '';
    try { await add('/b', '/a'); } catch (e: any) { message = String(e.message); }
    expect(message).toContain('circles');
    expect(message).toContain('/b → /a → /b');
  });
  it('a longer circle /a -> /b -> /c -> /a is refused', async () => {
    const { add } = setup();
    await add('/a', '/b');
    await add('/b', '/c');
    await expect(add('/c', '/a')).rejects.toThrow();
  });
  it('a normal chain is allowed', async () => {
    const { add, model } = setup();
    await add('/a', '/b');
    await add('/b', '/c');
    expect(model.rows.length).toBe(2);
  });
  it('a chain longer than the limit is refused', async () => {
    const { add } = setup();
    for (let i = 0; i < MAX_REDIRECT_CHAIN; i++) await add(`/p${i}`, `/p${i + 1}`);
    await expect(add('/start', '/p0')).rejects.toThrow();
  });
  it('an inactive rule does not count as part of a circle', async () => {
    const { add, model } = setup();
    await add('/a', '/b', { isActive: false });
    await add('/b', '/a');
    expect(model.rows.length).toBe(2);
  });
  it('editing a rule is checked too, without counting the rule itself', async () => {
    const { svc, add, model } = setup();
    await add('/a', '/b');
    await add('/b', '/c');
    const id = String(model.rows[1]._id);
    await expect(svc.update('s1', id, { destination: '/a' } as any, actor)).rejects.toThrow();
    await svc.update('s1', id, { destination: '/z' } as any, actor);
    expect(model.rows[1].destination).toBe('/z');
  });
  it('a destination on another address can not loop', async () => {
    const { add, model } = setup();
    await add('/a', 'https://www.solvexo.store/page');
    expect(model.rows.length).toBe(1);
  });
  it('the same path in another case is a duplicate, not a second rule', async () => {
    const { add } = setup();
    await add('/Old', '/new');
    await expect(add('/old', '/other')).rejects.toThrow();
  });
});
