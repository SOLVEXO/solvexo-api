/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { availableStock } from '../common/stock-availability.util';
import { bundleAvailability, validateBundleShape } from '../common/bundle.util';
import { normalizePreorderInput, preorderPublicView } from '../common/preorder.util';

export const MAX_RECOMMENDATIONS = 12;
export const CART_UPSELL_MODES = ['complementary', 'related', 'best_sellers'] as const;
export type CartUpsellMode = (typeof CART_UPSELL_MODES)[number];
export interface CartUpsellSettings { enabled: boolean; title: string; maxItems: number; mode: CartUpsellMode }
export const DEFAULT_CART_UPSELL: CartUpsellSettings = { enabled: false, title: 'You may also like', maxItems: 3, mode: 'complementary' };

const SELECT_CARD = 'name slug images status isDelete storeId isBundle bundleComponents subCategoryId purchaseCount relatedProductIds complementaryProductIds type';

/** Bundles + pre-order settings + manual recommendations + cart upsell (Shopify Bundles / purchase options / Search & Discovery parity). */
@Injectable()
export class MerchandisingService {
  constructor(private readonly db: DatabaseService, private readonly activityLog: ActivityLogService) {}

  private get r() { return this.db.repositories; }
  private assertOwned(storeId: string, sellerId: string) { return verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId); }
  private log(storeId: string, sellerId: string, action: string, description: string, targetId: string) {
    this.activityLog.log({ storeId, category: 'products', action, description, actorId: sellerId, actorRole: 'seller', targetId, targetType: 'product' } as any).catch(() => undefined);
  }
  private async product(storeId: string, productId: string) {
    if (!isValidObjectId(productId)) throw new NotFoundException('Product not found');
    const p: any = await this.r.productModel.findOne({ _id: productId, storeId, isDelete: false }).lean();
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }

  // ── Bundles ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async loadBundleParts(storeId: string, components: { productId: string; variantId: string; quantity: number }[]) {
    const variants: any[] = await this.r.productVariantModel.find({ _id: { $in: components.map((c) => c.variantId) }, isDelete: false }).lean();
    const products: any[] = await this.r.productModel.find({ _id: { $in: [...new Set(components.map((c) => c.productId))] }, isDelete: false }).select('name storeId status type isBundle').lean();
    return { vById: new Map(variants.map((v) => [String(v._id), v])), pById: new Map(products.map((p) => [String(p._id), p])) };
  }

  async setBundle(storeId: string, sellerId: string, productId: string, rawComponents: unknown) {
    await this.assertOwned(storeId, sellerId);
    const product = await this.product(storeId, productId);
    if (product.type !== 'physical') throw new BadRequestException('Only physical products can be bundles');
    if (await this.r.productModel.exists({ storeId, isDelete: false, isBundle: true, _id: { $ne: productId }, 'bundleComponents.productId': productId })) {
      throw new BadRequestException('This product is already a component of another bundle — bundles cannot be nested');
    }
    const ownVariants = await this.r.productVariantModel.find({ productId, isDelete: false }).select('_id').lean();
    if (ownVariants.length !== 1) throw new BadRequestException('A bundle product must have exactly one variant');

    const components = validateBundleShape(rawComponents, productId);
    const { vById, pById } = await this.loadBundleParts(storeId, components);
    const snap = components.map((c, i) => {
      const v = vById.get(c.variantId);
      const p = pById.get(c.productId);
      if (!v || !p || String(v.productId) !== c.productId) throw new BadRequestException(`Component ${i + 1} was not found`);
      if (String(p.storeId) !== String(storeId)) throw new BadRequestException(`Component ${i + 1} belongs to another store`);
      if (p.status !== 'active') throw new BadRequestException(`"${p.name}" is not active — only active products can be bundle components`);
      if (p.type !== 'physical') throw new BadRequestException(`"${p.name}" is not a physical product`);
      if (p.isBundle) throw new BadRequestException(`"${p.name}" is itself a bundle — bundles cannot be nested`);
      const opts = Array.isArray(v.options) && v.options.length ? ` (${v.options.map((o: any) => o.value ?? o).join(' / ')})` : '';
      return { productId: c.productId, variantId: c.variantId, quantity: c.quantity, name: `${p.name}${opts}` };
    });

    await this.r.productModel.updateOne({ _id: productId, storeId }, { $set: { isBundle: true, bundleComponents: snap } });
    // The bundle's own variant carries no stock — availability is derived from the components.
    await this.r.productVariantModel.updateOne({ productId, isDelete: false }, { $set: { unlimitedStock: true } });
    this.log(storeId, sellerId, 'bundle_updated', `"${product.name}" set as a bundle of ${snap.length} component(s)`, productId);
    return this.getBundle(storeId, sellerId, productId);
  }

  async removeBundle(storeId: string, sellerId: string, productId: string) {
    await this.assertOwned(storeId, sellerId);
    const product = await this.product(storeId, productId);
    await this.r.productModel.updateOne({ _id: productId, storeId }, { $set: { isBundle: false, bundleComponents: [] } });
    await this.r.productVariantModel.updateOne({ productId, isDelete: false }, { $set: { unlimitedStock: false } });
    this.log(storeId, sellerId, 'bundle_removed', `"${product.name}" is no longer a bundle`, productId);
    return { success: true, message: 'Bundle removed' };
  }

  /** Components with live availability and the computed compare-at (sum of component prices x qty). */
  async getBundle(storeId: string, sellerId: string, productId: string) {
    await this.assertOwned(storeId, sellerId);
    return { success: true, data: await this.bundleView(storeId, productId) };
  }

  async bundleView(storeId: string, productId: string) {
    const product = await this.product(storeId, productId);
    const comps: any[] = product.bundleComponents ?? [];
    if (!product.isBundle || comps.length === 0) return { isBundle: false, components: [], available: null, compareAtPrice: null };
    const variants: any[] = await this.r.productVariantModel.find({ _id: { $in: comps.map((c) => c.variantId) }, isDelete: false }).lean();
    const vById = new Map(variants.map((v) => [String(v._id), v]));
    const prods: any[] = await this.r.productModel.find({ _id: { $in: comps.map((c) => c.productId) } }).select('name images').lean();
    const pById = new Map(prods.map((p) => [String(p._id), p]));
    const compareAt = comps.reduce((s, c) => s + (Number(vById.get(String(c.variantId))?.price) || 0) * c.quantity, 0);
    return {
      isBundle: true,
      components: comps.map((c) => ({ productId: c.productId, variantId: c.variantId, quantity: c.quantity, name: pById.get(String(c.productId))?.name ?? c.name, image: pById.get(String(c.productId))?.images?.[0] ?? null, available: vById.has(String(c.variantId)) })),
      available: bundleAvailability(comps, vById), // null = unlimited
      compareAtPrice: Math.round(compareAt * 100) / 100,
    };
  }

  // ── Pre-order ───────────────────────────────────────────────────────────────────────────────────────────────

  async setPreorder(storeId: string, sellerId: string, variantId: string, raw: unknown) {
    await this.assertOwned(storeId, sellerId);
    if (!isValidObjectId(variantId)) throw new NotFoundException('Variant not found');
    const variant: any = await this.r.productVariantModel.findOne({ _id: variantId, isDelete: false }).lean();
    const product: any = variant ? await this.r.productModel.findOne({ _id: variant.productId, storeId, isDelete: false }).select('name isBundle type').lean() : null;
    if (!variant || !product) throw new NotFoundException('Variant not found');
    if (product.type !== 'physical') throw new BadRequestException('Pre-order is only available for physical products');
    if (product.isBundle) throw new BadRequestException('Bundles cannot be pre-ordered — set pre-order on their components');
    const pre = normalizePreorderInput(raw, variant.preorder?.sold ?? 0);
    await this.r.productVariantModel.updateOne({ _id: variantId }, { $set: { preorder: pre } });
    this.log(storeId, sellerId, 'preorder_updated', `Pre-order ${pre?.enabled ? 'enabled' : 'disabled'} for "${product.name}"`, String(variant.productId));
    return { success: true, data: { variantId, preorder: pre } };
  }

  /** Inventory view: variants with pre-order set up, with units sold under it and currently reserved. */
  async listPreorders(storeId: string, sellerId: string) {
    await this.assertOwned(storeId, sellerId);
    const prods: any[] = await this.r.productModel.find({ storeId, isDelete: false }).select('name').lean();
    const nameById = new Map(prods.map((p) => [String(p._id), p.name]));
    const rows: any[] = await this.r.productVariantModel.find({ productId: { $in: [...nameById.keys()] }, isDelete: false, preorder: { $ne: null } }).select('productId sku options stock committedStock preorder').lean();
    return {
      success: true,
      data: rows.map((v) => ({ variantId: String(v._id), productId: v.productId, productName: nameById.get(String(v.productId)), sku: v.sku, preorder: v.preorder, onHand: v.stock ?? 0, reserved: v.committedStock ?? 0 })),
    };
  }

  /** Cron: a pre-order whose expected date has passed AND which is back in stock turns itself off (idempotent). */
  async expirePreorders(now = new Date()): Promise<{ checked: number; expired: number }> {
    const rows: any[] = await this.r.productVariantModel.find({ 'preorder.enabled': true, 'preorder.expectedDate': { $lt: now }, isDelete: false }).select('stock committedStock damagedStock inTransitStock expiredStock expiryBuckets preorder').limit(2000).lean();
    let expired = 0;
    for (const v of rows) {
      if (availableStock(v) <= 0) continue;
      const res = await this.r.productVariantModel.updateOne({ _id: v._id, 'preorder.enabled': true }, { $set: { 'preorder.enabled': false } });
      if (res.modifiedCount) expired++;
    }
    return { checked: rows.length, expired };
  }

  // ── Recommendations ─────────────────────────────────────────────────────────────────────────────────────────

  private cleanIdList(raw: unknown, label: string, selfId: string): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new BadRequestException(`${label} must be a list`);
    const ids = [...new Set(raw.map((x) => (typeof x === 'string' ? x : '')))];
    if (ids.length > MAX_RECOMMENDATIONS) throw new BadRequestException(`At most ${MAX_RECOMMENDATIONS} products per list`);
    if (ids.some((id) => !isValidObjectId(id))) throw new BadRequestException(`${label}: invalid product`);
    if (ids.includes(selfId)) throw new BadRequestException(`${label}: a product cannot recommend itself`);
    return ids;
  }

  async setRecommendations(storeId: string, sellerId: string, productId: string, body: { relatedProductIds?: unknown; complementaryProductIds?: unknown }) {
    await this.assertOwned(storeId, sellerId);
    await this.product(storeId, productId);
    const $set: Record<string, string[]> = {};
    if (body.relatedProductIds !== undefined) $set.relatedProductIds = this.cleanIdList(body.relatedProductIds, 'Related products', productId);
    if (body.complementaryProductIds !== undefined) $set.complementaryProductIds = this.cleanIdList(body.complementaryProductIds, 'Complementary products', productId);
    // Every id must be a live, ACTIVE product of THIS store — another store's product is rejected, never silently dropped.
    const all = [...new Set(Object.values($set).flat())];
    if (all.length) {
      const ok: any[] = await this.r.productModel.find({ _id: { $in: all }, storeId, isDelete: false, status: 'active' }).select('_id').lean();
      if (ok.length !== all.length) throw new BadRequestException('Every recommended product must be an active product of this store');
    }
    await this.r.productModel.updateOne({ _id: productId, storeId }, { $set });
    return this.getRecommendations(storeId, sellerId, productId);
  }

  async getRecommendations(storeId: string, sellerId: string, productId: string) {
    await this.assertOwned(storeId, sellerId);
    const p = await this.product(storeId, productId);
    const byIds = async (ids: string[]) => {
      const rows: any[] = ids.length ? await this.r.productModel.find({ _id: { $in: ids }, storeId, isDelete: false }).select('name images').lean() : [];
      const m = new Map(rows.map((x) => [String(x._id), x]));
      return ids.map((id) => m.get(id)).filter(Boolean).map((x: any) => ({ id: String(x._id), name: x.name, image: x.images?.[0] ?? null }));
    };
    const auto = await this.resolveRecommendations(storeId, productId, { limit: 6, ignoreManual: true });
    return { success: true, data: { related: await byIds(p.relatedProductIds ?? []), complementary: await byIds(p.complementaryProductIds ?? []), autoPreview: auto } };
  }

  /** Slim storefront cards for candidate products: only live, visible, purchasable ones, in the candidate order. */
  private async cards(storeId: string, ids: string[], exclude: Set<string>, limit: number, source: 'manual' | 'auto') {
    const want = ids.filter((id) => !exclude.has(id));
    if (!want.length) return [];
    const prods: any[] = await this.r.productModel.find({ _id: { $in: want }, storeId, isDelete: false, status: 'active' }).select(SELECT_CARD).lean();
    const pById = new Map(prods.map((x) => [String(x._id), x]));
    const variants: any[] = await this.r.productVariantModel.find({ productId: { $in: want }, isDelete: false }).lean();
    const vByProduct = new Map<string, any[]>();
    for (const v of variants) vByProduct.set(String(v.productId), [...(vByProduct.get(String(v.productId)) ?? []), v]);
    const bundleVariantIds = prods.filter((p) => p.isBundle).flatMap((p) => (p.bundleComponents ?? []).map((c: any) => c.variantId));
    const compVariants: any[] = bundleVariantIds.length ? await this.r.productVariantModel.find({ _id: { $in: bundleVariantIds } }).lean() : [];
    const compById = new Map(compVariants.map((v) => [String(v._id), v]));
    const out: any[] = [];
    for (const id of want) {
      const p = pById.get(id);
      if (!p) continue;
      const vs = vByProduct.get(id) ?? [];
      if (vs.length === 0) continue;
      const purchasable = p.isBundle
        ? (bundleAvailability(p.bundleComponents ?? [], compById) ?? 1) > 0
        : p.type !== 'physical' || vs.some((v) => v.unlimitedStock || v.allowBackorder || v.preorder?.enabled || availableStock(v) > 0);
      if (!purchasable) continue;
      const def = vs.find((v) => v.isDefault) ?? vs[0];
      out.push({ id, slug: p.slug ?? null, name: p.name, image: p.images?.[0] ?? null, price: def.price, compareAtPrice: def.compareAtPrice ?? null, source });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Public recommendations for a product: manual picks first (related, then complementary), then an automatic fallback —
   * same sub-category, then best sellers. Always store-scoped; excludes the product itself, anything in `excludeIds`
   * (cart), and unavailable/draft/deleted products. `limit` is capped.
   */
  async resolveRecommendations(storeId: string, productId: string, opts: { limit?: number; excludeIds?: string[]; ignoreManual?: boolean } = {}) {
    const limit = Math.min(MAX_RECOMMENDATIONS, Math.max(1, opts.limit ?? 6));
    const p = await this.product(storeId, productId);
    const exclude = new Set<string>([productId, ...(opts.excludeIds ?? []).filter((x) => isValidObjectId(x))]);
    const out: any[] = [];
    const take = (more: any[]) => { for (const c of more) { if (out.length < limit && !exclude.has(c.id)) { out.push(c); exclude.add(c.id); } } };
    if (!opts.ignoreManual) take(await this.cards(storeId, [...(p.relatedProductIds ?? []), ...(p.complementaryProductIds ?? [])], exclude, limit, 'manual'));
    if (out.length < limit && p.subCategoryId) {
      const same: any[] = await this.r.productModel.find({ storeId, isDelete: false, status: 'active', subCategoryId: p.subCategoryId, _id: { $nin: [...exclude] } }).sort({ purchaseCount: -1 }).limit(limit * 3).select('_id').lean();
      take(await this.cards(storeId, same.map((x) => String(x._id)), exclude, limit - out.length, 'auto'));
    }
    if (out.length < limit) take(await this.bestSellers(storeId, exclude, limit - out.length));
    return out;
  }

  private async bestSellers(storeId: string, exclude: Set<string>, limit: number) {
    const top: any[] = await this.r.productModel.find({ storeId, isDelete: false, status: 'active', _id: { $nin: [...exclude] } }).sort({ purchaseCount: -1, createdAt: -1 }).limit(limit * 4).select('_id').lean();
    return this.cards(storeId, top.map((x) => String(x._id)), exclude, limit, 'auto');
  }

  // ── Cart upsell ─────────────────────────────────────────────────────────────────────────────────────────────

  private cleanUpsell(raw: any, prev: CartUpsellSettings): CartUpsellSettings {
    const out = { ...prev };
    if (raw?.enabled !== undefined) out.enabled = raw.enabled === true;
    if (raw?.title !== undefined) { const t = typeof raw.title === 'string' ? raw.title.trim() : ''; if (!t || t.length > 80) throw new BadRequestException('Title is required (max 80 characters)'); out.title = t; }
    if (raw?.maxItems !== undefined) { if (!Number.isInteger(raw.maxItems) || raw.maxItems < 1 || raw.maxItems > 8) throw new BadRequestException('Max items must be a whole number from 1 to 8'); out.maxItems = raw.maxItems; }
    if (raw?.mode !== undefined) { if (!CART_UPSELL_MODES.includes(raw.mode)) throw new BadRequestException('Unknown upsell mode'); out.mode = raw.mode; }
    return out;
  }

  async getCartUpsell(storeId: string, sellerId: string) {
    const store: any = await this.assertOwned(storeId, sellerId);
    return { success: true, data: { ...DEFAULT_CART_UPSELL, ...(store.cartUpsell ?? {}) } };
  }

  async setCartUpsell(storeId: string, sellerId: string, body: any) {
    const store: any = await this.assertOwned(storeId, sellerId);
    const next = this.cleanUpsell(body, { ...DEFAULT_CART_UPSELL, ...(store.cartUpsell ?? {}) });
    await this.r.storeModel.updateOne({ _id: storeId }, { $set: { cartUpsell: next } });
    return { success: true, data: next };
  }

  /** Public: suggestions for a cart. Renders nothing (`items: []`) when the store has not enabled it. */
  async cartSuggestions(storeId: string, productIds: unknown) {
    const store: any = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }).select('cartUpsell status').lean();
    if (!store || store.status !== 'active') return { enabled: false, title: '', items: [] };
    const s: CartUpsellSettings = { ...DEFAULT_CART_UPSELL, ...(store.cartUpsell ?? {}) };
    if (!s.enabled) return { enabled: false, title: s.title, items: [] };
    const cartIds = (Array.isArray(productIds) ? productIds : []).filter((x): x is string => typeof x === 'string' && isValidObjectId(x)).slice(0, 50);
    const exclude = new Set<string>(cartIds);
    const items: any[] = [];
    const add = (more: any[]) => { for (const c of more) if (items.length < s.maxItems && !exclude.has(c.id)) { items.push(c); exclude.add(c.id); } };
    if (s.mode !== 'best_sellers' && cartIds.length) {
      const cartProducts: any[] = await this.r.productModel.find({ _id: { $in: cartIds }, storeId, isDelete: false }).select('relatedProductIds complementaryProductIds').lean();
      const key = s.mode === 'related' ? 'relatedProductIds' : 'complementaryProductIds';
      add(await this.cards(storeId, cartProducts.flatMap((p) => p[key] ?? []), exclude, s.maxItems, 'manual'));
    }
    if (items.length < s.maxItems) add(await this.bestSellers(storeId, exclude, s.maxItems - items.length));
    return { enabled: true, title: s.title, items };
  }

  /** Public product-page data: bundle contents/availability and the variant pre-order view. */
  async publicProductExtras(product: any, variants: any[]) {
    const extras: any = {};
    if (product.isBundle && (product.bundleComponents?.length ?? 0) > 0) {
      const view = await this.bundleView(String(product.storeId), String(product._id));
      extras.bundle = { components: view.components.map((c) => ({ name: c.name, image: c.image, quantity: c.quantity })), available: view.available, compareAtPrice: view.compareAtPrice };
    }
    const pre = variants.map((v) => ({ variantId: String(v._id), ...(preorderPublicView(v.preorder, availableStock(v)) ?? {}) })).filter((x: any) => x.label);
    if (pre.length) extras.preorder = pre;
    return extras;
  }
}
