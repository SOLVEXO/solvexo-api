/* eslint-disable prettier/prettier */
import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * Tells Vercel's CDN that a store's cached storefront pages are out of date, so a seller's publish shows up within seconds
 * instead of waiting for the page cache to expire (30 s fresh + up to 120 s stale).
 *
 * Every storefront page the web app serves carries the response header `Vercel-Cache-Tag: store-<storeId>`
 * (`solvexo-web/api/storefront-document.js`). This calls Vercel's "invalidate by tag" REST endpoint
 * (POST https://api.vercel.com/v1/edge-cache/invalidate-by-tags, body { tags, target }, query projectIdOrName + optional teamId; checked
 * against Vercel's REST reference on 2026-11-24): the cached copies are served stale and refreshed in the background.
 *
 * Needs the same environment the custom-domain feature already uses: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, and VERCEL_TEAM_ID when the
 * project belongs to a team. Without them every call is a silent no-op. A purge can never fail or slow the action that caused it:
 * it is debounced, runs in the background and only logs a warning when Vercel refuses.
 */
@Injectable()
export class StorefrontCachePurgeService {
  private readonly logger = new Logger(StorefrontCachePurgeService.name);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Wait a moment so a burst of saves (and the database commit of the publish itself) becomes ONE purge. */
  private readonly delayMs = 1500;

  private get token() { return process.env.VERCEL_API_TOKEN?.trim(); }
  private get projectId() { return process.env.VERCEL_PROJECT_ID?.trim(); }
  private get teamId() { return process.env.VERCEL_TEAM_ID?.trim(); }

  /** The running instance, so code that is built without dependency injection (and its unit tests) can call `purge` too. */
  private static current: StorefrontCachePurgeService | null = null;
  constructor() { StorefrontCachePurgeService.current = this; }

  /** Marks one store's cached pages stale. A no-op until the service exists and Vercel is configured. */
  static purge(storeId: unknown): void { StorefrontCachePurgeService.current?.purgeStore(storeId); }

  isConfigured(): boolean { return !!(this.token && this.projectId); }

  /** The tag the web app puts on every page of this store. */
  static tagFor(storeId: string): string { return `store-${storeId}`; }

  /** Marks one store's cached pages stale (debounced). Safe to call from anywhere, with anything. */
  purgeStore(storeId: unknown): void {
    if (!this.isConfigured() || typeof storeId !== 'string' || !/^[a-f0-9]{24}$/i.test(storeId)) return;
    const existing = this.timers.get(storeId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(storeId);
      void this.invalidate([StorefrontCachePurgeService.tagFor(storeId)]);
    }, this.delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(storeId, timer);
  }

  private async invalidate(tags: string[]): Promise<void> {
    try {
      const url = new URL('https://api.vercel.com/v1/edge-cache/invalidate-by-tags');
      url.searchParams.set('projectIdOrName', this.projectId as string);
      if (this.teamId) url.searchParams.set('teamId', this.teamId);
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags, target: 'production' }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) this.logger.warn(`Vercel cache purge for ${tags.join(',')} answered HTTP ${res.status}`);
    } catch (error) {
      this.logger.warn(`Vercel cache purge failed: ${(error as Error)?.message}`);
    }
  }
}

/** Global so any service can ask for a purge without importing a module. Registered once in AppModule. */
@Global()
@Module({ providers: [StorefrontCachePurgeService], exports: [StorefrontCachePurgeService] })
export class StorefrontCachePurgeModule {}
