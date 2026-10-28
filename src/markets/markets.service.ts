import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { Market } from './schemas/market.schema';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { DatabaseService } from '@/database/databaseservice';
import { AdminConfigService } from '@/admin-config/admin-config.service';
import { EntitlementsService, trimToMarketsLimit } from '@/platform-plans/entitlements.service';
import { manualRateOf, pickMarketForCountry, normalizeCountryCode } from './market-price.util';

/** URL prefixes the storefront already owns; a market subfolder may not shadow them. */
const RESERVED_SUBFOLDERS = new Set([
  'api', 'admin', 'store', 'products', 'product', 'collections', 'collection', 'cart', 'checkout', 'account',
  'login', 'register', 'pages', 'page', 'blogs', 'blog', 'search', 'orders', 'order-status', 'wishlist',
]);
const SUBFOLDER_RE = /^[a-z]{2}(-[a-z]{2})?$/;
const HOST_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** What the checkout needs to know about the buyer's market. */
export interface CheckoutMarketResolution {
  market: any | null;
  /** The store has markets, the buyer's country is known, and no market sells to it (Shopify: browse only, no purchase). */
  blocked: boolean;
}

@Injectable()
export class MarketsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminConfigService: AdminConfigService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  private get marketModel() {
    return this.databaseService.repositories.marketModel;
  }

  // ── Validation helpers ───────────────────────────────────────────────────

  private async loadStore(storeId: string) {
    const store: any = await this.databaseService.repositories.storeModel
      .findOne({ _id: storeId, isDelete: { $ne: true } })
      .select('baseCurrency enabledCurrencies customDomains')
      .lean();
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  private async assertPlatformCurrency(currency: string) {
    const codes = (await this.adminConfigService.getEnabledCurrencies()).map((c) => c.code);
    if (!codes.includes(currency)) throw new BadRequestException(`Currency ${currency} is not enabled on this platform`);
  }

  /**
   * A market's currency must be one the store's checkout accepts. When the store keeps an explicit list, the market
   * currency is added to it (within the plan's markets/currencies limit) so the market actually works at checkout.
   */
  private async ensureStoreAcceptsCurrency(storeId: string, store: any, currency: string) {
    const list: string[] | null = Array.isArray(store.enabledCurrencies) && store.enabledCurrencies.length
      ? store.enabledCurrencies
      : null;
    if (!list || list.includes(currency)) return;
    const { maxMarkets } = await this.entitlementsService.getLimits(storeId);
    if (maxMarkets !== -1 && list.length + 1 > maxMarkets) {
      throw new BadRequestException(
        `Your plan allows up to ${maxMarkets} checkout ${maxMarkets === 1 ? 'currency' : 'currencies'}. Remove one in Settings > Store details or upgrade your plan to sell in ${currency}.`,
      );
    }
    await this.databaseService.repositories.storeModel.updateOne(
      { _id: storeId },
      { $addToSet: { enabledCurrencies: currency } },
    );
  }

  private normalizeList(values: string[] | undefined, upper: boolean): string[] {
    const out = (values ?? []).map((v) => String(v).trim()).filter(Boolean).map((v) => (upper ? v.toUpperCase() : v.toLowerCase()));
    return Array.from(new Set(out));
  }

  private async assertProductsInStore(storeId: string, productIds: string[]) {
    if (!productIds.length) return;
    const found = await this.databaseService.repositories.productModel
      .countDocuments({ _id: { $in: productIds }, storeId, isDelete: false });
    if (found !== productIds.length) throw new BadRequestException('Some selected products are not in this store');
  }

  /** Builds the exact document fields from a (create or update) body. Never spreads the body into the database. */
  private async buildFields(
    storeId: string,
    store: any,
    dto: Partial<CreateMarketDto>,
    existing: any | null,
  ): Promise<Record<string, any>> {
    const fields: Record<string, any> = {};

    if (dto.name !== undefined) fields.name = String(dto.name).trim();
    if (dto.countries !== undefined) fields.countries = this.normalizeList(dto.countries, true);
    if (dto.languages !== undefined) fields.languages = this.normalizeList(dto.languages, false);
    if (dto.isActive !== undefined) fields.isActive = !!dto.isActive;
    if (dto.isPrimary !== undefined) fields.isPrimary = !!dto.isPrimary;

    if (dto.currency !== undefined) {
      const currency = String(dto.currency).toUpperCase();
      await this.assertPlatformCurrency(currency);
      fields.currency = currency;
    }

    // Where the market lives (Shopify: a subfolder like /en-ca, or one of the store's own connected domains).
    const domainType = dto.domainType ?? existing?.domainType ?? 'primary';
    if (dto.domainType !== undefined || dto.domain !== undefined || dto.subfolder !== undefined) {
      fields.domainType = domainType;
      fields.domain = null;
      fields.subfolder = null;
      if (domainType === 'subfolder') {
        const sub = String(dto.subfolder ?? existing?.subfolder ?? '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
        if (!SUBFOLDER_RE.test(sub)) throw new BadRequestException('Subfolder must look like en-ca or fr (language, optionally a country)');
        if (RESERVED_SUBFOLDERS.has(sub)) throw new BadRequestException(`/${sub} is already used by the store`);
        const clash = await this.marketModel.findOne({
          storeId, subfolder: sub, isDelete: false, ...(existing ? { _id: { $ne: existing._id } } : {}),
        }).select('_id').lean();
        if (clash) throw new BadRequestException(`Another market already uses /${sub}`);
        fields.subfolder = sub;
      } else if (domainType === 'subdomain') {
        const host = String(dto.domain ?? existing?.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!HOST_RE.test(host)) throw new BadRequestException('Enter a domain like eu.mystore.com');
        const owned = (store.customDomains ?? []).some((d: any) => d?.domain === host && d?.status === 'verified');
        if (!owned) throw new BadRequestException(`Connect and verify ${host} in Settings > Domains first, then pick it here`);
        const clash = await this.marketModel.findOne({
          storeId, domain: host, isDelete: false, ...(existing ? { _id: { $ne: existing._id } } : {}),
        }).select('_id').lean();
        if (clash) throw new BadRequestException(`Another market already uses ${host}`);
        fields.domain = host;
      }
    }

    if (dto.pricingRule !== undefined) {
      const r: any = dto.pricingRule ?? {};
      const type = ['auto', 'manual', 'percentage', 'fixed'].includes(r.type) ? r.type : 'auto';
      const rule = {
        type,
        manualRate: type === 'manual' && Number(r.manualRate) > 0 ? Number(r.manualRate) : null,
        percentageAdjustment: Number.isFinite(Number(r.percentageAdjustment)) && Number(r.percentageAdjustment) !== 0
          ? Number(r.percentageAdjustment) : null,
        useRounding: !!r.useRounding,
        roundingRule: ['0.95', '0.99', '1.00', 'nearest'].includes(r.roundingRule) ? r.roundingRule : 'nearest',
        conversionFee: Number(r.conversionFee) > 0 ? Number(r.conversionFee) : null,
      };
      if (type === 'manual' && !manualRateOf(rule)) throw new BadRequestException('Enter your exchange rate for a manual rate');
      fields.pricingRule = rule;
    }

    if (dto.shippingSettings !== undefined) {
      fields.shippingSettings = { currencyMode: dto.shippingSettings?.currencyMode === 'local' ? 'local' : 'store' };
    }

    if (dto.productAvailability !== undefined) {
      fields.productAvailability = dto.productAvailability;
    }
    if (dto.productIds !== undefined) {
      const ids = Array.from(new Set((dto.productIds ?? []).map(String))).filter((id) => isValidObjectId(id));
      await this.assertProductsInStore(storeId, ids);
      fields.productIds = ids;
    }
    return fields;
  }

  /** Countries may belong to one market only (Shopify), so a buyer always lands in exactly one. */
  private async assertCountriesFree(storeId: string, countries: string[], excludeId?: any) {
    if (!countries.length) return;
    const other: any = await this.marketModel.findOne(<any>{
      storeId, isDelete: false, countries: { $in: countries }, ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    }).select('name countries').lean();
    if (other) {
      const taken = countries.filter((c) => (other.countries ?? []).includes(c));
      throw new BadRequestException(`${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already in the market "${other.name}"`);
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async create(storeId: string, dto: CreateMarketDto): Promise<Market> {
    const store = await this.loadStore(storeId);
    const fields = await this.buildFields(storeId, store, dto, null);
    if (!fields.name) throw new BadRequestException('Enter a market name');
    if (!fields.currency) throw new BadRequestException('Pick a currency');
    await this.assertCountriesFree(storeId, fields.countries ?? []);

    // The first market a store creates is its primary market (Shopify always has exactly one).
    const hasPrimary = await this.marketModel.exists({ storeId, isPrimary: true, isDelete: false });
    if (!hasPrimary) fields.isPrimary = true;
    if (fields.isPrimary || fields.isActive === undefined) fields.isActive = true;
    if (!fields.isPrimary && !(fields.countries ?? []).length) {
      throw new BadRequestException('Add at least one country. Only the primary market can cover every other country.');
    }

    await this.ensureStoreAcceptsCurrency(storeId, store, fields.currency);
    if (fields.isPrimary) {
      await this.marketModel.updateMany({ storeId, isPrimary: true, isDelete: false }, { $set: { isPrimary: false } });
    }
    return this.marketModel.create({ ...fields, storeId, isDelete: false });
  }

  async findAll(storeId: string): Promise<Market[]> {
    return this.marketModel.find({ storeId, isDelete: false }).sort({ isPrimary: -1, name: 1 }).lean();
  }

  async findOne(storeId: string, marketId: string): Promise<Market> {
    if (!isValidObjectId(marketId)) throw new NotFoundException('Market not found');
    const market = await this.marketModel.findOne({ _id: marketId, storeId, isDelete: false });
    if (!market) throw new NotFoundException('Market not found');
    return market;
  }

  async update(storeId: string, marketId: string, dto: UpdateMarketDto): Promise<Market> {
    if (!isValidObjectId(marketId)) throw new NotFoundException('Market not found');
    const existing: any = await this.marketModel.findOne({ _id: marketId, storeId, isDelete: false }).lean();
    if (!existing) throw new NotFoundException('Market not found');
    const store = await this.loadStore(storeId);
    const fields = await this.buildFields(storeId, store, dto, existing);

    if (fields.countries) await this.assertCountriesFree(storeId, fields.countries, existing._id);
    const willBePrimary = fields.isPrimary ?? existing.isPrimary;
    if (existing.isPrimary && fields.isPrimary === false) {
      throw new BadRequestException('Make another market primary first');
    }
    if (willBePrimary && fields.isActive === false) {
      throw new BadRequestException('The primary market cannot be turned off');
    }
    const countries = fields.countries ?? existing.countries ?? [];
    if (!willBePrimary && !countries.length) {
      throw new BadRequestException('Add at least one country. Only the primary market can cover every other country.');
    }
    if (fields.currency && fields.currency !== existing.currency) {
      await this.ensureStoreAcceptsCurrency(storeId, store, fields.currency);
      // Fixed prices are in the old currency, so they no longer apply.
      await this.databaseService.repositories.marketPriceModel.updateMany(
        { marketId: String(existing._id), isDelete: false },
        { $set: { isDelete: true } },
      );
    }
    if (willBePrimary && !existing.isPrimary) {
      await this.marketModel.updateMany(
        { storeId, isPrimary: true, isDelete: false, _id: { $ne: existing._id } },
        { $set: { isPrimary: false } },
      );
      fields.isActive = true;
    }

    return (await this.marketModel.findOneAndUpdate(
      { _id: marketId, storeId, isDelete: false },
      { $set: fields },
      { new: true },
    )) as Market;
  }

  async remove(storeId: string, marketId: string): Promise<void> {
    const market: any = await this.findOne(storeId, marketId);
    if (market.isPrimary) {
      const others = await this.marketModel.countDocuments({ storeId, isDelete: false, _id: { $ne: market._id } });
      if (others > 0) throw new BadRequestException('Make another market primary before deleting this one');
    }
    await this.marketModel.updateOne({ _id: market._id, storeId }, { $set: { isDelete: true, isPrimary: false } });
    await this.databaseService.repositories.marketPriceModel.updateMany(
      { marketId: String(market._id), isDelete: false },
      { $set: { isDelete: true } },
    );
  }

  async getPrimaryMarket(storeId: string): Promise<Market | null> {
    return this.marketModel.findOne({ storeId, isPrimary: true, isDelete: false }).lean();
  }

  /** The market a buyer from `countryCode` shops in: a market listing the country, else the primary one. */
  async getMarketForCountry(storeId: string, countryCode: string | null | undefined): Promise<Market | null> {
    return (await this.resolveForCheckout(storeId, countryCode)).market;
  }

  /**
   * Shopify rule: a country listed in a market buys there; any other country falls to the primary market only when
   * the primary market covers "every other country" (no countries listed). Otherwise the buyer can browse but not buy.
   * A store without markets keeps the old behaviour (no market, nobody blocked).
   */
  async resolveForCheckout(storeId: string, countryCode: string | null | undefined): Promise<CheckoutMarketResolution> {
    const markets: any[] = await this.marketModel.find({ storeId, isActive: true, isDelete: false }).lean();
    if (!markets.length) return { market: null, blocked: false };
    const code = normalizeCountryCode(countryCode);
    const hit = pickMarketForCountry(markets, code);
    if (!code || !hit) return { market: await this.asSellableMarket(storeId, hit), blocked: !hit && !!code };
    const listed = (hit.countries ?? []).some((c: string) => String(c).toUpperCase() === code);
    if (listed || !(hit.countries ?? []).length) return { market: await this.asSellableMarket(storeId, hit), blocked: false };
    return { market: null, blocked: true };
  }

  /**
   * Shopify: a store can sell in local (market) currencies only with Shopify Payments (or Adyen). With any other
   * processor customers in every market pay in the store's default currency. Solvexo's equivalent of Shopify Payments
   * is the platform card rail: a fully onboarded Stripe Connect account on the store.
   */
  async supportsLocalCurrencies(storeId: string): Promise<boolean> {
    const s: any = await this.databaseService.repositories.storeModel
      .findById(storeId).select('stripeConnectStatus stripeConnectChargesEnabled stripeConnectPayoutsEnabled').lean();
    return !!s && s.stripeConnectStatus === 'active' && !!s.stripeConnectChargesEnabled && !!s.stripeConnectPayoutsEnabled;
  }

  /** A market as the buyer can really buy in it: without the local-currency rail it sells in the store currency, no conversion rule. */
  private async asSellableMarket(storeId: string, market: any | null): Promise<any | null> {
    if (!market || (await this.supportsLocalCurrencies(storeId))) return market;
    const store: any = await this.databaseService.repositories.storeModel.findById(storeId).select('baseCurrency').lean();
    return store?.baseCurrency ? this.inStoreCurrency(market, store.baseCurrency) : market;
  }

  private inStoreCurrency(market: any, baseCurrency: string): any {
    return { ...market, currency: baseCurrency, pricingRule: { type: 'auto', manualRate: null, percentageAdjustment: null, useRounding: false, roundingRule: 'nearest', conversionFee: null } };
  }

  /** What the storefront may know about a store's markets (no internal fields). */
  async getPublicMarkets(storeId: string) {
    const [rawMarkets, store, limits, platformCurrencies, local]: [any[], any, { maxMarkets: number }, { code: string }[], boolean] = await Promise.all([
      this.marketModel.find({ storeId, isActive: true, isDelete: false }).sort({ isPrimary: -1, name: 1 }).lean(),
      this.databaseService.repositories.storeModel.findById(storeId).select('defaultLanguage baseCurrency enabledCurrencies').lean(),
      this.entitlementsService.getLimits(storeId),
      this.adminConfigService.getEnabledCurrencies(),
      this.supportsLocalCurrencies(storeId),
    ]);
    // No local-currency rail: every market sells in the store currency (see supportsLocalCurrencies).
    const allMarkets = local || !store?.baseCurrency ? rawMarkets : rawMarkets.map((m) => this.inStoreCurrency(m, store.baseCurrency));
    // Checkout only prices in the currencies the store + plan allow. This is the SAME list and trim as
    // CheckoutService.resolveStoreCurrency (store list, else the platform list; plan cap, base currency first), so the
    // storefront never offers a market the buyer could not actually pay in (e.g. after a plan downgrade).
    const allowed: string[] = Array.isArray(store?.enabledCurrencies) && store.enabledCurrencies.length
      ? store.enabledCurrencies
      : platformCurrencies.map((c) => c.code);
    const keptCurrencies = new Set(trimToMarketsLimit(allowed, store?.baseCurrency, limits.maxMarkets));
    const markets = allMarkets.filter((m) => m.isPrimary || keptCurrencies.has(m.currency));
    const defaultLanguage = String(store?.defaultLanguage || 'en').toLowerCase();
    const languages = Array.from(new Set([
      defaultLanguage,
      ...markets.flatMap((m) => (m.languages ?? []).map((l: string) => String(l).toLowerCase())),
    ]));
    return {
      defaultLanguage,
      languages,
      markets: markets.map((m) => ({
        id: String(m._id),
        name: m.name,
        countries: m.countries ?? [],
        currency: m.currency,
        languages: m.languages ?? [],
        isPrimary: !!m.isPrimary,
        domainType: m.domainType ?? 'primary',
        subfolder: m.subfolder ?? null,
        domain: m.domain ?? null,
        productAvailability: m.productAvailability ?? 'all',
        productIds: m.productAvailability && m.productAvailability !== 'all' ? (m.productIds ?? []) : [],
        pricingRule: {
          type: m.pricingRule?.type ?? 'auto',
          manualRate: manualRateOf(m.pricingRule),
          percentageAdjustment: m.pricingRule?.percentageAdjustment ?? null,
          useRounding: !!m.pricingRule?.useRounding,
          roundingRule: m.pricingRule?.roundingRule ?? 'nearest',
          conversionFee: m.pricingRule?.conversionFee ?? null,
        },
      })),
    };
  }

  /**
   * Get the pricing rule for a market.
   */
  async getMarketPricingRule(storeId: string, marketId: string): Promise<any> {
    const market = await this.findOne(storeId, marketId);
    return market.pricingRule;
  }
}

/** True when `productId` may be sold in `market` (Shopify catalog availability). No market = everything. */
export function isProductAvailableInMarket(market: any | null | undefined, productId: string): boolean {
  if (!market) return true;
  const mode = market.productAvailability ?? 'all';
  if (mode === 'all') return true;
  const listed = (market.productIds ?? []).map(String).includes(String(productId));
  return mode === 'include' ? listed : !listed;
}
