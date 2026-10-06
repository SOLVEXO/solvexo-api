import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { RedisService } from '../redis/redis.service';
import { resolveCountryName } from './country-names.const';
import {
  type AuthPageContext,
  type AuthVisualRegion,
  type AuthVisualTopic,
  resolveAuthVisualRegion,
  resolveAuthVisualImageUrl,
  isModestCultureCountry,
} from './auth-visual-region.const';

export interface AuthVisualResult {
  region: AuthVisualRegion;
  imageUrl: string;
  /** Unsplash API Guidelines require visible photo credit for API photos.
   *  Null only for the static fail-safe photo. */
  attribution: { name: string; profileUrl: string } | null;
}

const FETCH_TIMEOUT_MS = 4000;
const VETTING_TIMEOUT_MS = 6000;
/** Candidates the AI looks at in parallel per search query. */
const VETTING_BATCH = 3;
/** AI-approved photos kept per country+screen, and how long they live. */
const POOL_SIZE = 3;
const POOL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 10 * 60 * 1000;

interface PoolItem {
  imageUrl: string;
  attribution: { name: string; profileUrl: string } | null;
  downloadLocation?: string;
}

/** What each screen / onboarding step is ABOUT, as a search phrase. Every phrase
 *  is people-free (storefronts, goods, desks): a person-centric query
 *  ("shopkeeper", "entrepreneur") surfaces fashion/portrait shots that are
 *  off-brand and unsuitable in many cultures. */
const CONTEXT_QUERY_HINT: Record<AuthPageContext, string> = {
  register: 'shop storefront',
  login: 'market street shops',
  onboarding: 'small business storefront',
  forgot_password: 'shop door key',
  otp: 'shop counter',
  new_password: 'new shop opening',
  // Onboarding step 1 — naming/branding the store
  onboarding_store: 'shop signboard branding',
  // Onboarding step 3 — what kind of seller
  onboarding_seller_type: 'products display shelf',
  // Onboarding step 4 — what will you sell (overridden by seller topic below)
  onboarding_products: 'packaged products',
};

/** On the "What will you sell?" step the photo follows the seller type picked
 *  on the previous step. */
const TOPIC_QUERY_HINT: Record<AuthVisualTopic, string> = {
  creator: 'designer desk laptop tablet',
  educator: 'books stationery desk',
  retailer: 'retail shop shelves products',
  brand_business: 'packaged products brand boxes',
  freelancer: 'parcels packages warehouse',
  mix: 'market stall goods',
};

/** Never shown anywhere: results whose text metadata mentions these. */
const BLOCKED_ALWAYS =
  /\b(woman|women|girl|girls|lady|ladies|female|model|models|bikini|swimsuit|swimwear|lingerie|underwear|bra|nude|naked|topless|sexy|cleavage|dress|dresses|fashion|portrait|glamour|beauty)\b/i;

const STRICT_BLOCKED_PEOPLE =
  // Includes Unsplash's own machine-generated tags (derived from the pixels,
  // not from what the photographer typed): person/human/face/clothing/…
  /\b(person|people|man|men|boy|boys|child|children|kid|kids|crowd|human|couple|family|customer|vendor|seller|shopkeeper|worker|group|hand|hands|face|head|finger|skin|smile|smiling|hair|clothing|apparel|sleeve|footwear|shoe|pants|jeans|shirt|glasses|sunglasses|selfie|pose|posing|walking|standing|sitting)\b/i;
const STRICT_ALLOWED_SUBJECT =
  /\b(shop|shops|store|stores|market|markets|bazaar|souk|building|buildings|street|architecture|product|products|goods|shelf|shelves|display|stall|mosque|city|landscape|package|packages|boxes|desk|laptop|books|stationery|sign|signboard)\b/i;

/** Additionally blocked for Muslim-majority countries. */
const BLOCKED_MODEST =
  /\b(alcohol|wine|beer|cocktail|whiskey|vodka|liquor|pub|bar|nightclub|club|casino|gambling|pork|bacon|party|dating|couple|kiss|kissing)\b/i;

/**
 * Live, per-visitor background photo for the auth screens, fetched directly
 * from Unsplash per request — nothing is cached or stored on our side.
 *
 * Inputs: the visitor's IP-detected country, the screen/onboarding step
 * (`context`) and, on the last onboarding step, the chosen seller type
 * (`topic`). Candidates pass a cheap text filter (`isSuitable`), then Claude
 * vision actually LOOKS at the photo (`vetPhoto`) — stricter for
 * Muslim-majority countries, where an unchecked photo is never shown.
 * Needs `ANTHROPIC_API_KEY` (model: `AUTH_VISUAL_VETTING_MODEL`, default Haiku 4.5).
 *
 * Needs `UNSPLASH_ACCESS_KEY`. A Demo-mode Unsplash app is capped at 50
 * requests/hour (5000 after Production approval) — with no cache every auth
 * screen view is one request (up to 3 when the query ladder falls through).
 *
 * Fails open (no key, network error, timeout, nothing suitable): returns the
 * hand-reviewed static photo for the visitor's region so a screen never breaks.
 */
@Injectable()
export class AuthVisualService {
  private readonly logger = new Logger(AuthVisualService.name);

  constructor(private readonly redis: RedisService) {}

  async resolve(country: string | null, context: AuthPageContext, topic?: AuthVisualTopic): Promise<AuthVisualResult> {
    const region = resolveAuthVisualRegion(country);
    const fallback: AuthVisualResult = {
      region,
      imageUrl: resolveAuthVisualImageUrl(region, context),
      attribution: null,
    };

    const accessKey = process.env.UNSPLASH_ACCESS_KEY;
    const countryName = resolveCountryName(country);
    if (!accessKey || !countryName) return fallback;

    // ZERO delay: never wait on Unsplash/Claude inside the request. If an
    // AI-approved pool for this country+screen exists, serve one from it
    // instantly; otherwise serve the static reviewed photo right now and
    // build the pool in the background for the next visitors.
    const key = `${country}:${context}:${topic ?? ''}`;
    const pool = await this.readPool(key);
    if (pool && pool.length > 0) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick.downloadLocation) {
        fetch(pick.downloadLocation, { headers: { Authorization: `Client-ID ${accessKey}` } }).catch(() => {});
      }
      return { region, imageUrl: pick.imageUrl, attribution: pick.attribution };
    }
    this.warmPool(key, countryName, context, topic, isModestCultureCountry(country));
    return fallback;
  }

  // ── AI-approved photo pools (only photos Claude already approved are kept) ──
  private readonly pools = new Map<string, { items: PoolItem[]; expires: number }>();
  private readonly warming = new Set<string>();

  private async readPool(key: string): Promise<PoolItem[] | null> {
    const hit = this.pools.get(key);
    if (hit && hit.expires > Date.now()) return hit.items;
    try {
      const raw = await this.redis.get(`auth-visual:v3:${key}`);
      if (raw) {
        const items: PoolItem[] = JSON.parse(raw);
        this.pools.set(key, { items, expires: Date.now() + POOL_TTL_MS });
        return items;
      }
    } catch {
      // Redis unavailable — memory pool above still works.
    }
    return null;
  }

  private warmPool(key: string, countryName: string, context: AuthPageContext, topic: AuthVisualTopic | undefined, modest: boolean): void {
    const retryAt = this.pools.get(`retry:${key}`);
    if (this.warming.has(key) || (retryAt && retryAt.expires > Date.now())) return;
    this.warming.add(key);
    this.buildPool(countryName, context, topic, modest)
      .then(async items => {
        if (items.length === 0) {
          // Nothing approved (or AI unavailable): don't hammer the APIs again right away.
          this.pools.set(`retry:${key}`, { items: [], expires: Date.now() + RETRY_AFTER_MS });
          return;
        }
        this.pools.set(key, { items, expires: Date.now() + POOL_TTL_MS });
        try {
          await this.redis.set(`auth-visual:v3:${key}`, JSON.stringify(items), POOL_TTL_MS / 1000);
        } catch {
          // best-effort
        }
      })
      .catch(err => this.logger.warn(`Pool build failed for ${key}: ${(err as Error)?.message}`))
      .finally(() => this.warming.delete(key));
  }

  private client: Anthropic | null | undefined;
  private getClient(): Anthropic | null {
    if (this.client === undefined) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      this.client = apiKey ? new Anthropic({ apiKey, timeout: VETTING_TIMEOUT_MS, maxRetries: 0 }) : null;
    }
    return this.client;
  }

  /**
   * Looks at the actual photo (Claude vision) and decides if it may be shown.
   * Returns true/false, or `null` when the check itself could not run.
   */
  private async vetPhoto(
    thumbUrl: string,
    countryName: string,
    subject: string,
    modest: boolean,
  ): Promise<boolean | null> {
    const client = this.getClient();
    if (!client) return null;
    const rules = [
      'No woman, girl, model or fashion/portrait shot. No revealing clothing. No nudity or sexual content.',
      'It must be a clean, professional, brand-safe commerce-style image (shop, storefront, market, products, workspace, packages).',
      `It should plausibly fit "${subject}" for a seller in ${countryName}.`,
      ...(modest
        ? [
            `Viewer is in a conservative Muslim-majority country (${countryName}): also reject anything against Islamic modesty norms — alcohol, nightlife, gambling, pork products, couples/romance, or any depiction of women. Prefer products, buildings, markets, men at work, or no people.`,
          ]
        : []),
      'Reject if unsure.',
    ].join('\n');
    try {
      const msg = await client.messages.create({
        model: process.env.AUTH_VISUAL_VETTING_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: thumbUrl } },
            { type: 'text', text: `Decide if this photo may be shown as the background of a seller sign-up page.\n${rules}\nAnswer with ONLY JSON: {"ok":true} or {"ok":false}` },
          ],
        }],
      });
      const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
      if (/"ok"\s*:\s*true/i.test(text)) return true;
      if (/"ok"\s*:\s*false/i.test(text)) return false;
      return null;
    } catch (err) {
      this.logger.warn(`Photo vetting failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /** Most specific first: country + this screen's subject, then country +
   *  generic market, then country alone — all pass through the same filter. */
  private buildQueryLadder(countryName: string, context: AuthPageContext, topic?: AuthVisualTopic): string[] {
    const hint = context === 'onboarding_products' && topic ? TOPIC_QUERY_HINT[topic] : CONTEXT_QUERY_HINT[context];
    return [`${countryName} ${hint}`, `${countryName} market shop`, `${countryName} street`];
  }

  /** No-AI fallback for conservative countries: the photo's own text must name a
   *  safe subject (shop/market/building/products…) and mention no people. */
  private isStrictSafe(photo: any): boolean {
    const tags: string[] = Array.isArray(photo?.tags) ? photo.tags.map((t: any) => String(t?.title ?? '')) : [];
    const text = [photo?.alt_description, photo?.description, ...tags].filter(Boolean).join(' ');
    if (!text) return false;
    if (STRICT_BLOCKED_PEOPLE.test(text)) return false;
    return STRICT_ALLOWED_SUBJECT.test(text);
  }

  private isSuitable(photo: any, modest: boolean): boolean {
    const tags: string[] = Array.isArray(photo?.tags) ? photo.tags.map((t: any) => String(t?.title ?? '')) : [];
    const text = [photo?.alt_description, photo?.description, ...tags].filter(Boolean).join(' ');
    if (BLOCKED_ALWAYS.test(text)) return false;
    if (modest && BLOCKED_MODEST.test(text)) return false;
    return true;
  }

  /** Searches Unsplash and keeps up to POOL_SIZE photos the AI approved. Runs in
   *  the background only — never inside a user request. */
  private async buildPool(
    countryName: string,
    context: AuthPageContext,
    topic: AuthVisualTopic | undefined,
    modest: boolean,
  ): Promise<PoolItem[]> {
    const subject = context === 'onboarding_products' && topic ? TOPIC_QUERY_HINT[topic] : CONTEXT_QUERY_HINT[context];
    const pool: PoolItem[] = [];
    for (const query of this.buildQueryLadder(countryName, context, topic)) {
      const candidates = await this.fetchCandidates(query, modest);
      for (let i = 0; i < candidates.length && pool.length < POOL_SIZE; i += VETTING_BATCH) {
        const batch = candidates.slice(i, i + VETTING_BATCH);
        const verdicts = await Promise.all(
          batch.map(p => this.vetPhoto(`${p.urls.raw}&w=480&q=60&fm=jpg&fit=max`, countryName, subject, modest)),
        );
        // The AI could not run at all (no key / API error): for a conservative
        // country keep nothing unchecked (callers keep serving the static
        // reviewed photo); elsewhere the text filter alone is acceptable.
        if (verdicts.every(v => v === null)) {
          // Without the AI check: conservative countries only get photos whose
          // text clearly says "no people, just shops/products/buildings".
          const safe = modest ? batch.filter(p => this.isStrictSafe(p)) : batch.slice(0, 1);
          for (const p of safe) if (pool.length < POOL_SIZE) pool.push(this.toPoolItem(p));
          if (pool.length > 0 || !modest) return pool;
          continue;
        }
        batch.forEach((p, j) => { if (verdicts[j] === true && pool.length < POOL_SIZE) pool.push(this.toPoolItem(p)); });
      }
      if (pool.length >= POOL_SIZE) break;
    }
    return pool;
  }

  private toPoolItem(photo: any): PoolItem {
    const name: string | undefined = photo?.user?.name;
    const profileUrl: string | undefined = photo?.user?.links?.html;
    return {
      imageUrl: `${photo.urls.raw}&crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200`,
      attribution: name && profileUrl ? { name, profileUrl } : null,
      downloadLocation: photo?.links?.download_location,
    };
  }

  /** Unsplash search → text-filtered candidates, shuffled. */
  private async fetchCandidates(query: string, modest: boolean): Promise<any[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // Search (not Random) endpoint: real keyword relevance. per_page=30 (the
      // max) leaves enough candidates after the suitability filter.
      const resp = await fetch(
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=portrait&content_filter=high&per_page=30`,
        {
          headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
          signal: controller.signal,
        },
      );
      if (!resp.ok) {
        this.logger.warn(`Unsplash photo search failed (${resp.status}) for "${query}"`);
        return [];
      }
      const data: any = await resp.json();
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      const suitable = results.filter(p => p?.urls?.raw && this.isSuitable(p, modest));
      // Fisher–Yates shuffle so repeat visitors don't always see the same top hit.
      for (let i = suitable.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [suitable[i], suitable[j]] = [suitable[j], suitable[i]];
      }
      return suitable;
    } catch (err) {
      this.logger.warn(`Unsplash photo search errored for "${query}": ${(err as Error)?.message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
