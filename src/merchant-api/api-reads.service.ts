/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { storeCustomerUserIds } from '../common/store-customer-search.util';
import { ListQueryError, pageOf, parseListQuery } from './merchant-api.util';

const isOid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v) && Types.ObjectId.isValid(v);
const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * The read side of the public API (v1). Every query is pinned to the token's own store; every record goes through
 * a serializer, so only documented, snake_case fields leave the server (never internal ids of other stores, costs,
 * payment-provider ids or other sellers' parts of a marketplace order).
 */
@Injectable()
export class ApiReadsService {
  constructor(private readonly db: DatabaseService) {}
  private get r() { return this.db.repositories as any; }

  private list(q: any) {
    try { return parseListQuery(q); } catch (e) { if (e instanceof ListQueryError) throw new BadRequestException(e.message); throw e; }
  }
  /** `_id < cursor` (newest first) and `updatedAt >= updated_since`. */
  private window(p: { afterId: string | null; updatedSince: Date | null }) {
    const f: Record<string, unknown> = {};
    if (p.afterId) f._id = { $lt: new Types.ObjectId(p.afterId) };
    if (p.updatedSince) f.updatedAt = { $gte: p.updatedSince };
    return f;
  }

  // ── Store ────────────────────────────────────────────────────────────────

  async store(storeId: string) {
    const s: any = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }).select('name slug baseCurrency timezone customDomain customDomainStatus logo createdAt').lean();
    if (!s) throw new NotFoundException('Store not found');
    return {
      id: String(s._id), name: s.name ?? null, slug: s.slug ?? null,
      currency: s.baseCurrency ?? null, timezone: s.timezone ?? null,
      domain: s.customDomain && s.customDomainStatus === 'verified' ? s.customDomain : null,
      created_at: iso(s.createdAt),
    };
  }

  // ── Orders ───────────────────────────────────────────────────────────────

  static readonly ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded', 'partially_cancelled', 'partially_refunded', 'partially_shipped'];

  async orders(storeId: string, q: any) {
    const p = this.list(q);
    const f: Record<string, unknown> = { isDelete: false, 'sellerOrders.storeId': storeId, ...this.window(p) };
    if (q?.status !== undefined && q.status !== '') {
      if (!ApiReadsService.ORDER_STATUSES.includes(String(q.status))) throw new BadRequestException(`status must be one of: ${ApiReadsService.ORDER_STATUSES.join(', ')}`);
      f.sellerOrders = { $elemMatch: { storeId, status: String(q.status) } };
      delete f['sellerOrders.storeId'];
    }
    if (q?.paid === 'true' || q?.paid === 'false') f.isPaid = q.paid === 'true';
    const rows = await this.r.orderModel.find(f).sort({ _id: -1 }).limit(p.limit + 1).lean();
    return pageOf(rows, p.limit, (o) => this.toOrder(o, storeId));
  }

  async order(storeId: string, id: string) {
    if (!isOid(id)) throw new NotFoundException('Order not found');
    const o: any = await this.r.orderModel.findOne({ _id: id, isDelete: false, 'sellerOrders.storeId': storeId }).lean();
    if (!o) throw new NotFoundException('Order not found');
    return this.toOrder(o, storeId);
  }

  /** This store's part of the order only. Order-wide amounts (shipping, discounts, total) are shown only when the whole order is this store's. */
  toOrder(o: any, storeId: string) {
    const so = (o.sellerOrders ?? []).find((s: any) => String(s.storeId) === storeId) ?? {};
    const soleStore = (o.sellerOrders ?? []).length === 1;
    const a = o.shippingAddress;
    return {
      id: String(o._id),
      order_number: o.orderNumber ?? null,
      created_at: iso(o.createdAt),
      updated_at: iso(o.updatedAt),
      currency: o.currency ?? null,
      status: so.status ?? null,
      return_status: so.returnStatus ?? 'none',
      paid: !!o.isPaid,
      paid_at: iso(o.paidAt),
      payment_status: o.paymentStatus ?? null,
      payment_method: o.paymentMethodName ?? null,
      fulfillment_method: o.fulfillmentMethod ?? 'ship',
      customer_id: o.customerId ? String(o.customerId) : o.userId ? String(o.userId) : null,
      shipping_address: a ? {
        name: a.recipientName ?? null, phone: a.phoneNumber ?? null, address1: a.addressLine1 ?? null, address2: a.addressLine2 ?? null,
        city: a.city ?? null, province: a.state ?? null, zip: a.zipCode ?? null, country: a.country ?? null,
      } : null,
      line_items: (so.items ?? []).map((i: any) => ({
        id: String(i._id), product_id: i.productId ? String(i.productId) : null, variant_id: i.variantId ? String(i.variantId) : null,
        name: i.name ?? null, sku: i.sku ?? null, type: i.type ?? null, options: (i.options ?? []).map((x: any) => ({ name: x.name, value: x.value })),
        quantity: num(i.quantity), price: num(i.price), total: num(i.totalPrice),
        cancelled_at: iso(i.cancelledAt), refunded_amount: num(i.refundedAmount) ?? 0,
      })),
      subtotal: num(so.subtotal),
      tax: num(so.taxAmount),
      refunded_total: num(so.refundedTotal) ?? 0,
      shipping: soleStore ? num(o.shippingFee) : null,
      discount_code: soleStore ? o.couponCode ?? null : null,
      total: soleStore ? num(o.totalAmount) : null,
      shipments: (so.shipments ?? []).map((s: any) => ({
        id: String(s._id), items: (s.items ?? []).map((x: any) => ({ line_item_id: String(x.itemId), quantity: x.quantity })),
        carrier: s.tracking?.carrier ?? null, tracking_number: s.tracking?.trackingNumber ?? null, tracking_url: s.tracking?.trackingUrl ?? null,
        shipped_at: iso(s.shippedAt), delivered_at: iso(s.deliveredAt),
      })),
      shipped_at: iso(so.shippedAt),
      delivered_at: iso(so.deliveredAt),
      cancelled_at: iso(so.cancelledAt),
      cancel_reason: so.cancelReason ?? null,
    };
  }

  // ── Products ─────────────────────────────────────────────────────────────

  async products(storeId: string, q: any) {
    const p = this.list(q);
    const f: Record<string, unknown> = { storeId, isDelete: false, ...this.window(p) };
    if (q?.status !== undefined && q.status !== '') {
      if (!['active', 'inactive', 'draft', 'scheduled'].includes(String(q.status))) throw new BadRequestException('status must be active, inactive, draft or scheduled');
      f.status = String(q.status);
    }
    const rows = await this.r.productModel.find(f).sort({ _id: -1 }).limit(p.limit + 1).lean();
    const variants = await this.variantsByProduct(rows.slice(0, p.limit).map((x: any) => String(x._id)));
    const currency = await this.storeCurrency(storeId);
    return pageOf(rows, p.limit, (x) => this.toProduct(x, variants.get(String(x._id)) ?? [], currency));
  }

  async product(storeId: string, id: string) {
    if (!isOid(id)) throw new NotFoundException('Product not found');
    const x: any = await this.r.productModel.findOne({ _id: id, storeId, isDelete: false }).lean();
    if (!x) throw new NotFoundException('Product not found');
    const variants = await this.variantsByProduct([id]);
    return this.toProduct(x, variants.get(id) ?? [], await this.storeCurrency(storeId));
  }

  private async storeCurrency(storeId: string): Promise<string | null> {
    const s: any = await this.r.storeModel.findOne({ _id: storeId }).select('baseCurrency').lean();
    return s?.baseCurrency ?? null;
  }

  private async variantsByProduct(productIds: string[]) {
    const out = new Map<string, any[]>();
    if (!productIds.length) return out;
    const rows: any[] = await this.r.productVariantModel.find({ productId: { $in: productIds }, isDelete: { $ne: true } }).sort({ isDefault: -1, _id: 1 }).lean();
    for (const v of rows) { const k = String(v.productId); if (!out.has(k)) out.set(k, []); out.get(k)!.push(v); }
    return out;
  }

  static available(v: any): number | null {
    if (v.unlimitedStock) return null;
    return Math.max(0, (v.stock ?? 0) - (v.committedStock ?? 0) - (v.damagedStock ?? 0) - (v.inTransitStock ?? 0) - (v.expiredStock ?? 0));
  }

  toVariant(v: any, currency: string | null) {
    return {
      id: String(v._id), sku: v.sku || null, barcode: v.barcode ?? null,
      options: (v.options ?? []).map((x: any) => ({ name: x.name, value: x.value })),
      price: num(v.price), compare_at_price: num(v.compareAtPrice), currency: v.currency ?? currency,
      inventory: { tracked: !v.unlimitedStock, on_hand: v.unlimitedStock ? null : v.stock ?? 0, committed: v.committedStock ?? 0, available: ApiReadsService.available(v), allow_backorder: !!v.allowBackorder },
      taxable: v.taxable !== false, weight: v.shippingWeight ?? null, images: v.images ?? [],
      updated_at: iso(v.updatedAt),
    };
  }

  toProduct(x: any, variants: any[], currency: string | null) {
    return {
      id: String(x._id), name: x.name ?? null, slug: x.slug ?? null, status: x.status ?? null,
      type: x.productType ?? x.type ?? null, description: x.description ?? '', short_description: x.shortDescription ?? '',
      vendor: x.vendor || null, tags: x.tags ?? [], images: x.images ?? [], category_id: x.categoryId ? String(x.categoryId) : null,
      variants: variants.map((v) => this.toVariant(v, currency)),
      created_at: iso(x.createdAt), updated_at: iso(x.updatedAt),
    };
  }

  // ── Inventory ────────────────────────────────────────────────────────────

  /** Stock levels per variant, newest first; `updated_since` returns only variants whose stock row changed. */
  async inventory(storeId: string, q: any) {
    const p = this.list(q);
    const productIds: string[] = (await this.r.productModel.find({ storeId, isDelete: false }).select('_id').lean()).map((x: any) => String(x._id));
    if (!productIds.length) return { items: [], has_more: false, next_cursor: null };
    const f: Record<string, unknown> = { productId: { $in: productIds }, isDelete: { $ne: true }, ...this.window(p) };
    if (q?.product_id !== undefined) { if (!isOid(q.product_id) || !productIds.includes(q.product_id)) throw new NotFoundException('Product not found'); f.productId = q.product_id; }
    const rows = await this.r.productVariantModel.find(f).sort({ _id: -1 }).limit(p.limit + 1).select('productId sku stock committedStock damagedStock inTransitStock expiredStock unlimitedStock allowBackorder updatedAt').lean();
    return pageOf(rows, p.limit, (v) => ({
      variant_id: String(v._id), product_id: String(v.productId), sku: v.sku || null, tracked: !v.unlimitedStock,
      on_hand: v.unlimitedStock ? null : v.stock ?? 0, committed: v.committedStock ?? 0, available: ApiReadsService.available(v),
      allow_backorder: !!v.allowBackorder, updated_at: iso(v.updatedAt),
    }));
  }

  // ── Collections ──────────────────────────────────────────────────────────

  async collections(storeId: string, q: any) {
    const p = this.list(q);
    const rows = await this.r.collectionModel.find({ storeId, isDelete: { $ne: true }, ...this.window(p) }).sort({ _id: -1 }).limit(p.limit + 1).select('name slug description image type productIds status createdAt updatedAt').lean();
    return pageOf(rows, p.limit, (c) => ({
      id: String(c._id), name: c.name ?? null, slug: c.slug ?? null, description: c.description ?? null, image: c.image ?? null,
      type: c.type ?? 'manual', status: c.status ?? null,
      // Automatic collections are rule-based: their members are worked out on the storefront, not stored.
      product_ids: c.type === 'automatic' ? null : (c.productIds ?? []).map(String),
      created_at: iso(c.createdAt), updated_at: iso(c.updatedAt),
    }));
  }

  // ── Customers ────────────────────────────────────────────────────────────

  /**
   * The store's customers: buyers of its orders, its POS customers and people the seller added — the same definition
   * as the dashboard's customer list, so no other store's buyers are reachable. Erased customers come back with no
   * personal data. `email_marketing` is this store's own consent record.
   */
  async customers(storeId: string, q: any) {
    const p = this.list(q);
    const ids = await storeCustomerUserIds(this.r, storeId);
    if (!ids.length) return { items: [], has_more: false, next_cursor: null };
    const rows = await this.r.userModel.find({ _id: { $in: ids }, isDelete: { $ne: true }, ...this.window(p) }).sort({ _id: -1 }).limit(p.limit + 1).select('name email contactEmail phone isGuest createdAt updatedAt').lean();
    const meta = await this.metaFor(storeId, rows.slice(0, p.limit).map((u: any) => String(u._id)));
    return pageOf(rows, p.limit, (u) => this.toCustomer(u, meta.get(String(u._id))));
  }

  async customer(storeId: string, id: string) {
    if (!isOid(id)) throw new NotFoundException('Customer not found');
    const ids = await storeCustomerUserIds(this.r, storeId);
    if (!ids.includes(id)) throw new NotFoundException('Customer not found');
    const u: any = await this.r.userModel.findOne({ _id: id, isDelete: { $ne: true } }).select('name email contactEmail phone isGuest createdAt updatedAt').lean();
    if (!u) throw new NotFoundException('Customer not found');
    const meta = await this.metaFor(storeId, [id]);
    return this.toCustomer(u, meta.get(id));
  }

  private async metaFor(storeId: string, userIds: string[]) {
    const out = new Map<string, any>();
    if (!userIds.length) return out;
    const rows: any[] = await this.r.storeCustomerMetaModel.find({ storeId, userId: { $in: userIds } }).select('userId tags marketingOptIn smsMarketingOptIn whatsappMarketingOptIn isErased').lean();
    for (const m of rows) out.set(String(m.userId), m);
    return out;
  }

  toCustomer(u: any, m: any) {
    const erased = !!m?.isErased;
    return {
      id: String(u._id),
      name: erased ? null : u.name ?? null,
      // A guest's `email` is synthetic; their real address is `contactEmail`.
      email: erased ? null : (u.isGuest ? u.contactEmail : u.email) ?? null,
      phone: erased ? null : u.phone || null,
      guest: !!u.isGuest,
      tags: erased ? [] : m?.tags ?? [],
      email_marketing: !erased && !!m?.marketingOptIn,
      sms_marketing: !erased && !!m?.smsMarketingOptIn,
      whatsapp_marketing: !erased && !!m?.whatsappMarketingOptIn,
      erased,
      created_at: iso(u.createdAt),
      updated_at: iso(u.updatedAt),
    };
  }
}
