import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, tap } from 'rxjs';
import { RedisService } from '../redis/redis.service';

const PUBLIC_CACHE_META = 'solvexo:public-cache';

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
