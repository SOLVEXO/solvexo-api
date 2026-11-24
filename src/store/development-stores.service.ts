/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes, randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { StoreThemeService } from '../store-theme/store-theme.service';
import { StorePagesService } from '../store-pages/store-pages.service';
import { StorefrontAccessService } from '../storefront/storefront-access.service';
import { ProductType as StoreProductType, resolveTools } from './schemas/store.schema';
import { ProductType } from '../products/schemas/product.schema';

export const MAX_DEVELOPMENT_STORES = 3;

/** Words for the storefront password: easy to read out and type, no look-alike letters. */
const WORDS = ['amber', 'cedar', 'delta', 'ember', 'fable', 'harbor', 'indigo', 'jasper', 'kettle', 'lotus', 'maple', 'nectar', 'orbit', 'pepper', 'quartz', 'river', 'saffron', 'tundra', 'velvet', 'willow'];
export const newStorePassword = () => `${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}-${randomInt(100, 1000)}`;

const SAMPLE_PRODUCTS = [
  { name: 'Sample cotton kurta', description: 'A sample product for testing your app. Two sizes, tracked stock.', price: 2500, variants: [{ size: 'M', stock: 20 }, { size: 'L', stock: 12 }] },
  { name: 'Sample leather wallet', description: 'A sample product for testing your app. One variant, low stock.', price: 1800, variants: [{ size: null, stock: 3 }] },
  { name: 'Sample gift card design', description: 'A sample product for testing your app. Unlimited stock.', price: 1000, variants: [{ size: null, stock: null }] },
];

/**
 * Development stores (Shopify-style): a developer's free test stores for building and testing apps.
 *   - free and fully featured: a subscription row with status 'development' (entitlements treat it like a trial that
 *     never ends; the trial/renewal jobs never look at it; plan purchase is refused);
 *   - hidden: always password-protected (enforced server-side by StorefrontAccessService), kept off the marketplace and
 *     sitemap, never a custom domain;
 *   - no real payments: buyer checkout and payment routes refuse it (BillingAccessGuard); test orders come from draft orders;
 *   - can't go live: the password can be changed but not removed, and a development store can't be turned into a live one.
 * It does NOT use the seller's one-time trial and doesn't notify admins about a "new store".
 */
@Injectable()
export class DevelopmentStoresService {
  private readonly log = new Logger('DevelopmentStores');
  constructor(
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    private readonly adminConfig: AdminConfigService,
    private readonly themes: StoreThemeService,
    private readonly pages: StorePagesService,
    private readonly storefrontAccess: StorefrontAccessService,
  ) {}
  private get r() { return this.db.repositories as any; }

  async list(sellerId: string) {
    const rows: any[] = await this.r.storeModel.find({ sellerId, isDevelopment: true, isDelete: false }).sort({ createdAt: -1 }).select('name slug baseCurrency createdAt').lean();
    return { items: rows.map((s) => ({ id: String(s._id), name: s.name, slug: s.slug, currency: s.baseCurrency, createdAt: s.createdAt })), max: MAX_DEVELOPMENT_STORES };
  }

  /** The storefront password comes back once, here (only its hash is kept; the store's settings can set a new one). */
  async create(sellerId: string, body: any) {
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) throw new BadRequestException('Give the test store a name');
    if ((await this.r.storeModel.countDocuments({ sellerId, isDevelopment: true, isDelete: false })) >= MAX_DEVELOPMENT_STORES) {
      throw new BadRequestException(`At most ${MAX_DEVELOPMENT_STORES} development stores per account. Delete one to make another.`);
    }
    const enabled = await this.adminConfig.getEnabledCurrencies();
    const wanted = typeof body?.currency === 'string' ? body.currency.trim().toUpperCase() : '';
    const currency = enabled.find((c: any) => c.code === wanted)?.code ?? enabled.find((c: any) => c.code === 'PKR')?.code ?? enabled[0]?.code;
    if (!currency) throw new BadRequestException('No currencies are enabled on the platform yet');

    const slug = await this.uniqueSlug(name);
    const password = newStorePassword();
    const productTypes = [StoreProductType.PHYSICAL_PRODUCTS, StoreProductType.IN_PERSON_POS];
    const store: any = await this.r.storeModel.create({
      sellerId, name, slug, baseCurrency: currency, enabledCurrencies: [currency], productTypes, enabledTools: resolveTools(productTypes),
      status: 'active', reviewedAt: new Date(), isDelete: false,
      isDevelopment: true, privacyMode: 'password', storePasswordHash: await bcrypt.hash(password, 10), marketplaceHidden: true,
    });
    const storeId = String(store._id);
    try {
      await this.r.sellerPlatformSubscriptionModel.create({ storeId, sellerId, platformPlanId: null, billingInterval: 'monthly', amountUSD: 0, status: 'development', startedAt: new Date(), isDelete: false });
      await this.themes.ensureDefaultTheme(storeId);
      await this.pages.ensureHomePage(storeId);
      await this.seedSampleProducts(sellerId, storeId, currency);
    } catch (e) {
      // Half a test store is worse than none: undo and report.
      await this.r.storeModel.deleteOne({ _id: storeId });
      await this.r.sellerPlatformSubscriptionModel.deleteMany({ storeId });
      await this.r.productVariantModel.deleteMany({ storeId });
      await this.r.productModel.deleteMany({ storeId });
      this.log.error(`Development store setup failed: ${(e as Error)?.message}`);
      throw e;
    }
    void this.activity.log({ storeId, category: 'store', action: 'development_store_created', description: `Development store "${name}" created`, actorId: sellerId, actorRole: 'seller', targetId: storeId, targetType: 'store' } as any).catch(() => undefined);
    return { id: storeId, name, slug, currency, password };
  }

  /** Deleting hides it everywhere (soft delete, like any store) and ends its development subscription. */
  async remove(sellerId: string, storeId: string) {
    if (!Types.ObjectId.isValid(storeId)) throw new NotFoundException('Development store not found');
    const r = await this.r.storeModel.updateOne({ _id: storeId, sellerId, isDevelopment: true, isDelete: false }, { $set: { isDelete: true } });
    if (!r.modifiedCount) throw new NotFoundException('Development store not found');
    await this.r.sellerPlatformSubscriptionModel.updateMany({ storeId, status: 'development' }, { $set: { isDelete: true } });
    this.storefrontAccess.invalidate(storeId);
    void this.activity.log({ storeId, category: 'store', action: 'development_store_deleted', description: 'Development store deleted', actorId: sellerId, actorRole: 'seller', targetId: storeId, targetType: 'store' } as any).catch(() => undefined);
    return { success: true };
  }

  private async uniqueSlug(name: string) {
    const base = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'store'}-dev`;
    for (let i = 0; i < 8; i++) {
      const slug = i === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
      if (!(await this.r.storeModel.exists({ slug }))) return slug;
    }
    throw new BadRequestException('Could not pick a store address; try another name');
  }

  /** Three products with variants and stock, so an app has something to read and change from the first minute. */
  private async seedSampleProducts(sellerId: string, storeId: string, currency: string) {
    const category: any = await this.r.categoryModel.findOne({ isDelete: { $ne: true }, status: { $ne: 'inactive' }, storeId: null }).sort({ sortOrder: 1 }).select('_id').lean()
      ?? await this.r.categoryModel.findOne({ isDelete: { $ne: true } }).select('_id').lean();
    if (!category) return; // no catalog categories on this platform yet: the store simply starts empty
    for (const [n, p] of SAMPLE_PRODUCTS.entries()) {
      const product: any = await this.r.productModel.create({
        sellerId, storeId, name: p.name, slug: `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n + 1}`, description: p.description,
        productType: ProductType.PHYSICAL, type: 'physical', categoryId: String(category._id), status: 'active', isDelete: false, tags: ['sample'], images: [],
      });
      for (const [i, v] of p.variants.entries()) {
        await this.r.productVariantModel.create({
          productId: String(product._id), storeId, sku: `SAMPLE-${n + 1}${v.size ? `-${v.size}` : ''}`, price: p.price, currency,
          options: v.size ? [{ name: 'Size', value: v.size }] : [], stock: v.stock ?? 0, unlimitedStock: v.stock === null,
          isDefault: i === 0, status: 'active', isDelete: false,
        });
      }
    }
  }
}
