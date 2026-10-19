import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { PublicCache, PublicCacheInterceptor } from './public-cache.interceptor';

class Dummy { @PublicCache(15, (req: any) => req.vary ?? 'x') handler() { return null; } plain() { return null; } }

function setup(opts: { connected?: boolean; stored?: string | null } = {}) {
  const store = new Map<string, string>();
  if (opts.stored) store.set('pubcache:v1:/api/x?a=1|x', opts.stored);
  const redis: any = {
    isConnected: opts.connected ?? true,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
  const interceptor = new PublicCacheInterceptor(new Reflector(), redis);
  const ctx = (handler: any, req: any): any => ({ getHandler: () => handler, switchToHttp: () => ({ getRequest: () => req }) });
  return { interceptor, redis, ctx, store };
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

  it('does nothing for a route without @PublicCache', async () => {
    const { interceptor, ctx, redis } = setup();
    const next = { handle: jest.fn(() => of({ ok: 1 })) };
    await lastValueFrom(await interceptor.intercept(ctx(Dummy.prototype.plain, req()), next));
    expect(redis.get).not.toHaveBeenCalled();
  });
});
