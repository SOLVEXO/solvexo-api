/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../database/databaseservice';

export const STOREFRONT_TOKEN_HEADER = 'x-storefront-token';
const TOKEN_TYPE = 'storefront_access';
const TOKEN_TTL = '12h';
const GATE_CACHE_MS = 10_000;

type Req = { method?: string; path?: string; originalUrl?: string; query?: any; body?: any; headers?: any };

/** How the store id is found for a public, buyer-facing route (first match wins). `param`: path regex whose group 1 is the storeId;
 *  `product` / `variant`: group 1 is a product / variant id; `ctx`: query `storeId`, else JSON body `storeId` (legacy/global buyers), else the caller's JWT `storeId`, else the store of body `checkoutId` (payment). */
const RULES: Array<{ re: RegExp; kind: 'param' | 'product' | 'variant' | 'ctx' }> = [
  { re: /^\/api\/store\/public\/([^/]+)\/(products|filters)\/?$/, kind: 'param' },
  { re: /^\/api\/products\/store\/([^/]+)\/(pinned|new-arrivals|best-sellers|trending)\/?$/, kind: 'param' },
  { re: /^\/api\/public\/(?:collections|store-pages|store-theme|store-blog|store-banners|collection-template)\/([^/]+)(?:\/|$)/, kind: 'param' },
  { re: /^\/api\/products\/getProductById\/([^/]+)\/?$/, kind: 'product' },
  { re: /^\/api\/products\/preview\/([^/]+)\/?$/, kind: 'product' },
  { re: /^\/api\/products\/getVariantById\/([^/]+)\/?$/, kind: 'variant' },
  { re: /^\/api\/products\/products-by-category\/?$/, kind: 'ctx' },
  { re: /^\/api\/search\/products\/?$/, kind: 'ctx' },
  { re: /^\/api\/public\/search\/(suggest|content)\/?$/, kind: 'ctx' },
  { re: /^\/api\/cart\/(add-to-cart|get-cart|update-cart-quantity|remove-cart-item|clear-cart|add-to-wishlist|get-wishlist|get-wishlist-item|remove-from-wishlist|clear-wishlist)\/?$/, kind: 'ctx' },
  { re: /^\/api\/checkout\/create-checkout\/?$/, kind: 'ctx' },
  { re: /^\/api\/payment\/(cod-payment|store-credit-payment|initiate-payment)\/?$/, kind: 'ctx' },
];

/** Shopify "password page" / holding page, enforced server-side: while `Store.privacyMode` is 'password', buyer-facing storefront reads/writes need a
 *  short-lived `x-storefront-token` minted by the verify route; while 'coming_soon' nothing unlocks it (reason:'coming_soon'). Seller/staff/admin of that store pass without it. Applied once as a global
 *  middleware (see main.ts) over the RULES table, so individual controllers need no change. Not-password stores cost one cached lookup. */
@Injectable()
export class StorefrontAccessService {
  private gateCache = new Map<string, { at: number; mode: string; sellerId: string | null }>();

  constructor(private readonly db: DatabaseService, private readonly jwt: JwtService) {}

  signToken(storeId: string): string {
    return this.jwt.sign({ type: TOKEN_TYPE, storeId: String(storeId) }, { expiresIn: TOKEN_TTL });
  }

  hasValidToken(token: string | undefined, storeId: string): boolean {
    if (!token) return false;
    try {
      const p: any = this.jwt.verify(token);
      return p?.type === TOKEN_TYPE && String(p.storeId) === String(storeId);
    } catch {
      return false;
    }
  }

  private async gateState(storeId: string) {
    const hit = this.gateCache.get(storeId);
    if (hit && Date.now() - hit.at < GATE_CACHE_MS) return hit;
    let state = { at: Date.now(), mode: 'public', sellerId: null as string | null };
    try {
      const s: any = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('privacyMode sellerId').lean();
      if (s) state = { at: Date.now(), mode: s.privacyMode ?? 'public', sellerId: s.sellerId ?? null };
    } catch {
      /* unknown/invalid id: let the controller 404 */
    }
    if (this.gateCache.size > 2000) this.gateCache.clear();
    this.gateCache.set(storeId, state);
    return state;
  }

  /** Drop the cached gate state (call after the seller changes privacy). */
  invalidate(storeId: string) { this.gateCache.delete(String(storeId)); }

  private bearer(req: Req): any | null {
    const auth: string | undefined = req.headers?.authorization;
    const t = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!t) return null;
    try { return this.jwt.verify(t); } catch { return null; }
  }

  /** Store id the request targets, or null when the route is not a gated storefront route. */
  async resolveStoreId(req: Req): Promise<string | null> {
    const path = (req.path || (req.originalUrl || '').split('?')[0] || '');
    for (const rule of RULES) {
      const m = rule.re.exec(path);
      if (!m) continue;
      if (rule.kind === 'param') return decodeURIComponent(m[1]);
      if (rule.kind === 'ctx') {
        const q = req.query?.storeId;
        if (typeof q === 'string' && q) return q;
        // JSON body storeId (legacy/global buyers send it only there). main.ts registers the JSON parser before this middleware.
        const b = req.body?.storeId;
        if (typeof b === 'string' && b) return b;
        const sid = this.bearer(req)?.storeId;
        if (typeof sid === 'string' && sid) return sid;
        // Payment routes: resolve the store from the checkout being paid.
        const cid = req.body?.checkoutId;
        if (typeof cid === 'string' && cid) {
          try {
            const c: any = await (this.db.repositories as any).checkoutModel.findById(cid).select('items.storeId').lean();
            const s0 = c?.items?.[0]?.storeId;
            return s0 ? String(s0) : null;
          } catch {
            return null;
          }
        }
        return null;
      }
      try {
        const repos = this.db.repositories as any;
        if (rule.kind === 'product') {
          const p = await repos.productModel.findById(m[1]).select('storeId').lean();
          return p?.storeId ? String(p.storeId) : null;
        }
        const v = await repos.productVariantModel.findById(m[1]).select('productId').lean();
        const p = v?.productId ? await repos.productModel.findById(v.productId).select('storeId').lean() : null;
        return p?.storeId ? String(p.storeId) : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Throws 403 `{ storefrontLocked: true }` when the request targets a password-protected store without a valid token. */
  async assertAccess(req: Req): Promise<void> {
    if (req.method === 'OPTIONS') return;
    const storeId = await this.resolveStoreId(req);
    if (!storeId) return;
    const gate = await this.gateState(storeId);
    if (gate.mode !== 'password' && gate.mode !== 'coming_soon') return;
    const comingSoon = gate.mode === 'coming_soon';
    const hdr = req.headers?.[STOREFRONT_TOKEN_HEADER];
    // coming_soon has no password, so no storefront token can unlock it.
    if (!comingSoon && this.hasValidToken(Array.isArray(hdr) ? hdr[0] : hdr, storeId)) return;
    const u = this.bearer(req);
    if (u) {
      if (u.role === 'admin') return;
      if (u.role === 'seller' && gate.sellerId && String(u.sub) === String(gate.sellerId)) return;
      if (u.role === 'staff' && String(u.storeId) === String(storeId)) return;
    }
    throw new ForbiddenException(
      comingSoon
        ? { statusCode: 403, message: 'This store is not open yet', storefrontLocked: true, reason: 'coming_soon' }
        : { statusCode: 403, message: 'This store is password protected', storefrontLocked: true, reason: 'password' },
    );
  }
}

export function createStorefrontAccessMiddleware(svc: StorefrontAccessService) {
  return async (req: any, res: any, next: (e?: any) => void) => {
    try {
      await svc.assertAccess(req);
    } catch (e: any) {
      if (e instanceof ForbiddenException) return res.status(403).json(e.getResponse());
    }
    return next();
  };
}
