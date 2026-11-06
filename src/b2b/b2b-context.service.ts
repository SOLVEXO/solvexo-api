/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  B2BApplication, B2BApplicationDocument, B2BBuyer, B2BBuyerDocument, B2BCatalog, B2BCatalogDocument, B2BCatalogItem, B2BCatalogItemDocument,
  B2BCompany, B2BCompanyDocument, B2BLocation, B2BLocationDocument,
} from './b2b.schema';
import { CatalogEntry, checkQuantity, effectiveCompanySettings, effectiveQuantityRule, isPaymentMethodAllowed, resolveCatalogPrice } from './b2b-pricing.util';

export interface BuyerContext {
  storeId: string;
  userId: string;
  companyId: string;
  companyName: string;
  locationId: string;
  locationName: string;
  role: string;
  taxExempt: boolean;
  depositPercent: number;
  settings: ReturnType<typeof effectiveCompanySettings>;
  catalog: { id: string; includeAllProducts: boolean; defaultAdjustmentPercent: number | null } | null;
}

/** What a checkout remembers about the B2B buyer. Payment enforcement and (later) payment terms read this, never the client. */
export interface CheckoutB2BSnapshot {
  companyId: string; companyName: string; locationId: string; buyerRole: string; poNumber: string | null;
  allowedPaymentMethods: string[]; paymentTerms: { type: string; netDays?: number | null } | null; taxExempt: boolean; creditLimit: number | null; depositPercent: number;
}

const isOid = (v: any) => typeof v === 'string' && Types.ObjectId.isValid(v);
const clean = (v: any, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Resolves who a storefront buyer is in B2B terms and recomputes price / availability / quantity rules on the SERVER.
 * Used by checkout creation and by the storefront B2B endpoints. A visitor or a regular customer gets `null` (retail rules).
 */
@Injectable()
export class B2BContextService {
  constructor(
    @InjectModel(B2BCompany.name) private readonly companies: Model<B2BCompanyDocument>,
    @InjectModel(B2BLocation.name) private readonly locations: Model<B2BLocationDocument>,
    @InjectModel(B2BBuyer.name) private readonly buyers: Model<B2BBuyerDocument>,
    @InjectModel(B2BApplication.name) private readonly applications: Model<B2BApplicationDocument>,
    @InjectModel(B2BCatalog.name) private readonly catalogs: Model<B2BCatalogDocument>,
    @InjectModel(B2BCatalogItem.name) private readonly items: Model<B2BCatalogItemDocument>,
  ) {}

  async getContext(storeId: string, userId: string): Promise<BuyerContext | null> {
    if (!storeId || !userId) return null;
    const buyer: any = await this.buyers.findOne({ storeId, userId, status: 'active' }).lean();
    if (!buyer) return null;
    const [company, location]: any[] = await Promise.all([
      this.companies.findOne({ _id: buyer.companyId, storeId, status: 'approved', isDelete: false }).lean(),
      this.locations.findOne({ _id: buyer.locationId, storeId, companyId: buyer.companyId, isDelete: false }).lean(),
    ]);
    if (!company || !location) return null;
    return this.build(storeId, userId, buyer.role, company, location);
  }

  /**
   * Seller side (draft orders for a company): the context of an approved company, for a customer who is one of its active buyers.
   * Without a customer the company's first location and its first active location admin (else any active buyer) are used.
   */
  async getCompanyContext(storeId: string, companyId: string, customerUserId?: string | null): Promise<{ ctx: BuyerContext; buyerUserId: string; buyerEmail: string } | null> {
    if (!isOid(companyId)) return null;
    const company: any = await this.companies.findOne({ _id: companyId, storeId, status: 'approved', isDelete: false }).lean();
    if (!company) return null;
    let buyer: any = null;
    if (customerUserId) buyer = await this.buyers.findOne({ storeId, companyId, userId: customerUserId, status: 'active' }).lean();
    else buyer = (await this.buyers.findOne({ storeId, companyId, role: 'location_admin', status: 'active' }).sort({ createdAt: 1 }).lean()) ?? (await this.buyers.findOne({ storeId, companyId, status: 'active' }).sort({ createdAt: 1 }).lean());
    if (!buyer) return null;
    const location: any = await this.locations.findOne({ _id: buyer.locationId, storeId, companyId, isDelete: false }).lean();
    if (!location) return null;
    return { ctx: await this.build(storeId, buyer.userId, buyer.role, company, location), buyerUserId: String(buyer.userId), buyerEmail: buyer.email };
  }

  private async build(storeId: string, userId: string, role: string, company: any, location: any): Promise<BuyerContext> {
    const settings = effectiveCompanySettings(company, location);
    let catalog: BuyerContext['catalog'] = null;
    if (settings.catalogId && isOid(settings.catalogId)) {
      const c: any = await this.catalogs.findOne({ _id: settings.catalogId, storeId, status: 'active', isDelete: false }).lean();
      if (c) catalog = { id: String(c._id), includeAllProducts: !!c.includeAllProducts, defaultAdjustmentPercent: c.defaultAdjustmentPercent ?? null };
    }
    return {
      storeId, userId, companyId: String(company._id), companyName: company.name, locationId: String(location._id), locationName: location.name,
      role, taxExempt: !!company.taxExempt, depositPercent: company.depositPercent ?? 0, settings, catalog,
    };
  }

  async loadEntries(ctx: BuyerContext, variantIds: string[]): Promise<Map<string, CatalogEntry>> {
    const map = new Map<string, CatalogEntry>();
    if (!ctx.catalog || variantIds.length === 0) return map;
    const rows: any[] = await this.items.find({ storeId: ctx.storeId, catalogId: ctx.catalog.id, variantId: { $in: variantIds.filter(isOid) } }).lean();
    for (const r of rows) map.set(String(r.variantId), r);
    return map;
  }

  /**
   * Unit price for one line plus the availability and quantity checks. Throws a buyer-readable BadRequest when the company may not buy
   * this variant or the quantity breaks a rule. `variant.price` is the retail price in the store currency.
   */
  resolveLine(ctx: BuyerContext, entries: Map<string, CatalogEntry>, line: { productName: string; product?: any; variantId: string; basePrice: number; quantity: number }) {
    const entry = entries.get(String(line.variantId)) ?? null;
    if (ctx.catalog) {
      const available = entry ? entry.available !== false : ctx.catalog.includeAllProducts;
      if (!available) throw new BadRequestException(`"${line.productName}" is not available to your company. Please remove it from your cart.`);
    }
    const rule = effectiveQuantityRule(entry, line.product);
    const check = checkQuantity(line.quantity, rule);
    if (!check.ok) throw new BadRequestException({ message: `"${line.productName}": ${check.reason}`, code: 'B2B_QUANTITY_RULE', suggested: check.suggested });
    const unitPrice = resolveCatalogPrice(line.basePrice, entry, line.quantity, ctx.catalog?.defaultAdjustmentPercent);
    return { unitPrice, rule, entry };
  }

  snapshot(ctx: BuyerContext, poNumber?: any): CheckoutB2BSnapshot {
    return {
      companyId: ctx.companyId, companyName: ctx.companyName, locationId: ctx.locationId, buyerRole: ctx.role, poNumber: clean(poNumber, 60),
      allowedPaymentMethods: ctx.settings.allowedPaymentMethods ?? [], paymentTerms: (ctx.settings.paymentTerms as any) ?? null, taxExempt: ctx.taxExempt,
      creditLimit: ctx.settings.creditLimit ?? null, depositPercent: ctx.depositPercent,
    };
  }

  /** Store credit is the seller's own credit to the customer, so it is never blocked by the company's method list. */
  assertPaymentMethodAllowed(snapshot: { allowedPaymentMethods?: string[] } | null | undefined, method: string) {
    if (!snapshot || method === 'store_credit') return;
    if (!isPaymentMethodAllowed(snapshot.allowedPaymentMethods, method)) {
      throw new BadRequestException('This payment method is not available for your company. Please choose another one.');
    }
  }

  // ── storefront-facing ─────────────────────────────────────────────────────
  async apply(storeId: string, user: { userId: string; email: string }, body: any) {
    const companyName = clean(body?.companyName, 120);
    if (!companyName) throw new BadRequestException('Company name is required');
    if (await this.buyers.exists({ storeId, userId: user.userId })) throw new BadRequestException('Your account already belongs to a wholesale company.');
    try {
      const app = await this.applications.create({
        storeId, userId: user.userId, email: String(user.email).toLowerCase(), companyName, taxId: clean(body?.taxId, 60), phone: clean(body?.phone, 40), message: clean(body?.message, 1000),
      });
      return { id: String(app._id), status: 'pending' };
    } catch (e: any) {
      if (e?.code === 11000) throw new ConflictException('You already have a wholesale application waiting for review.');
      throw e;
    }
  }

  /** Public-safe view of the buyer's wholesale standing (never exposes other customers or internal notes). */
  async me(storeId: string, userId: string) {
    const ctx = await this.getContext(storeId, userId);
    if (ctx) {
      return {
        status: 'approved' as const, companyName: ctx.companyName, locationName: ctx.locationName, role: ctx.role, taxExempt: ctx.taxExempt,
        paymentTerms: ctx.settings.paymentTerms, allowedPaymentMethods: ctx.settings.allowedPaymentMethods, hasCatalog: !!ctx.catalog,
      };
    }
    const app: any = await this.applications.findOne({ storeId, userId }).sort({ createdAt: -1 }).select('status companyName decisionNote').lean();
    if (app) return { status: app.status as 'pending' | 'rejected' | 'approved', companyName: app.companyName, decisionNote: app.status === 'rejected' ? app.decisionNote ?? null : null };
    return { status: 'none' as const };
  }
}
