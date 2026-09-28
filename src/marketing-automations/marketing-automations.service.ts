/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { EmailService } from '@/otp/services/email.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { newsletterUnsubscribeUrl, normalizeEmail } from '@/newsletter/newsletter-consent.util';
import {
  discountCodeHtml, escapeHtml, formatMoney, productCardHtml, renderMarketingEmail,
  renderMergeTags, storePublicUrl, textToHtml, unsubscribeHeaders,
} from '@/newsletter/marketing-email.util';
import { AutomationType } from './schemas/automation-send-log.schema';
import { AutomationSettingsShape, resolveAutomationSettings } from './schemas/marketing-automation-settings.schema';

const BATCH = 500;

type StoreLite = { _id: any; name: string; slug?: string; customDomain?: string | null; customDomainStatus?: string; contactEmail?: string | null; baseCurrency?: string | null };

/**
 * Shopify-style marketing automations for one store:
 *  - welcome        new subscriber → welcome email (optional discount code)
 *  - back in stock  "Notify me" on a sold-out variant → email once it's sellable
 *  - price drop     wishlisted variant's price falls ≥ N% → email subscribed wishers
 *  - win-back       no order for N days → one "we miss you" per lapse
 * Price drop and win-back are marketing, so they only reach active subscribers
 * and carry an unsubscribe link; back-in-stock was explicitly requested for
 * one product, so it goes to whoever asked.
 */
@Injectable()
export class MarketingAutomationsService {
  private readonly logger = new Logger(MarketingAutomationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly emailService: EmailService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  private get r() {
    return this.db.repositories;
  }

  async assertStoreOwner(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }).select('sellerId').lean().catch(() => null);
    if (!store) throw new NotFoundException('Store not found');
    if (String((store as any).sellerId) !== String(sellerId)) throw new ForbiddenException('Not your store');
  }

  private async loadStore(storeId: string): Promise<StoreLite | null> {
    return (await this.r.storeModel.findOne({ _id: storeId, isDelete: false })
      .select('name slug customDomain customDomainStatus contactEmail baseCurrency').lean().catch(() => null)) as any;
  }

  async getSettings(storeId: string): Promise<AutomationSettingsShape> {
    const row = await this.r.marketingAutomationSettingsModel.findOne({ storeId }).lean();
    return resolveAutomationSettings(row as any);
  }

  // ── Seller settings / stats ──────────────────────────────────────────────

  async getSettingsForSeller(storeId: string) {
    return { success: true, data: await this.getSettings(storeId) };
  }

  async updateSettings(storeId: string, input: any) {
    if (!input || typeof input !== 'object') throw new BadRequestException('Invalid settings');
    const set: Record<string, unknown> = {};
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const int = (v: unknown, min: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;

    const sections: Record<string, Record<string, (v: unknown) => unknown>> = {
      welcome: { enabled: bool, subject: (v) => str(v, 200), message: (v) => str(v, 5000), discountCode: (v) => v },
      backInStock: { enabled: bool, subject: (v) => str(v, 200), message: (v) => str(v, 5000) },
      priceDrop: { enabled: bool, minDropPercent: (v) => int(v, 1, 90), subject: (v) => str(v, 200), message: (v) => str(v, 5000) },
      winBack: { enabled: bool, afterDays: (v) => int(v, 14, 365), subject: (v) => str(v, 200), message: (v) => str(v, 5000), discountCode: (v) => v },
    };

    for (const [section, fields] of Object.entries(sections)) {
      const given = input[section];
      if (!given || typeof given !== 'object') continue;
      for (const [field, parse] of Object.entries(fields)) {
        if (!(field in given)) continue;
        if (field === 'discountCode') {
          set[`${section}.discountCode`] = await this.validateDiscountCode(storeId, given.discountCode);
          continue;
        }
        const value = parse(given[field]);
        if (value !== undefined) set[`${section}.${field}`] = value;
      }

      // Editor design + its rendered HTML travel together; null clears both
      // (back to the plain-text message).
      if ('design' in given) {
        if (given.design === null) {
          set[`${section}.design`] = null;
          set[`${section}.html`] = null;
        } else {
          const design = given.design;
          if (!design || typeof design !== 'object' || design.version !== 1 || !Array.isArray(design.blocks)) {
            throw new BadRequestException('Invalid email design');
          }
          if (typeof given.html !== 'string' || !given.html.trim()) throw new BadRequestException('The rendered email HTML is missing');
          if (given.html.length > 500_000) throw new BadRequestException('This email is too large');
          // Every discount section must show a real coupon of this store.
          for (const block of design.blocks as any[]) {
            if (block?.type === 'discount' && block.code) await this.validateDiscountCode(storeId, String(block.code));
          }
          set[`${section}.design`] = design;
          set[`${section}.html`] = given.html;
        }
      }
    }
    if (typeof input.doubleOptIn === 'boolean') set.doubleOptIn = input.doubleOptIn;
    if (Object.keys(set).length === 0) throw new BadRequestException('Nothing to update');

    await this.r.marketingAutomationSettingsModel.updateOne(
      { storeId },
      { $set: set, $setOnInsert: { storeId } },
      { upsert: true },
    );
    return { success: true, message: 'Automations saved', data: await this.getSettings(storeId) };
  }

  /** An automation's code must be a real, live coupon of this store — a typo
   *  would otherwise go out to every recipient as a code that doesn't work. */
  private async validateDiscountCode(storeId: string, raw: unknown): Promise<string | null> {
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
    if (typeof raw !== 'string') throw new BadRequestException('Invalid discount code');
    const code = raw.trim().toUpperCase();
    const coupon = await this.r.couponModel.findOne({ storeId, code, isDelete: false }).lean();
    if (!coupon) throw new BadRequestException(`Discount code "${code}" doesn't exist in this store. Create it under Marketing → Coupons first.`);
    return code;
  }

  async getStats(storeId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [byType, allTime, pendingBackInStock, topRequested] = await Promise.all([
      this.r.automationSendLogModel.aggregate([
        { $match: { storeId, createdAt: { $gte: since }, delivered: true } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]),
      this.r.automationSendLogModel.aggregate([
        { $match: { storeId, delivered: true } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]),
      this.r.backInStockRequestModel.countDocuments({ storeId, status: 'pending' }),
      this.r.backInStockRequestModel.aggregate([
        { $match: { storeId, status: 'pending' } },
        { $group: { _id: '$productId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);
    const products = topRequested.length
      ? await this.r.productModel.find({ _id: { $in: topRequested.map((t: any) => t._id) } }).select('name').lean()
      : [];
    const nameById = new Map(products.map((p: any) => [String(p._id), p.name]));
    const toMap = (rows: any[]) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
    return {
      success: true,
      data: {
        last30Days: toMap(byType),
        allTime: toMap(allTime),
        pendingBackInStock,
        topBackInStockProducts: topRequested.map((t: any) => ({ productId: t._id, name: nameById.get(String(t._id)) ?? 'Product', requests: t.count })),
      },
    };
  }

  // ── Test send ──────────────────────────────────────────────────────────

  /** "[Test]" copy of one automation's current email, filled with sample
   *  data (the store's first active product for product emails). */
  async sendTest(storeId: string, section: string, email: string | null) {
    if (!['welcome', 'backInStock', 'priceDrop', 'winBack'].includes(section)) throw new BadRequestException('Unknown automation');
    if (!email) throw new BadRequestException('No email address to send the test to');
    const [settings, store] = await Promise.all([this.getSettings(storeId), this.loadStore(storeId)]);
    if (!store) throw new NotFoundException('Store not found');
    const cfg = settings[section as 'welcome' | 'backInStock' | 'priceDrop' | 'winBack'];

    const product = await this.r.productModel.findOne({ storeId, isDelete: false, status: 'active' }).select('name slug images').lean() as any;
    const variant = product ? await this.r.productVariantModel.findOne({ productId: String(product._id) }).select('price currency images').lean() as any : null;
    const base = storePublicUrl(store);
    const currency = variant?.currency ?? store.baseCurrency;
    const newPrice = typeof variant?.price === 'number' ? variant.price : 49;
    const oldPrice = Math.round(newPrice * 1.25 * 100) / 100;
    const productName = product?.name ?? 'Sample product';
    const imageUrl = variant?.images?.[0] ?? product?.images?.[0] ?? null;

    const text: Record<string, string> = {
      customerName: 'Alex',
      storeName: store.name,
      shopUrl: base ?? '',
      productName,
      productUrl: base && product?.slug ? `${base}/product/${product.slug}` : base ?? '',
      productPrice: formatMoney(newPrice, currency),
      oldPrice: formatMoney(oldPrice, currency),
      newPrice: formatMoney(newPrice, currency),
      discountCode: (cfg as any).discountCode ?? '',
    };
    const priceLine = section === 'priceDrop'
      ? `<span style="text-decoration:line-through;color:#8b8985">${escapeHtml(text.oldPrice)}</span> &nbsp;<strong>${escapeHtml(text.newPrice)}</strong>`
      : escapeHtml(text.productPrice);
    const subject = renderMergeTags(cfg.subject, text);
    const reason = 'This is a test of one of your automated emails.';
    const html = this.renderDesigned(cfg.html, text, { productImage: this.productImageFragment(imageUrl), priceLine }, reason, '#')
      ?? renderMarketingEmail({
        senderName: store.name,
        heading: subject,
        bodyHtml: textToHtml(renderMergeTags(cfg.message, text)),
        extraHtml: section === 'backInStock' || section === 'priceDrop'
          ? productCardHtml({ name: productName, imageUrl, priceLine })
          : (cfg as any).discountCode ? discountCodeHtml((cfg as any).discountCode) : '',
        cta: base ? { url: text.productUrl || base, label: 'Shop now' } : null,
        reason,
        unsubscribeUrl: '#',
      });
    const sent = await this.emailService.sendMail(email, `[Test] ${subject}`, html, store.contactEmail ?? null);
    if (!sent) throw new BadRequestException('The test email could not be sent. Check the email settings and try again.');
    return { success: true, message: `Test email sent to ${email}` };
  }

  // ── Double opt-in confirmation ─────────────────────────────────────────

  /** "Confirm your subscription" — sent instead of the welcome email when the
   *  store has double opt-in on. Transactional (they just asked for it), so
   *  no unsubscribe link: ignoring it simply means no subscription. */
  async sendConfirmation(storeId: string, email: string, confirmUrl: string): Promise<boolean> {
    const store = await this.loadStore(storeId);
    if (!store) return false;
    const html = renderMarketingEmail({
      senderName: store.name,
      heading: 'Confirm your subscription',
      bodyHtml: textToHtml(`Please confirm that you want to receive emails from ${store.name} — news, offers and new arrivals.\n\nIf you didn't sign up, just ignore this email.`),
      cta: { url: confirmUrl, label: 'Confirm subscription' },
      reason: `You're receiving this because this address was entered to subscribe to ${store.name}.`,
    });
    return this.emailService.sendMail(email, `Confirm your subscription to ${store.name}`, html, store.contactEmail ?? null);
  }

  // ── Welcome (called by NewsletterService on a new store subscription) ──

  async sendWelcome(storeId: string, email: string, unsubscribeToken: string, customerName?: string | null): Promise<boolean> {
    const [settings, store] = await Promise.all([this.getSettings(storeId), this.loadStore(storeId)]);
    if (!store || !settings.welcome.enabled) return false;
    const vars = { customerName: customerName || 'there', storeName: store.name };
    const unsubscribeUrl = newsletterUnsubscribeUrl(unsubscribeToken);
    const shopUrl = storePublicUrl(store);
    const reason = `You're receiving this because you subscribed to emails from ${store.name}.`;
    const html = this.renderDesigned(
      settings.welcome.html,
      { ...vars, shopUrl: shopUrl ?? '', discountCode: settings.welcome.discountCode ?? '' },
      {},
      reason,
      unsubscribeUrl,
    ) ?? renderMarketingEmail({
      senderName: store.name,
      heading: renderMergeTags(settings.welcome.subject, vars),
      bodyHtml: textToHtml(renderMergeTags(settings.welcome.message, vars)),
      extraHtml: settings.welcome.discountCode ? discountCodeHtml(settings.welcome.discountCode) : '',
      cta: shopUrl ? { url: shopUrl, label: 'Start shopping' } : null,
      reason,
      unsubscribeUrl,
    });
    const sent = await this.emailService.sendMail(email, renderMergeTags(settings.welcome.subject, vars), html, store.contactEmail ?? null, unsubscribeHeaders(unsubscribeUrl));
    await this.log(storeId, 'welcome', email, `sub:${unsubscribeToken}`, sent);
    return sent;
  }

  /** A section's editor HTML (see the web app's emailDesign.ts) with its
   *  {{tags}} filled and the standard footer appended — or null when the
   *  seller never designed it, so the caller sends the plain-text email.
   *  `text` values are escaped (they land in text and href/src attributes);
   *  `raw` values are HTML fragments this service built itself. */
  private renderDesigned(
    html: string | null | undefined,
    text: Record<string, string>,
    raw: Record<string, string>,
    reason: string,
    unsubscribeUrl?: string | null,
  ): string | null {
    if (!html) return null;
    let out = html;
    for (const [k, v] of Object.entries(raw)) out = out.split(`{{${k}}}`).join(v);
    for (const [k, v] of Object.entries(text)) out = out.split(`{{${k}}}`).join(escapeHtml(v));
    const footer = `<p style="margin:0 auto;max-width:600px;padding:16px 12px;color:#888;font-size:12px;text-align:center;font-family:sans-serif">${escapeHtml(reason)}${unsubscribeUrl ? `<br /><a href="${unsubscribeUrl}" style="color:#888">Unsubscribe</a>` : ''}</p>`;
    return out + footer;
  }

  /** The dynamic-product section's image fragment ({{productImage}}). */
  private productImageFragment(url: string | null | undefined): string {
    return url ? `<img src="${escapeHtml(url)}" alt="" width="240" style="display:block;width:240px;max-width:100%;height:auto;border:0;border-radius:6px;margin:0 auto 12px" />` : '';
  }

  private async log(storeId: string, type: AutomationType, email: string, refKey: string, delivered: boolean) {
    await this.r.automationSendLogModel.create({ storeId, type, email: normalizeEmail(email), refKey, delivered }).catch((e: any) => {
      if (e?.code !== 11000) this.logger.warn(`automation log failed: ${e?.message}`);
    });
  }

  /** Claims (storeId,type,email,refKey) before sending — the unique index makes
   *  a concurrent/double cron tick lose the race instead of sending twice. */
  private async claim(storeId: string, type: AutomationType, email: string, refKey: string): Promise<string | null> {
    try {
      const row = await this.r.automationSendLogModel.create({ storeId, type, email: normalizeEmail(email), refKey, delivered: false });
      return String(row._id);
    } catch (e: any) {
      if (e?.code === 11000) return null;
      throw e;
    }
  }

  private async markDelivered(logId: string, delivered: boolean) {
    if (delivered) await this.r.automationSendLogModel.updateOne({ _id: logId }, { $set: { delivered: true } });
    // Failed send → drop the claim so the next tick retries.
    else await this.r.automationSendLogModel.deleteOne({ _id: logId });
  }

  // ── Back in stock ────────────────────────────────────────────────────────

  private isSellable(v: any): boolean {
    if (!v || v.isDelete || (v.status && v.status !== 'active')) return false;
    if (v.unlimitedStock || v.allowBackorder) return true;
    return (Number(v.stock) || 0) - (Number(v.committedStock) || 0) > 0;
  }

  async publicConfig(storeId: string) {
    const settings = await this.getSettings(storeId);
    return { success: true, data: { backInStockEnabled: settings.backInStock.enabled } };
  }

  async requestBackInStock(input: { storeId: string; productId: string; variantId: string; email: string; userId?: string | null }) {
    const email = normalizeEmail(input.email);
    if (!isEmail(email)) throw new BadRequestException('Please enter a valid email address');
    const settings = await this.getSettings(input.storeId);
    if (!settings.backInStock.enabled) throw new BadRequestException('Back-in-stock alerts are not available for this store');

    const product = await this.r.productModel.findOne({ _id: input.productId, storeId: input.storeId, isDelete: false }).select('_id').lean().catch(() => null);
    if (!product) throw new NotFoundException('Product not found');
    const variant = await this.r.productVariantModel.findOne({ _id: input.variantId, productId: input.productId }).lean().catch(() => null);
    if (!variant) throw new NotFoundException('Variant not found');
    if (this.isSellable(variant)) {
      return { success: true, message: 'Good news — this item is in stock right now.', data: { inStock: true } };
    }

    try {
      await this.r.backInStockRequestModel.create({
        storeId: input.storeId, productId: input.productId, variantId: input.variantId,
        email, userId: input.userId ?? null, status: 'pending',
      });
    } catch (e: any) {
      if (e?.code !== 11000) throw e; // already waiting on this one — same answer
    }
    return { success: true, message: "We'll email you as soon as it's back in stock.", data: { inStock: false } };
  }

  async processBackInStock(): Promise<{ notified: number }> {
    const variantIds: string[] = (await this.r.backInStockRequestModel.distinct('variantId', { status: 'pending' })).slice(0, BATCH).map(String);
    if (variantIds.length === 0) return { notified: 0 };

    const variants = await this.r.productVariantModel.find({ _id: { $in: variantIds } }).lean();
    let notified = 0;
    const storeCache = new Map<string, { store: StoreLite | null; settings: AutomationSettingsShape }>();

    for (const v of variants as any[]) {
      if (!this.isSellable(v)) continue;
      const product = await this.r.productModel.findOne({ _id: v.productId, isDelete: false }).select('name slug images storeId status').lean() as any;
      if (!product || (product.status && product.status !== 'active')) continue;
      const storeId = String(product.storeId);
      if (!storeCache.has(storeId)) storeCache.set(storeId, { store: await this.loadStore(storeId), settings: await this.getSettings(storeId) });
      const { store, settings } = storeCache.get(storeId)!;
      if (!store || !settings.backInStock.enabled) continue;

      const variantLabel = (v.options ?? []).map((o: any) => o.value).filter(Boolean).join(' / ');
      const productName = variantLabel ? `${product.name} (${variantLabel})` : product.name;
      const base = storePublicUrl(store);
      const productUrl = base && product.slug ? `${base}/product/${product.slug}` : base;

      const requests = await this.r.backInStockRequestModel.find({ variantId: String(v._id), status: 'pending' }).limit(BATCH).lean();
      for (const req of requests as any[]) {
        // Flip first so an overlapping tick can't pick the same request up.
        const claimed = await this.r.backInStockRequestModel.updateOne(
          { _id: req._id, status: 'pending' },
          { $set: { status: 'notified', notifiedAt: new Date() } },
        );
        if (!claimed.modifiedCount) continue;

        const vars = { customerName: 'there', storeName: store.name, productName };
        const subject = renderMergeTags(settings.backInStock.subject, vars);
        const imageUrl = v.images?.[0] ?? product.images?.[0] ?? null;
        const price = typeof v.price === 'number' ? formatMoney(v.price, v.currency ?? store.baseCurrency) : '';
        const reason = `You're receiving this because you asked ${store.name} to tell you when this item was back in stock.`;
        const html = this.renderDesigned(
          settings.backInStock.html,
          { ...vars, productUrl: productUrl ?? '', shopUrl: base ?? '', productPrice: price },
          { productImage: this.productImageFragment(imageUrl), priceLine: escapeHtml(price) },
          reason,
        ) ?? renderMarketingEmail({
          senderName: store.name,
          heading: subject,
          bodyHtml: textToHtml(renderMergeTags(settings.backInStock.message, vars)),
          extraHtml: productCardHtml({ name: productName, imageUrl, priceLine: price ? escapeHtml(price) : null }),
          cta: productUrl ? { url: productUrl, label: 'Shop now' } : null,
          reason,
        });
        const sent = await this.emailService.sendMail(req.email, subject, html, store.contactEmail ?? null);
        if (!sent) {
          await this.r.backInStockRequestModel.updateOne({ _id: req._id }, { $set: { status: 'pending', notifiedAt: null } });
          continue;
        }
        await this.log(storeId, 'back_in_stock', req.email, `req:${req._id}`, true);
        notified++;
      }
    }
    return { notified };
  }

  // ── Price drop ───────────────────────────────────────────────────────────

  private async marketingAllowed(storeId: string): Promise<boolean> {
    try {
      await this.entitlementsService.assertFeatureAllowed(storeId, 'emailCampaignsAllowed', 'Email Campaigns');
      return true;
    } catch {
      return false;
    }
  }

  /** Active subscriber rows for these emails at this store, keyed by email. */
  private async activeSubscribers(storeId: string, emails: string[]) {
    if (emails.length === 0) return new Map<string, string>();
    const rows = await this.r.newsletterSubscriberModel.find({ storeId, isActive: true, email: { $in: emails } }).select('email unsubscribeToken').lean();
    return new Map(rows.map((r: any) => [r.email, r.unsubscribeToken as string]));
  }

  async processPriceDrops(): Promise<{ notified: number }> {
    const enabled = await this.r.marketingAutomationSettingsModel.find({ 'priceDrop.enabled': true }).select('storeId').lean();
    let notified = 0;
    for (const row of enabled as any[]) {
      const storeId = String(row.storeId);
      try {
        if (!(await this.marketingAllowed(storeId))) continue;
        notified += await this.processPriceDropsForStore(storeId);
      } catch (e: any) {
        this.logger.error(`price drop for store ${storeId} failed: ${e?.message}`);
      }
    }
    return { notified };
  }

  private async processPriceDropsForStore(storeId: string): Promise<number> {
    const [settings, store] = await Promise.all([this.getSettings(storeId), this.loadStore(storeId)]);
    if (!store || !settings.priceDrop.enabled) return 0;

    // A malformed id would make the whole $in query throw a CastError.
    const variantIds: string[] = (await this.r.wishListModel.distinct('productVariantId', { storeId }))
      .map(String).filter((id) => isValidObjectId(id)).slice(0, BATCH);
    if (variantIds.length === 0) return 0;
    const [variants, snapshots] = await Promise.all([
      this.r.productVariantModel.find({ _id: { $in: variantIds }, isDelete: { $ne: true } }).lean(),
      this.r.priceSnapshotModel.find({ variantId: { $in: variantIds } }).lean(),
    ]);
    const snapshotByVariant = new Map(snapshots.map((s: any) => [s.variantId, s.price as number]));
    let notified = 0;

    for (const v of variants as any[]) {
      const variantId = String(v._id);
      const price = Number(v.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const last = snapshotByVariant.get(variantId);

      if (last === undefined || price > last) {
        await this.r.priceSnapshotModel.updateOne({ variantId }, { $set: { variantId, storeId, price } }, { upsert: true });
        continue;
      }
      const dropPercent = ((last - price) / last) * 100;
      if (dropPercent < settings.priceDrop.minDropPercent) continue; // keep baseline so small cuts add up

      const product = await this.r.productModel.findOne({ _id: v.productId, isDelete: false }).select('name slug images status').lean() as any;
      if (product && (!product.status || product.status === 'active')) {
        notified += await this.sendPriceDrop(storeId, store, settings, v, product, last, price);
      }
      await this.r.priceSnapshotModel.updateOne({ variantId }, { $set: { price } });
    }
    return notified;
  }

  private async sendPriceDrop(storeId: string, store: StoreLite, settings: AutomationSettingsShape, v: any, product: any, oldPrice: number, newPrice: number) {
    const userIds = (await this.r.wishListModel.distinct('userId', { storeId, productVariantId: String(v._id) })).map(String).filter((id) => isValidObjectId(id));
    const users = await this.r.userModel.find({ _id: { $in: userIds }, isDelete: { $ne: true } }).select('name email').lean();
    const subs = await this.activeSubscribers(storeId, users.map((u: any) => normalizeEmail(u.email)));
    const currency = v.currency ?? store.baseCurrency;
    const vars = {
      storeName: store.name,
      productName: product.name,
      oldPrice: formatMoney(oldPrice, currency),
      newPrice: formatMoney(newPrice, currency),
    };
    const base = storePublicUrl(store);
    const productUrl = base && product.slug ? `${base}/product/${product.slug}` : base;
    let sent = 0;

    for (const u of users as any[]) {
      const email = normalizeEmail(u.email);
      const token = subs.get(email);
      if (!token) continue; // not subscribed to this store's marketing
      const logId = await this.claim(storeId, 'price_drop', email, `${v._id}:${newPrice}`);
      if (!logId) continue;
      const personal = { ...vars, customerName: u.name || 'there' };
      const unsubscribeUrl = newsletterUnsubscribeUrl(token);
      const subject = renderMergeTags(settings.priceDrop.subject, personal);
      const imageUrl = v.images?.[0] ?? product.images?.[0] ?? null;
      const priceLine = `<span style="text-decoration:line-through;color:#8b8985">${escapeHtml(vars.oldPrice)}</span> &nbsp;<strong>${escapeHtml(vars.newPrice)}</strong>`;
      const reason = `You're receiving this because this item is on your wishlist at ${store.name} and you subscribed to its emails.`;
      const html = this.renderDesigned(
        settings.priceDrop.html,
        { ...personal, productUrl: productUrl ?? '', shopUrl: base ?? '', productPrice: vars.newPrice },
        { productImage: this.productImageFragment(imageUrl), priceLine },
        reason,
        unsubscribeUrl,
      ) ?? renderMarketingEmail({
        senderName: store.name,
        heading: subject,
        bodyHtml: textToHtml(renderMergeTags(settings.priceDrop.message, personal)),
        extraHtml: productCardHtml({ name: product.name, imageUrl, priceLine }),
        cta: productUrl ? { url: productUrl, label: 'View item' } : null,
        reason,
        unsubscribeUrl,
      });
      const ok = await this.emailService.sendMail(email, subject, html, store.contactEmail ?? null, unsubscribeHeaders(unsubscribeUrl));
      await this.markDelivered(logId, ok);
      if (ok) sent++;
    }
    return sent;
  }

  // ── Win-back ─────────────────────────────────────────────────────────────

  async processWinBack(): Promise<{ notified: number }> {
    const enabled = await this.r.marketingAutomationSettingsModel.find({ 'winBack.enabled': true }).select('storeId').lean();
    let notified = 0;
    for (const row of enabled as any[]) {
      const storeId = String(row.storeId);
      try {
        if (!(await this.marketingAllowed(storeId))) continue;
        notified += await this.processWinBackForStore(storeId);
      } catch (e: any) {
        this.logger.error(`win-back for store ${storeId} failed: ${e?.message}`);
      }
    }
    return { notified };
  }

  private async processWinBackForStore(storeId: string): Promise<number> {
    const [settings, store] = await Promise.all([this.getSettings(storeId), this.loadStore(storeId)]);
    if (!store || !settings.winBack.enabled) return 0;
    const cutoff = new Date(Date.now() - settings.winBack.afterDays * 86_400_000);

    const lapsed: { _id: string; lastOrderAt: Date }[] = await this.r.orderModel.aggregate([
      { $match: { 'sellerOrders.storeId': storeId, isDelete: false } },
      { $group: { _id: '$userId', lastOrderAt: { $max: '$createdAt' } } },
      { $match: { lastOrderAt: { $lt: cutoff } } },
      { $sort: { lastOrderAt: -1 } },
      { $limit: BATCH },
    ]);
    if (lapsed.length === 0) return 0;

    const lapsedIds = lapsed.map((l) => String(l._id)).filter((id) => isValidObjectId(id));
    const users = await this.r.userModel.find({ _id: { $in: lapsedIds }, isDelete: { $ne: true } }).select('name email').lean();
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    const subs = await this.activeSubscribers(storeId, users.map((u: any) => normalizeEmail(u.email)));
    const shopUrl = storePublicUrl(store);
    let sent = 0;

    for (const l of lapsed) {
      const u: any = userById.get(String(l._id));
      if (!u) continue;
      const email = normalizeEmail(u.email);
      const token = subs.get(email);
      if (!token) continue;
      // One win-back per lapse: keyed on the order they lapsed after, so a
      // customer who comes back and lapses again gets a fresh one.
      const logId = await this.claim(storeId, 'win_back', email, `last:${new Date(l.lastOrderAt).toISOString()}`);
      if (!logId) continue;
      const vars = { customerName: u.name || 'there', storeName: store.name };
      const unsubscribeUrl = newsletterUnsubscribeUrl(token);
      const subject = renderMergeTags(settings.winBack.subject, vars);
      const reason = `You're receiving this because you subscribed to emails from ${store.name}.`;
      const html = this.renderDesigned(
        settings.winBack.html,
        { ...vars, shopUrl: shopUrl ?? '', discountCode: settings.winBack.discountCode ?? '' },
        {},
        reason,
        unsubscribeUrl,
      ) ?? renderMarketingEmail({
        senderName: store.name,
        heading: subject,
        bodyHtml: textToHtml(renderMergeTags(settings.winBack.message, vars)),
        extraHtml: settings.winBack.discountCode ? discountCodeHtml(settings.winBack.discountCode) : '',
        cta: shopUrl ? { url: shopUrl, label: 'Shop now' } : null,
        reason,
        unsubscribeUrl,
      });
      const ok = await this.emailService.sendMail(email, subject, html, store.contactEmail ?? null, unsubscribeHeaders(unsubscribeUrl));
      await this.markDelivered(logId, ok);
      if (ok) sent++;
    }
    return sent;
  }
}
