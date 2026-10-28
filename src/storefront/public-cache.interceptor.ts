import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, tap } from 'rxjs';
import { RedisService } from '../redis/redis.service';

const PUBLIC_CACHE_META = 'solvexo:public-cache';

/**
 * What a CDN in front of the API may do with an anonymous storefront read: keep it briefly, and keep serving the last copy
 * while the API is slow (stale-while-revalidate) or down (stale-if-error). Browsers always revalidate (max-age=0) so a seller's
 * edit is never stuck in a visitor's browser.
 */
function cdnCacheControl(ttlSeconds: number) {
  return `public, max-age=0, s-maxage=${Math.max(ttlSeconds * 2, 30)}, stale-while-revalidate=300, stale-if-error=86400`;
}

interface PublicCacheOptions {
  ttlSeconds: number;
  /** Extra cache-key part for the one thing, if any, that makes the response differ between anonymous visitors. */
  vary?: (req: any) => string;
}

/** Marks an anonymous, read-only GET as safe to serve from a short Redis cache. Pair with `@UseInterceptors(PublicCacheInterceptor)`. */
export const PublicCache = (ttlSeconds = 15, vary?: (req: any) => string) =>
  SetMetadata(PUBLIC_CACHE_META, { ttlSeconds, vary } satisfies PublicCacheOptions);

/**
 * Short-TTL response cache for public storefront reads (store, theme, pages, collections, products, markets).
 * Runs AFTER the global storefront-access middleware and the guards, so a password-protected / coming-soon store is still
 * gated before a cached body can be returned. Requests carrying an Authorization header (buyer, seller, staff, admin) always
 * bypass it, and with Redis down it is a transparent pass-through — it can only ever make a request faster, never fail it.
 * Trade-off: a seller's edit can take up to `ttlSeconds` to show on the public storefront.
 */
@Injectable()
export class PublicCacheInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly redis: RedisService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const opts = this.reflector.get<PublicCacheOptions | undefined>(PUBLIC_CACHE_META, context.getHandler());
    const req = context.switchToHttp().getRequest();
    if (!opts || req.method !== 'GET' || req.headers?.authorization || !this.redis.isConnected) return next.handle();

    let key = `pubcache:v1:${req.originalUrl}`;
    try { if (opts.vary) key += `|${opts.vary(req)}`; } catch { return next.handle(); }

    // A CDN never runs the password / coming-soon gate, so only a response for a store the access middleware has confirmed as
    // public may be shared. Responses that differ per visitor (opts.vary) and routes whose store was not identified stay private.
    const res = context.switchToHttp().getResponse?.();
    if (res?.setHeader && !opts.vary && req.storefrontGateMode === 'public') {
      res.setHeader('Cache-Control', cdnCacheControl(opts.ttlSeconds));
      // A shared cache keys on method + host + path + query, NOT on Origin (Railway's CDN ignores `Vary: Origin`), so the CORS header
      // the cors middleware reflected for the FIRST visitor would be replayed to every other origin and block their browsers.
      // These responses are anonymous public data (no cookies/credentials), so a wildcard origin is correct and cacheable.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.removeHeader?.('Access-Control-Allow-Credentials');
    }

    try {
      const hit = await this.redis.get(key);
      if (hit) return of(JSON.parse(hit));
    } catch { /* cache is best-effort */ }

    return next.handle().pipe(
      tap((data) => {
        if (data && typeof data === 'object') void this.redis.set(key, JSON.stringify(data), opts.ttlSeconds).catch(() => {});
      }),
    );
  }
}
