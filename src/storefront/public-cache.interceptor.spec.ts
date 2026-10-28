import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { PublicCache, PublicCacheInterceptor } from './public-cache.interceptor';

class Dummy { @PublicCache(15, (req: any) => req.vary ?? 'x') handler() { return null; } @PublicCache(15) novary() { return null; } plain() { return null; } }

function setup(opts: { connected?: boolean; stored?: string | null } = {}) {
  const store = new Map<string, string>();
  if (opts.stored) store.set('pubcache:v1:/api/x?a=1|x', opts.stored);
  const redis: any = {
    isConnected: opts.connected ?? true,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
  const interceptor = new PublicCacheInterceptor(new Reflector(), redis);
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; }, removeHeader: (k: string) => { delete headers[k]; } };
  const ctx = (handler: any, req: any): any => ({ getHandler: () => handler, switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) });
  return { interceptor, redis, ctx, store, headers };
}
const req = (extra: any = {}) => ({ method: 'GET', originalUrl: '/api/x?a=1', headers: {}, ...extra });

describe('PublicCacheInterceptor', () => {
  it('serves a cached body without calling the handler', async () => {
    const { interceptor, ctx } = setup({ stored: JSON.stringify({ hit: true }) });
    const next = { handle: jest.fn(() => of({ hit: false })) };
    const out = await lastValueFrom(await interceptor.intercept(ctx(Dummy.prototype.handler, req()), next));
    expect(out).toEqual({ hit: true });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('stores a miss with the configured ttl and returns the handler result', async () => {
    const { interceptor, ctx, redis } = setup();
    const next = { handle: jest.fn(() => of({ n: 1 })) };
    const out = await lastValueFrom(await interceptor.intercept(ctx(Dummy.prototype.handler, req()), next));
    expect(out).toEqual({ n: 1 });
    expect(redis.set).toHaveBeenCalledWith('pubcache:v1:/api/x?a=1|x', JSON.stringify({ n: 1 }), 15);
  });

  it('keeps visitors with a different vary value apart', async () => {
    const { interceptor, ctx, redis } = setup({ stored: JSON.stringify({ hit: true }) });
    const next = { handle: jest.fn(() => of({ n: 2 })) };
    const out = await lastValueFrom(await interceptor.intercept(ctx(Dummy.prototype.handler, req({ vary: 'PK' })), next));
    expect(out).toEqual({ n: 2 });
    expect(redis.set.mock.calls[0][0]).toBe('pubcache:v1:/api/x?a=1|PK');
  });

  it.each([
    ['an Authorization header', req({ headers: { authorization: 'Bearer t' } }), true],
    ['a non-GET request', req({ method: 'POST' }), true],
    ['Redis being down', req(), false],
  ])('bypasses the cache for %s', async (_n, request, connected) => {
    const { interceptor, ctx, redis } = setup({ connected, stored: JSON.stringify({ hit: true }) });
    const next = { handle: jest.fn(() => of({ fresh: true })) };
    const out = await lastValueFrom(await interceptor.intercept(ctx(Dummy.prototype.handler, request), next));
    expect(out).toEqual({ fresh: true });
    expect(redis.set).not.toHaveBeenCalled();
  });

  describe('CDN Cache-Control', () => {
    const hit = (extra: any = {}) => req({ originalUrl: '/api/x?a=1', ...extra });
    it('is sent for a confirmed public store (hit and miss)', async () => {
      const { interceptor, ctx, headers } = setup();
      await lastValueFrom(await interceptor.intercept(ctx(Dummy.prototype.novary, hit({ storefrontGateMode: 'public' })), { handle: () => of({ n: 1 }) }));
      expect(headers['Cache-Control']).toBe('public, max-age=0, s-maxage=30, stale-while-revalidate=300, stale-if-error=86400');
      expect(headers['Access-Control-Allow-Origin']).toBe('*'); // a shared cache must not replay one origin's CORS header to another
    });
    it.each([['password'], ['coming_soon'], [undefined]])('is NOT sent when the store gate is %s', async (mode) => {
      const { interceptor, ctx, headers } = setup();
      await lastValueFrom(await interceptor.intercept(ctx(Dummy.prototype.novary, hit({ storefrontGateMode: mode })), { handle: () => of({ n: 1 }) }));
      expect(headers['Cache-Control']).toBeUndefined();
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
    it('is NOT sent for per-visitor (vary) responses, nor to signed-in callers', async () => {
      const a = setup();
      await lastValueFrom(await a.interceptor.intercept(a.ctx(Dummy.prototype.handler, hit({ storefrontGateMode: 'public' })), { handle: () => of({ n: 1 }) }));
      expect(a.headers['Cache-Control']).toBeUndefined();
      const b = setup();
      await lastValueFrom(await b.interceptor.intercept(b.ctx(Dummy.prototype.novary, hit({ storefrontGateMode: 'public', headers: { authorization: 'Bearer t' } })), { handle: () => of({ n: 1 }) }));
      expect(b.headers['Cache-Control']).toBeUndefined();
    });
  });

  it('does nothing for a route without @PublicCache', async () => {
    const { interceptor, ctx, redis } = setup();
    const next = { handle: jest.fn(() => of({ ok: 1 })) };
    await lastValueFrom(await interceptor.intercept(ctx(Dummy.prototype.plain, req()), next));
    expect(redis.get).not.toHaveBeenCalled();
  });
});
