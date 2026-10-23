/* eslint-disable prettier/prettier */
import { AuthVisualService } from './auth-visual.service';

const photo = (id: string, text: { alt?: string; desc?: string; tags?: string[] } = {}, extra: any = {}) => ({
  id,
  alt_description: text.alt,
  description: text.desc,
  tags: (text.tags ?? []).map(title => ({ title })),
  urls: { raw: `https://img.example/${id}?ixid=1` },
  user: { name: `User ${id}`, links: { html: `https://unsplash.com/@${id}` } },
  links: { download_location: `https://api.unsplash.com/photos/${id}/download` },
  ...extra,
});

describe('AuthVisualService', () => {
  let svc: AuthVisualService;
  let s: any;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(() => {
    redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    svc = new AuthVisualService(redis as any);
    s = svc as any;
    jest.spyOn(s.logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('isSuitable (text filter)', () => {
    it('accepts a clean shop photo', () => {
      expect(s.isSuitable(photo('a', { alt: 'a market stall with goods', tags: ['market'] }), false)).toBe(true);
    });

    it('accepts photos with no text metadata at all', () => {
      expect(s.isSuitable(photo('a'), false)).toBe(true);
      expect(s.isSuitable(null, false)).toBe(true);
    });

    it('always rejects women/fashion/portrait/nudity keywords in alt, description or tags', () => {
      expect(s.isSuitable(photo('a', { alt: 'woman in a shop' }), false)).toBe(false);
      expect(s.isSuitable(photo('a', { desc: 'Fashion boutique' }), false)).toBe(false);
      expect(s.isSuitable(photo('a', { tags: ['portrait'] }), false)).toBe(false);
      expect(s.isSuitable(photo('a', { alt: 'lingerie display' }), true)).toBe(false);
      expect(s.isSuitable(photo('a', { alt: 'businesswoman at a laptop' }), false)).toBe(false);
      expect(s.isSuitable(photo('a', { tags: ['female'] }), false)).toBe(false);
      expect(s.isSuitable(photo('a', { alt: 'man at a laptop in a shop' }), false)).toBe(true);
    });

    it('matches whole words only (no false positives on substrings)', () => {
      expect(s.isSuitable(photo('a', { alt: 'modelling clay and bracket shelves' }), false)).toBe(true);
    });

    it('blocks alcohol/nightlife only for modest countries', () => {
      const p = photo('a', { alt: 'a bar with wine bottles' });
      expect(s.isSuitable(p, false)).toBe(true);
      expect(s.isSuitable(p, true)).toBe(false);
    });
  });

  describe('isStrictSafe (no-AI fallback for conservative countries)', () => {
    it('requires some text', () => {
      expect(s.isStrictSafe(photo('a'))).toBe(false);
      expect(s.isStrictSafe(null)).toBe(false);
    });

    it('accepts people-free photos naming a safe subject', () => {
      expect(s.isStrictSafe(photo('a', { alt: 'row of shops on a street' }))).toBe(true);
      expect(s.isStrictSafe(photo('a', { tags: ['bazaar'] }))).toBe(true);
    });

    it('rejects people-related text, including machine tags', () => {
      expect(s.isStrictSafe(photo('a', { alt: 'man standing in a shop' }))).toBe(false);
      expect(s.isStrictSafe(photo('a', { alt: 'market stall', tags: ['person'] }))).toBe(false);
    });

    it('rejects photos without an allowed subject', () => {
      expect(s.isStrictSafe(photo('a', { alt: 'sunset over water' }))).toBe(false);
    });
  });

  describe('buildQueryLadder', () => {
    it('goes from specific to generic', () => {
      expect(s.buildQueryLadder('Pakistan', 'register')).toEqual([
        'Pakistan man laptop setting up online shop',
        'Pakistan market shop',
        'Pakistan street',
      ]);
    });

    it('uses the seller-topic hint only on onboarding_products', () => {
      expect(s.buildQueryLadder('Pakistan', 'onboarding_products', 'creator')[0]).toBe('Pakistan man designer desk laptop tablet');
      expect(s.buildQueryLadder('Pakistan', 'onboarding_products')[0]).toBe('Pakistan man packing products boxes');
      expect(s.buildQueryLadder('Pakistan', 'login', 'creator')[0]).toBe('Pakistan shopkeeper man at shop counter');
    });
  });

  describe('toPoolItem', () => {
    it('builds image url, attribution and download location', () => {
      const item = s.toPoolItem(photo('a'));
      expect(item.imageUrl).toContain('https://img.example/a?ixid=1&');
      expect(item.imageUrl).toContain('w=1200');
      expect(item.attribution).toEqual({ name: 'User a', profileUrl: 'https://unsplash.com/@a' });
      expect(item.downloadLocation).toBe('https://api.unsplash.com/photos/a/download');
    });

    it('has null attribution when photographer info is missing', () => {
      expect(s.toPoolItem(photo('a', {}, { user: {} })).attribution).toBeNull();
    });
  });

  describe('buildPool', () => {
    const candidates = (n: number) => Array.from({ length: n }, (_, i) => photo(`p${i}`));

    it('keeps only AI-approved photos, capped at POOL_SIZE (3)', async () => {
      jest.spyOn(s, 'fetchCandidates').mockResolvedValue(candidates(6));
      jest.spyOn(s, 'vetPhoto').mockResolvedValue(true);
      const pool = await s.buildPool('Pakistan', 'register', undefined, false);
      expect(pool).toHaveLength(3);
      expect(pool.map((p: any) => p.imageUrl)).toEqual(
        candidates(3).map(p => expect.stringContaining(p.urls.raw)),
      );
    });

    it('drops rejected photos', async () => {
      jest.spyOn(s, 'fetchCandidates').mockResolvedValue(candidates(3));
      jest.spyOn(s, 'vetPhoto').mockImplementation(async (url: string) => url.includes('p1'));
      const pool = await s.buildPool('Pakistan', 'register', undefined, false);
      expect(pool).toHaveLength(1);
      expect(pool[0].imageUrl).toContain('p1');
    });

    it('falls through the query ladder until the pool is full', async () => {
      const fetchSpy = jest
        .spyOn(s, 'fetchCandidates')
        .mockResolvedValueOnce([photo('a')])
        .mockResolvedValueOnce([photo('b'), photo('c')])
        .mockResolvedValue([]);
      jest.spyOn(s, 'vetPhoto').mockResolvedValue(true);
      const pool = await s.buildPool('Pakistan', 'register', undefined, false);
      expect(pool).toHaveLength(3);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('AI unavailable: only people-free photos with a safe subject, in EVERY country', async () => {
      const fetchSpy = jest.spyOn(s, 'fetchCandidates');
      jest.spyOn(s, 'vetPhoto').mockResolvedValue(null);

      fetchSpy.mockResolvedValue([photo('a', { alt: 'man in shop' }), photo('b', { alt: 'shop street' })]);
      for (const modest of [true, false]) {
        const safe = await s.buildPool('Pakistan', 'register', undefined, modest);
        expect(safe).toHaveLength(1);
        expect(safe[0].imageUrl).toContain('/b?');
      }

      fetchSpy.mockResolvedValue([photo('a', { alt: 'person in shop' })]);
      expect(await s.buildPool('France', 'register', undefined, false)).toEqual([]);
    });

    it('skips blocked photos', async () => {
      redis.get.mockResolvedValue(JSON.stringify(['p1']));
      jest.spyOn(s, 'fetchCandidates').mockResolvedValue(candidates(3));
      jest.spyOn(s, 'vetPhoto').mockResolvedValue(true);
      const pool = await s.buildPool('Pakistan', 'register', undefined, false);
      expect(pool.map((p: any) => p.id)).toEqual(['p0', 'p2']);
    });
  });

  describe('vetPhoto rules', () => {
    it('tells the AI to reject any woman and to match the scene', async () => {
      const create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
      s.client = { messages: { create } };
      expect(await s.vetPhoto('https://x/y.jpg', 'Pakistan', 'man laptop setting up online shop', true)).toBe(true);
      const text = create.mock.calls[0][0].messages[0].content[1].text;
      expect(text).toMatch(/woman or girl/);
      expect(text).toContain('man laptop setting up online shop');
      expect(text).toContain('Islamic modesty');
    });
  });

  describe('admin block list + pre-warm', () => {
    it('blockPhoto stores the id, cleans pools holding it, and resolve never serves it', async () => {
      s.pools.set('PK:login:', { items: [{ id: 'abc123', imageUrl: 'https://i/photo-1-aaa?x', attribution: null }, { id: 'ok9999', imageUrl: 'https://i/photo-2-bbb?x', attribution: null }], expires: Date.now() + 1000 });
      redis.get.mockResolvedValue(null);
      const out = await svc.blockPhoto('https://images.unsplash.com/photo-1-aaa?crop=entropy');
      expect(out.blocked).toBe('photo-1-aaa');
      expect(out.poolsCleaned).toBe(1);
      expect(s.pools.get('PK:login:').items.map((i: any) => i.id)).toEqual(['ok9999']);
      expect(redis.set).toHaveBeenCalledWith('auth-visual:blocked', JSON.stringify(['photo-1-aaa']), expect.any(Number));
      await expect(svc.blockPhoto('!!')).rejects.toThrow();
    });

    it('missingPrewarmPools returns the most important missing screen first and honours the limit', async () => {
      redis.get.mockResolvedValue(null);
      const todo = await svc.missingPrewarmPools(3);
      expect(todo).toHaveLength(3);
      expect(todo.every(t => t.context === 'register')).toBe(true);
    });

    it('prewarm stores an approved pool; an empty build is backed off', async () => {
      process.env.UNSPLASH_ACCESS_KEY = 'k';
      const build = jest.spyOn(s, 'buildPool');
      build.mockResolvedValueOnce([{ imageUrl: 'i', attribution: null }]);
      expect(await svc.prewarm('PK', 'login')).toBe(1);
      expect(redis.set).toHaveBeenCalledWith('auth-visual:v4:PK:login:', expect.any(String), expect.any(Number));
      build.mockResolvedValueOnce([]);
      expect(await svc.prewarm('IN', 'login')).toBe(0);
      expect(s.retryBackoff('IN', 'login')).toBe(true);
    });
  });

  describe('fetchCandidates', () => {
    it('filters unsuitable/rawless photos and returns [] on HTTP error', async () => {
      const results = [photo('ok'), photo('bad', { alt: 'woman' }), { id: 'noraw' }];
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results }) });
      (global as any).fetch = fetchMock;
      const out = await s.fetchCandidates('q', false);
      expect(out.map((p: any) => p.id)).toEqual(['ok']);

      fetchMock.mockResolvedValue({ ok: false, status: 403 });
      expect(await s.fetchCandidates('q', false)).toEqual([]);
    });
  });

  describe('resolve / pool reads', () => {
    const envBackup = process.env.UNSPLASH_ACCESS_KEY;
    afterEach(() => {
      if (envBackup === undefined) delete process.env.UNSPLASH_ACCESS_KEY;
      else process.env.UNSPLASH_ACCESS_KEY = envBackup;
    });

    it('returns the static fallback without an Unsplash key', async () => {
      delete process.env.UNSPLASH_ACCESS_KEY;
      const res = await svc.resolve('PK', 'login');
      expect(res.attribution).toBeNull();
      expect(res.imageUrl).toBeTruthy();
    });

    it('serves from an existing pool and does not warm', async () => {
      process.env.UNSPLASH_ACCESS_KEY = 'k';
      (global as any).fetch = jest.fn().mockResolvedValue({});
      const item = { imageUrl: 'https://img/x', attribution: { name: 'n', profileUrl: 'u' }, downloadLocation: 'https://dl' };
      redis.get.mockResolvedValue(JSON.stringify([item]));
      const warm = jest.spyOn(s, 'warmPool').mockImplementation(() => undefined);
      const res = await svc.resolve('PK', 'login');
      expect(res.imageUrl).toBe('https://img/x');
      expect(res.attribution).toEqual(item.attribution);
      expect(warm).not.toHaveBeenCalled();
    });

    it('serves the fallback immediately and warms the pool when none exists', async () => {
      process.env.UNSPLASH_ACCESS_KEY = 'k';
      redis.get.mockResolvedValue(null);
      const warm = jest.spyOn(s, 'warmPool').mockImplementation(() => undefined);
      const res = await svc.resolve('PK', 'login');
      expect(res.attribution).toBeNull();
      expect(warm).toHaveBeenCalledTimes(1);
    });

    it('readPool ignores Redis errors and expired memory entries', async () => {
      redis.get.mockRejectedValue(new Error('down'));
      s.pools.set('k1', { items: [{ imageUrl: 'old' }], expires: Date.now() - 1 });
      expect(await s.readPool('k1')).toBeNull();
      s.pools.set('k2', { items: [{ imageUrl: 'fresh' }], expires: Date.now() + 1000 });
      expect(await s.readPool('k2')).toEqual([{ imageUrl: 'fresh' }]);
    });

    it('warmPool stores a built pool, and backs off when nothing was approved', async () => {
      const build = jest.spyOn(s, 'buildPool');
      build.mockResolvedValueOnce([{ imageUrl: 'i', attribution: null }]);
      s.warmPool('k', 'Pakistan', 'login', undefined, false);
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      expect(s.pools.get('k').items).toHaveLength(1);
      expect(redis.set).toHaveBeenCalledWith('auth-visual:v4:k', expect.any(String), 7 * 24 * 60 * 60);

      build.mockResolvedValueOnce([]);
      s.warmPool('e', 'Pakistan', 'login', undefined, false);
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      expect(s.pools.get('retry:e')).toBeDefined();
      s.warmPool('e', 'Pakistan', 'login', undefined, false); // within backoff: no new build
      expect(build).toHaveBeenCalledTimes(2);
    });
  });
});
