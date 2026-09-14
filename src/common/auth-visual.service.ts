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

/** A short, context-appropriate search hint appended to the country name —
 *  each one chosen to actually evoke what that SPECIFIC screen means for a
 *  seller setting up/running their Solvexo store, not just "a nice generic
 *  shop photo" repeated 6 times with different words. Confirmed against the
 *  real Unsplash Search API (not guessed) that each hint below returns
 *  genuinely on-topic results:
 *  - `register`      → joining Solvexo to start a business — a real person
 *                       opening/starting a new shop
 *  - `login`          → returning to run your own store — a shop storefront
 *  - `onboarding`     → literally setting up a new store (the most literal
 *                       one) — a shopkeeper actively setting up shop
 *  - `forgot_password`→ locked out of your account — a shop's own locked
 *                       door/key (the closest real-photo equivalent to
 *                       "locked out, forgot how to get back in")
 *  - `otp`            → confirming it's really you — a shop counter moment
 *                       of checking/verifying identity
 *  - `new_password`   → a fresh start after resetting access — a new shop's
 *                       grand opening
 *  Deliberately NOT worded as "marketplace" anywhere — per this project's
 *  own documented pivot, Solvexo moved away from a central marketplace
 *  model to a Shopify-style standalone-per-seller-store model, so
 *  "marketplace" would misrepresent what Solvexo actually is today. */
const CONTEXT_QUERY_HINT: Record<AuthPageContext, string> = {
  register: 'entrepreneur opening new shop',
  login: 'shop storefront',
  onboarding: 'shopkeeper setting up store',
  forgot_password: 'shop owner locked door key',
  otp: 'shop counter identity verification',
  new_password: 'new shop grand opening',
};

/**
 * Real, live, per-COUNTRY (not per-region) background photo for the auth
 * screens — resolved at request time via Unsplash's real keyword-relevance
 * Search Photos API (`api.unsplash.com/search/photos`), queried with the
 * visitor's real detected country name + a page-appropriate keyword,
 * instead of picking from a small pre-curated list of regions. This is what
 * makes the photo genuinely specific to e.g. Vanuatu or Eswatini, not just
 * "whichever of 10 buckets that country happens to fall into." (Unsplash's
 * separate Random Photo endpoint was tried first and dropped — confirmed by
 * live testing that it does not do real relevance matching for a
 * multi-word query, e.g. returning a completely unrelated portrait for
 * "Pakistan market vendor stall" where Search correctly returns a real,
 * captioned Pakistani market photo for the same query.)
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
   * commerce term (e.g. "Vanuatu shop", "Kenya marketplace") returns zero
   * search results for a real number of smaller/less-photographed
   * countries, even though Unsplash does have SOME photos for nearly every
   * country. Rather than let that empty result immediately give up the
   * "live, genuinely THIS country" promise and fall all the way back to the
   * old static curated-region photo, this degrades in 3 steps:
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
      // Unsplash's Random Photo endpoint (`/photos/random?query=`) was used
      // here originally, but live testing (confirmed by hand, not assumed)
      // showed it does NOT do real relevance matching for a multi-word query
      // like "Pakistan market vendor stall" — it can return something as
      // unrelated as a random portrait of a man on a bench. Its own real
      // keyword-relevance Search endpoint (`/search/photos`) returns
      // genuinely on-topic results for the exact same query (e.g. a real
      // captioned "colorful market... in the Swat Valley of Pakistan" photo)
      // — this is what actually makes the per-country+per-page photo make
      // sense, which is the whole point of this service. `per_page=8` gives
      // a small pool to pick from (below) instead of Search's own top-1
      // result every time, so the same country+context pair (cached 30
      // days) doesn't always land on the exact same photo across different
      // countries that happen to share a query shape.
      const resp = await fetch(
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=portrait&content_filter=high&per_page=8`,
        {
          headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
          signal: controller.signal,
        },
      );
      if (!resp.ok) {
        this.logger.warn(`Unsplash photo search failed (${resp.status}) for "${query}"`);
        return null;
      }
      const data: any = await resp.json();
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      // Zero matches is the expected, common case that drives the query
      // ladder above (a compound query like "Vanuatu market vendor stall"
      // can genuinely have no matching photos) — not a real failure, so not
      // logged as a warning.
      if (results.length === 0) return null;
      const photo = results[Math.floor(Math.random() * results.length)];
      const rawUrl: string | undefined = photo?.urls?.raw;
      if (!rawUrl) return null;

      // Same crop/format/quality transform every curated photo in
      // `auth-visual-region.const.ts` already uses, so a live photo looks
      // visually consistent with a fallback one.
      const imageUrl = `${rawUrl}&crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200`;

      // Fire-and-forget the download-tracking ping Unsplash's API
      // Guidelines require when a photo obtained via the API is actually
      // used — never awaited, never allowed to fail the request.
      const downloadLocation: string | undefined = photo?.links?.download_location;
      if (downloadLocation) {
        fetch(downloadLocation, { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } })
          .catch(() => {});
      }

      const name: string | undefined = photo?.user?.name;
      const profileUrl: string | undefined = photo?.user?.links?.html;
      const attribution = name && profileUrl ? { name, profileUrl } : null;

      return { imageUrl, attribution };
    } catch (err) {
      this.logger.warn(`Unsplash photo search errored for "${query}": ${(err as Error)?.message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
