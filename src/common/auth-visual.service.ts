import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { resolveCountryName } from './country-names.const';
import {
  type AuthPageContext,
  type AuthVisualRegion,
  resolveAuthVisualRegion,
  resolveAuthVisualImageUrl,
} from './auth-visual-region.const';

export interface AuthVisualResult {
  region: AuthVisualRegion;
  imageUrl: string;
  /** Photo credit — only present for a live (Unsplash API) result, per
   *  Unsplash's API Guidelines (hotlinking their photos requires visible
   *  attribution). Absent for a curated/fallback photo — those already
   *  carry no such obligation since they're static, pre-cleared assets. */
  attribution: { name: string; profileUrl: string } | null;
}

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — see file-level note below
const FETCH_TIMEOUT_MS = 4000;

/** A short, context-appropriate search hint appended to the country name.
 *  Every one of these is deliberately commerce/store-flavored, not a
 *  generic tourist landmark/skyline/landscape — Solvexo IS a store-
 *  building/commerce platform, so every auth screen's photo should read
 *  as "shopping, trade, a real local business" in that country, never
 *  just "a nice photo of that country." Deliberately NOT worded as
 *  "marketplace" anywhere — per this project's own documented pivot,
 *  Solvexo moved away from a central marketplace model to a Shopify-style
 *  standalone-per-seller-store model, so "marketplace" would misrepresent
 *  what Solvexo actually is today. Each context still gets its own
 *  distinct hint (so the 6 screens don't show the same photo), but all 6
 *  stay inside that same commerce theme:
 *  - `register`  → starting to shop/sell — a real shopping street
 *  - `login`     → returning to your own storefront
 *  - `onboarding`→ literally setting up a new store (the most literal one)
 *  - `forgot_password` → a market/bazaar scene (still commerce, just varied)
 *  - `otp`        → a shop counter/checkout moment (loosely echoes "verifying")
 *  - `new_password` → a boutique storefront (a fresh start, still retail) */
const CONTEXT_QUERY_HINT: Record<AuthPageContext, string> = {
  register: 'shopping street',
  login: 'shop storefront',
  onboarding: 'local market shop',
  forgot_password: 'market vendor stall',
  otp: 'shop counter checkout',
  new_password: 'boutique storefront',
};

/**
 * Real, live, per-COUNTRY (not per-region) background photo for the auth
 * screens — resolved at request time via Unsplash's actual Random Photo API
 * (`api.unsplash.com/photos/random`), queried with the visitor's real
 * detected country name + a page-appropriate keyword, instead of picking
 * from a small pre-curated list of regions. This is what makes the photo
 * genuinely specific to e.g. Vanuatu or Eswatini, not just "whichever of 10
 * buckets that country happens to fall into."
 *
 * Requires `UNSPLASH_ACCESS_KEY` (a free Unsplash Developer app's Access
 * Key — see https://unsplash.com/developers). **Without it, this silently
 * behaves exactly like before this service existed** — falls straight
 * through to the curated 10-region map in `auth-visual-region.const.ts`,
 * so a fresh clone/local-dev environment with no key configured never
 * breaks, it just doesn't get the live per-country upgrade.
 *
 * **Real, disclosed constraint, not silently glossed over:** a newly
 * registered Unsplash app starts in "Demo" mode — capped at 50 requests/
 * hour — until Unsplash manually approves it for "Production" (5000/hour),
 * a one-time step done from the Unsplash developer dashboard, not
 * something this code can do for you. Redis caching below (30 days per
 * country+context pair) keeps this workable even on the Demo cap in
 * practice — after the first visitor from a given country hits a given
 * screen, every subsequent visitor from that same country on that same
 * screen for the next 30 days is served from cache, not a fresh API call
 * — but a brand-new site with visitors from many different countries in
 * the first hour could still exhaust the Demo cap before Production
 * approval comes through. That's a real Unsplash-side rate limit, not a
 * bug in this integration.
 *
 * Fails open at every step (no key, network error, timeout, non-200,
 * empty result, Redis unavailable) — this must never be the reason an
 * auth screen breaks or hangs, so any failure silently returns the
 * existing curated-region photo instead of throwing.
 */
@Injectable()
export class AuthVisualService {
  private readonly logger = new Logger(AuthVisualService.name);

  constructor(private readonly redis: RedisService) {}

  async resolve(country: string | null, context: AuthPageContext): Promise<AuthVisualResult> {
    const region = resolveAuthVisualRegion(country);
    const fallback: AuthVisualResult = {
      region,
      imageUrl: resolveAuthVisualImageUrl(region, context),
      attribution: null,
    };

    const accessKey = process.env.UNSPLASH_ACCESS_KEY;
    const countryName = resolveCountryName(country);
    if (!accessKey || !countryName) return fallback;

    const cacheKey = `auth-visual:v1:${country}:${context}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return { region, ...JSON.parse(cached) };
    } catch {
      // Redis read failed — fall through to a live fetch attempt below
      // rather than giving up; a cache-write failure later is likewise
      // non-fatal (best-effort only).
    }

    const live = await this.fetchLive(countryName, context);
    if (!live) return fallback;

    try {
      await this.redis.set(cacheKey, JSON.stringify(live), CACHE_TTL_SECONDS);
    } catch {
      // Best-effort — a caching failure must not fail the request itself.
    }
    return { region, ...live };
  }

  /**
   * A 3-step query ladder, most-specific first — confirmed necessary by
   * live testing against the real Unsplash API: a country + a specific
   * commerce term (e.g. "Vanuatu shop", "Kenya marketplace") 404s
   * ("No photos found") for a real number of smaller/less-photographed
   * countries, even though Unsplash does have SOME photos for nearly every
   * country. Rather than let that 404 immediately give up the "live,
   * genuinely THIS country" promise and fall all the way back to the old
   * static curated-region photo, this degrades in 3 steps:
   *   1. `{country} {page-specific commerce hint}` — best case: both
   *      page-relevant AND on-brand for Solvexo being a shop/marketplace.
   *   2. `{country} market` — a broader, near-universally-available
   *      commerce term, still on-brand, just less page-specific.
   *   3. `{country}` alone — no commerce framing left, but (per live
   *      testing) this succeeds for virtually every real country,
   *      including ones step 1/2 both failed for (Nauru, Tuvalu, etc.) —
   *      still a genuine, live, THIS-COUNTRY photo, which is a better
   *      outcome than silently reverting to the generic curated fallback.
   * Only if all 3 genuinely return nothing does `resolve()` fall back to
   * the curated region map.
   */
  private buildQueryLadder(countryName: string, context: AuthPageContext): string[] {
    return [
      `${countryName} ${CONTEXT_QUERY_HINT[context]}`,
      `${countryName} market`,
      countryName,
    ];
  }

  private async fetchLive(
    countryName: string,
    context: AuthPageContext,
  ): Promise<{ imageUrl: string; attribution: { name: string; profileUrl: string } | null } | null> {
    for (const query of this.buildQueryLadder(countryName, context)) {
      const result = await this.fetchLiveForQuery(query);
      if (result) return result;
    }
    return null;
  }

  private async fetchLiveForQuery(
    query: string,
  ): Promise<{ imageUrl: string; attribution: { name: string; profileUrl: string } | null } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(
        `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=portrait&content_filter=high`,
        {
          headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
          signal: controller.signal,
        },
      );
      if (!resp.ok) {
        // A 404 "No photos found" is the expected, common case that drives
        // the query ladder above — not logged as a warning, since it isn't
        // a real failure. Anything else (401/403/5xx/network-level) is.
        if (resp.status !== 404) {
          this.logger.warn(`Unsplash random-photo lookup failed (${resp.status}) for "${query}"`);
        }
        return null;
      }
      const data: any = await resp.json();
      const rawUrl: string | undefined = data?.urls?.raw;
      if (!rawUrl) return null;

      // Same crop/format/quality transform every curated photo in
      // `auth-visual-region.const.ts` already uses, so a live photo looks
      // visually consistent with a fallback one.
      const imageUrl = `${rawUrl}&crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200`;

      // Fire-and-forget the download-tracking ping Unsplash's API
      // Guidelines require when a photo obtained via the API is actually
      // used — never awaited, never allowed to fail the request.
      const downloadLocation: string | undefined = data?.links?.download_location;
      if (downloadLocation) {
        fetch(downloadLocation, { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } })
          .catch(() => {});
      }

      const name: string | undefined = data?.user?.name;
      const profileUrl: string | undefined = data?.user?.links?.html;
      const attribution = name && profileUrl ? { name, profileUrl } : null;

      return { imageUrl, attribution };
    } catch (err) {
      this.logger.warn(`Unsplash random-photo lookup errored for "${query}": ${(err as Error)?.message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
