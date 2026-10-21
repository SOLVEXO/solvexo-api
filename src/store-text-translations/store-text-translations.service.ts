/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { isValidObjectId, Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { normalizeLocale } from '@/markets/market-price.util';
import { TextGenerationService } from '@/ai-studio/providers/text-generation.service';
import {
  collectBlogBodyItems, collectChromeBlockItems, collectFieldItems, collectSectionItems, isUiTextKey, isValidTextKey, MAX_TEXT_LENGTH,
  type TextSourceGroup, type TextSourceItem,
} from './text-sources.util';

const MAX_AUTO_CHARS = 20000;

@Injectable()
export class StoreTextTranslationsService {
  private readonly logger = new Logger(StoreTextTranslationsService.name);

  constructor(private readonly db: DatabaseService, private readonly ai: TextGenerationService) {}

  private get r() {
    return this.db.repositories as any;
  }

  /** The store's own (source) language; it is never a translation target. */
  async defaultLanguage(storeId: string): Promise<string> {
    const store: any = await this.r.storeModel.findById(storeId).select('defaultLanguage').lean();
    return String(store?.defaultLanguage || 'en').toLowerCase();
  }

  async targetLocale(storeId: string, raw: string): Promise<string> {
    const locale = normalizeLocale(raw);
    if (!locale || locale === (await this.defaultLanguage(storeId))) throw new BadRequestException(`"${raw}" is not a language you can translate into`);
    return locale;
  }

  /** Every piece of storefront text the seller can translate, grouped by where it appears. */
  async sources(sellerId: string, storeId: string, scope?: string): Promise<{ groups: TextSourceGroup[] }> {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (scope) return { groups: await this.collectScopedGroups(storeId, scope) };
    return { groups: await this.collectGroups(storeId) };
  }

  /** The body text of ONE blog post (`bp:<postId>`); posts are translated one at a time from the Blog posts tab. */
  private async collectScopedGroups(storeId: string, scope: string): Promise<TextSourceGroup[]> {
    const m = /^bp:([A-Za-z0-9_-]{1,40})$/.exec(scope);
    if (!m || !isValidObjectId(m[1])) throw new BadRequestException('Unknown scope');
    const post: any = await this.r.blogPostModel.findOne({ _id: m[1], storeId, isDelete: false }).select('title content').lean();
    if (!post) throw new NotFoundException('Post not found');
    const items = collectBlogBodyItems(String(post._id), post.content);
    return items.length ? [{ id: scope, title: post.title, kind: 'blog_post', items }] : [];
  }

  async collectGroups(storeId: string): Promise<TextSourceGroup[]> {
    const r = this.r;
    const [store, pages, templates, theme, faqs, categories, zones, payMethods]: any[] = await Promise.all([
      r.storeModel.findById(storeId).select('name tagline description announcementBar').lean(),
      r.storePageModel.find({ storeId, isDelete: false, status: 'published' }).select('title type slug sections').sort({ type: 1, title: 1 }).lean(),
      r.collectionTemplateModel.find({ storeId, isDelete: { $ne: true } }).select('type name resourceId sections').sort({ type: 1, name: 1 }).lean(),
      r.storeThemeModel.findOne({ storeId, status: 'active' }).select('header footer').lean(),
      r.storeFaqModel.find({ storeId }).sort({ order: 1 }).select('question answer').lean(),
      r.categoryModel.find({ storeId, isDelete: false }).sort({ sortOrder: 1, name: 1 }).limit(300).select('name description').lean(),
      r.shippingZoneModel.find({ storeId: isValidObjectId(storeId) ? { $in: [storeId, new Types.ObjectId(storeId)] } : storeId, isDelete: { $ne: true } }).sort({ country: 1, name: 1 }).limit(300).select('name regionName country province zoneType pickupInstructions').lean(),
      r.manualPaymentMethodModel.find({ storeId, isDelete: false }).sort({ sortOrder: 1 }).limit(100).select('name instructions').lean(),
    ]);

    const groups: TextSourceGroup[] = [];
    const push = (id: string, title: string, kind: string, items: TextSourceItem[]) => { if (items.length) groups.push({ id, title, kind, items }); };

    push('store', 'Store details', 'store', collectFieldItems('store', store, [['name', 'Store name'], ['tagline', 'Tagline'], ['description', 'Description']]));

    const bar = store?.announcementBar;
    if (bar) {
      const items = collectFieldItems('announcement', bar, [['message', 'Message'], ['ctaLabel', 'Button text']]);
      (bar.moreMessages ?? []).forEach((m: any, i: number) => {
        items.push(...collectFieldItems('announcement', { [`moreMessages.${i}.message`]: m?.message, [`moreMessages.${i}.ctaLabel`]: m?.ctaLabel },
          [[`moreMessages.${i}.message`, `Message ${i + 2}`], [`moreMessages.${i}.ctaLabel`, `Message ${i + 2} · Button text`]]));
      });
      push('announcement', 'Announcement bar', 'announcement', items);
    }

    const header = theme?.header;
    push('header', 'Header', 'header', [
      ...collectFieldItems('header', header, [['ctaLabel', 'Button text'], ['shopMenuLabel', 'Shop menu label'], ['blogLinkLabel', 'Blog link label'], ['topBarText', 'Top bar text']]),
      ...collectChromeBlockItems('hb', header?.blocks),
      ...collectSectionItems(header?.sections),
    ]);
    const footer = theme?.footer;
    push('footer', 'Footer', 'footer', [
      ...collectFieldItems('footer', footer, [['newsletterHeading', 'Newsletter heading'], ['newsletterText', 'Newsletter text'], ['shopColumnHeading', 'Shop column title'], ['accountColumnHeading', 'Account column title'], ['blogLinkLabel', 'Blog link label']]),
      ...collectChromeBlockItems('fb', footer?.blocks),
      ...collectSectionItems(footer?.sections),
    ]);

    for (const page of pages) {
      push(`page:${page._id}`, page.type === 'home' ? 'Home page' : `Page · ${page.title}`, 'page', collectSectionItems(page.sections));
    }
    for (const t of templates) {
      push(`template:${t._id}`, `Template · ${t.type}${t.name && t.name !== 'Default' ? ` · ${t.name}` : ''}`, 'template', collectSectionItems(t.sections));
    }

    const faqItems: TextSourceItem[] = [];
    faqs.forEach((f: any, i: number) => {
      faqItems.push(...collectFieldItems(`faq:${f._id}`, f, [['question', `Question ${i + 1}`], ['answer', `Answer ${i + 1}`]]));
    });
    push('faqs', 'FAQs', 'faq', faqItems);

    const categoryItems: TextSourceItem[] = [];
    categories.forEach((c: any) => {
      categoryItems.push(...collectFieldItems(`cat:${c._id}`, c, [['name', `${c.name} · Name`], ['description', `${c.name} · Description`]]));
    });
    push('categories', 'Categories', 'category', categoryItems);

    // What a buyer reads at checkout: delivery options and the store's own payment methods.
    const checkoutItems: TextSourceItem[] = [];
    zones.forEach((z: any) => {
      const where = [z.country, z.province].filter(Boolean).join(' / ');
      const title = z.name || z.regionName || where || 'Delivery option';
      checkoutItems.push(...collectFieldItems(`ship:${z._id}`, z, [['name', `Delivery · ${where} · Name`], ['regionName', `Delivery · ${title} · Region`], ['pickupInstructions', `Delivery · ${title} · Pickup instructions`]]));
    });
    payMethods.forEach((m: any) => {
      checkoutItems.push(...collectFieldItems(`pay:${m._id}`, m, [['name', `Payment · ${m.name} · Name`], ['instructions', `Payment · ${m.name} · Instructions`]]));
    });
    push('checkout', 'Checkout: delivery and payment options', 'checkout', checkoutItems);
    return groups;
  }

  /** Saved translations of one language, as the editor shows them. */
  async list(sellerId: string, storeId: string, rawLocale: string) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const locale = normalizeLocale(rawLocale);
    if (locale && locale === (await this.defaultLanguage(storeId))) return { strings: this.onlyUi(await this.strings(storeId, locale)) };
    return { strings: await this.strings(storeId, await this.targetLocale(storeId, rawLocale)) };
  }

  private onlyUi(all: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(all).filter(([k]) => isUiTextKey(k)));
  }

  /** key → translated text (what the storefront overlays). */
  async strings(storeId: string, locale: string): Promise<Record<string, string>> {
    const rows: any[] = await this.r.storeTextTranslationModel.find({ storeId, locale }).select('key value').lean();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  async publicStrings(storeId: string, rawLocale: string): Promise<Record<string, string>> {
    const locale = normalizeLocale(rawLocale);
    if (!locale) return {};
    const all = await this.strings(storeId, locale);
    // In the store's own language only the seller's wording of built-in labels applies (there is nothing to translate).
    return locale === (await this.defaultLanguage(storeId)) ? this.onlyUi(all) : all;
  }

  async save(sellerId: string, storeId: string, rawLocale: string, entries: { key: string; value: string }[]) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    // Built-in button / label wording can be customised in any language, the store's own included; everything else only in translations.
    const uiOnly = entries.length > 0 && entries.every((e) => isUiTextKey(e.key));
    const asked = normalizeLocale(rawLocale);
    const locale = uiOnly && asked ? asked : await this.targetLocale(storeId, rawLocale);
    const ops: any[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if (!isValidTextKey(e.key)) throw new BadRequestException(`"${e.key}" is not translatable text`);
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      const value = String(e.value ?? '').replace(/\u0000/g, '').trim();
      if (value.length > MAX_TEXT_LENGTH) throw new BadRequestException('A translation is too long');
      ops.push(value
        ? { updateOne: { filter: { storeId, locale, key: e.key }, update: { $set: { value } }, upsert: true } }
        : { deleteOne: { filter: { storeId, locale, key: e.key } } });
    }
    if (ops.length) await this.r.storeTextTranslationModel.bulkWrite(ops, { ordered: false });
    return { strings: await this.strings(storeId, locale) };
  }

  /**
   * Machine-translates the given source texts into `locale` and RETURNS them for the seller to review (nothing is saved).
   * HTML tags, {{placeholders}}, numbers and brand names are kept as they are.
   */
  async autoTranslate(sellerId: string, storeId: string, rawLocale: string, keys: string[]) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const locale = await this.targetLocale(storeId, rawLocale);
    if (this.ai.providerName !== 'claude') {
      throw new ServiceUnavailableException('Automatic translation is not switched on for this platform yet. You can still translate by hand.');
    }
    const wanted = new Set(keys);
    const postIds = [...new Set(keys.map((k) => /^bp:([A-Za-z0-9_-]+)#/.exec(k)?.[1]).filter(Boolean))] as string[];
    const groups = [...(await this.collectGroups(storeId)), ...(await Promise.all(postIds.map((id) => this.collectScopedGroups(storeId, `bp:${id}`)))).flat()];
    const items = groups.flatMap((g) => g.items).filter((i) => wanted.has(i.key));
    if (!items.length) return { translations: {} as Record<string, string> };
    if (items.reduce((n, i) => n + i.source.length, 0) > MAX_AUTO_CHARS) throw new BadRequestException('Translate fewer items at once');

    let language = locale;
    try { language = new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale; } catch { /* keep the code */ }
    const schema = {
      type: 'object',
      properties: { translations: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'], additionalProperties: false } } },
      required: ['translations'], additionalProperties: false,
    };
    const result = await this.ai.generate({
      tier: 'standard',
      maxTokens: 4000,
      schema,
      system: `You translate ecommerce storefront text into ${language}. Keep HTML tags and attributes, {{placeholders}}, numbers, currency amounts, URLs, brand and product names exactly as they are. Keep the tone and length natural for a shop. Return only the JSON.`,
      prompt: `Translate each "text" into ${language}. Return {"translations":[{"key":..., "value":...}]} with the same keys.\n${JSON.stringify(items.map((i) => ({ key: i.key, text: i.source })))}`,
    }).catch((err: unknown) => {
      this.logger.warn(`auto-translate failed: ${err instanceof Error ? err.message : err}`);
      throw new ServiceUnavailableException('The translation service is busy. Try again in a moment.');
    });

    const allowed = new Set(items.map((i) => i.key));
    const out: Record<string, string> = {};
    for (const t of (result.json?.translations ?? []) as { key: string; value: string }[]) {
      if (allowed.has(t?.key) && typeof t.value === 'string' && t.value.trim()) out[t.key] = t.value.trim().slice(0, MAX_TEXT_LENGTH);
    }
    return { translations: out };
  }
}
