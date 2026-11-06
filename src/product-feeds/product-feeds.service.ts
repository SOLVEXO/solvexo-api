/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes, timingSafeEqual } from 'crypto';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { ProductFeedConfig, ProductFeedConfigDocument } from './feed.schema';
import { FeedIssue, FeedItem, mapVariant, renderGoogleXml, renderMetaCsv } from './feed-mapping.util';

const MAX_PRODUCTS = 5000;
const eq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const API = () => (process.env.API_PUBLIC_URL ?? '').replace(/\/$/, '');

@Injectable()
export class ProductFeedsService {
  constructor(
    @InjectModel(ProductFeedConfig.name) private readonly cfg: Model<ProductFeedConfigDocument>,
    private readonly db: DatabaseService,
    @Optional() private readonly fx?: ExchangeRateService,
  ) {}

  private async config(storeId: string) {
    const c = await this.cfg.findOneAndUpdate({ storeId }, { $setOnInsert: { storeId, token: randomBytes(24).toString('hex'), enabled: false, currencies: [] } }, { upsert: true, new: true }).lean();
    return c as any;
  }
  urls(storeId: string, token: string) {
    const b = `${API()}/api/public/feeds/${storeId}/${token}`;
    return { googleXml: `${b}/google.xml`, metaCsv: `${b}/meta.csv` };
  }
  async getSettings(storeId: string) { const c = await this.config(storeId); return { enabled: c.enabled, currencies: c.currencies, lastFetchedAt: c.lastFetchedAt, fetchCount: c.fetchCount, urls: this.urls(storeId, c.token) }; }
  async update(storeId: string, body: any) {
    const set: any = {};
    if (typeof body?.enabled === 'boolean') set.enabled = body.enabled;
    if (Array.isArray(body?.currencies)) set.currencies = [...new Set(body.currencies.map((c: any) => String(c).toUpperCase()).filter((c: string) => /^[A-Z]{3}$/.test(c)))].slice(0, 10);
    await this.config(storeId); await this.cfg.updateOne({ storeId }, { $set: set });
    return this.getSettings(storeId);
  }
  async rotate(storeId: string) { await this.config(storeId); await this.cfg.updateOne({ storeId }, { $set: { token: randomBytes(24).toString('hex') } }); return this.getSettings(storeId); }

  /** Items + products with missing required fields. A currency other than the store's is converted with the platform rate. */
  async build(storeId: string, currency?: string): Promise<{ items: FeedItem[]; issues: FeedIssue[]; store: any; currency: string; truncated: boolean }> {
    const repos = this.db.repositories as any;
    const store: any = await repos.storeModel.findOne({ _id: storeId, isDelete: false }).select('name slug customDomain customDomainStatus primaryDomain baseCurrency').lean();
    if (!store) throw new NotFoundException('Store not found');
    const base = String(store.baseCurrency ?? 'USD');
    const cur = (currency ?? base).toUpperCase();
    let rate: (n: number) => number = (n) => n;
    if (cur !== base) {
      if (!this.fx) throw new BadRequestException('Currency conversion is not available');
      const unit = await this.fx.convert(1000, base, cur).catch(() => null);
      if (!unit) throw new BadRequestException(`No exchange rate for ${cur}`);
      rate = (n) => (n * unit) / 1000;
    }
    const host = store.primaryDomain || (store.customDomain && store.customDomainStatus === 'verified' ? store.customDomain : null);
    const baseUrl = host ? `https://${host}` : `https://${store.slug}.solvexo.store`;
    const products: any[] = await repos.productModel.find({ storeId, isDelete: false, status: 'active', productType: 'physical' }).select('name slug description shortDescription images vendor type isBundle bundleComponents').sort({ _id: 1 }).limit(MAX_PRODUCTS + 1).lean();
    const truncated = products.length > MAX_PRODUCTS; if (truncated) products.length = MAX_PRODUCTS;
    const ids = products.map((p) => String(p._id));
    const variants: any[] = await repos.productVariantModel.find({ productId: { $in: ids }, isDelete: false, status: 'active' }).select('productId sku barcode price compareAtPrice images options stock committedStock damagedStock inTransitStock expiredStock unlimitedStock allowBackorder preorder').lean();
    const byProduct = new Map<string, any[]>(); for (const v of variants) { const a = byProduct.get(v.productId) ?? []; a.push(v); byProduct.set(v.productId, a); }
    const compIds = [...new Set(products.filter((p) => p.isBundle).flatMap((p) => (p.bundleComponents ?? []).map((c: any) => String(c.variantId))))];
    const comps: any[] = compIds.length ? await repos.productVariantModel.find({ _id: { $in: compIds } }).select('stock committedStock damagedStock inTransitStock expiredStock unlimitedStock').lean() : [];
    const compAvail = new Map(comps.map((c) => [String(c._id), c.unlimitedStock ? Infinity : Math.max(0, (c.stock ?? 0) - (c.committedStock ?? 0) - (c.damagedStock ?? 0) - (c.inTransitStock ?? 0) - (c.expiredStock ?? 0))]));
    const items: FeedItem[] = []; const issues: FeedIssue[] = [];
    for (const p of products) {
      let bundleAvail: number | null = null;
      if (p.isBundle && (p.bundleComponents ?? []).length) bundleAvail = Math.min(...p.bundleComponents.map((c: any) => Math.floor((compAvail.get(String(c.variantId)) ?? 0) / Math.max(1, c.quantity ?? 1))));
      for (const v of byProduct.get(String(p._id)) ?? []) {
        const r = mapVariant(p, v, { baseUrl, currency: cur, price: rate, componentAvail: bundleAvail });
        if (r.item) items.push(r.item); else if (r.issue) issues.push(r.issue);
      }
    }
    return { items, issues, store: { name: store.name, url: baseUrl }, currency: cur, truncated };
  }

  /** Public fetch: the token must match and the feed be switched on. Same error either way, so tokens cannot be probed. */
  async publicFeed(storeId: string, token: string, kind: 'google' | 'meta', currency?: string) {
    const c: any = await this.cfg.findOne({ storeId }).lean();
    if (!c || !c.enabled || !eq(String(token), c.token)) throw new NotFoundException('Feed not found');
    if (currency) {
      const base: any = await (this.db.repositories as any).storeModel.findById(storeId).select('baseCurrency').lean();
      const cur = currency.toUpperCase();
      if (cur !== String(base?.baseCurrency ?? '') && !(c.currencies ?? []).includes(cur)) throw new ForbiddenException('That currency is not offered in this feed');
    }
    const f = await this.build(storeId, currency);
    await this.cfg.updateOne({ storeId }, { $set: { lastFetchedAt: new Date() }, $inc: { fetchCount: 1 } });
    return kind === 'google' ? { type: 'application/xml; charset=utf-8', body: renderGoogleXml(f.store, f.items) } : { type: 'text/csv; charset=utf-8', body: renderMetaCsv(f.items) };
  }

  async health(storeId: string) {
    const f = await this.build(storeId);
    return { currency: f.currency, ready: f.items.length, withProblems: f.issues.length, truncated: f.truncated, issues: f.issues.slice(0, 200) };
  }
}
