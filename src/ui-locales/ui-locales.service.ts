/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { TextGenerationService } from '@/ai-studio/providers/text-generation.service';
import { LANGUAGE_NAMES, isSupportedLanguage } from '@/common/supported-languages.const';
import { STOREFRONT_EN } from './storefront-en.source';
import { chunk, flattenStrings, keepsPlaceholders, STATIC_UI_LOCALES, unflattenStrings, type FlatStrings } from './ui-locales.util';

const BATCH = 80;
/** A run that has not finished after this long is treated as dead and may be restarted. */
const STALE_MS = 15 * 60_000;
/** A bundle with fewer translated keys than this share is not served (English is better than a half-empty file). */
const MIN_COVERAGE = 0.97;

export type UiLocaleResult =
  | { status: 'static' | 'unavailable' | 'generating' | 'failed' }
  | { status: 'ready'; strings: Record<string, any> };

@Injectable()
export class UiLocalesService {
  private readonly logger = new Logger(UiLocalesService.name);
  private readonly running = new Set<string>();

  constructor(private readonly db: DatabaseService, private readonly ai: TextGenerationService) {}

  private get model() {
    return (this.db.repositories as any).uiLocaleBundleModel;
  }

  /** The bundle of one language; starts generating it the first time it is asked for (when the translator is switched on). */
  async get(rawLocale: string): Promise<UiLocaleResult> {
    const locale = String(rawLocale ?? '').toLowerCase();
    if (!isSupportedLanguage(locale)) return { status: 'unavailable' };
    if (STATIC_UI_LOCALES.includes(locale)) return { status: 'static' };

    const row: any = await this.model.findOne({ locale }).lean();
    if (row?.status === 'ready' && row.strings) return { status: 'ready', strings: row.strings };
    if (row?.status === 'generating' && row.generatingSince && Date.now() - new Date(row.generatingSince).getTime() < STALE_MS) return { status: 'generating' };
    if (row?.status === 'failed' && row.updatedAt && Date.now() - new Date(row.updatedAt).getTime() < 60 * 60_000) return { status: 'failed' };
    if (this.ai.providerName !== 'claude') return { status: 'unavailable' };

    void this.generate(locale);
    return { status: 'generating' };
  }

  /** Translates the English bundle in batches and stores it. Safe to call twice: only one run per language per process. */
  async generate(locale: string): Promise<void> {
    if (this.running.has(locale)) return;
    this.running.add(locale);
    try {
      await this.model.updateOne({ locale }, { $set: { status: 'generating', generatingSince: new Date(), error: null } }, { upsert: true });
      const source = flattenStrings(STOREFRONT_EN);
      const keys = Object.keys(source);
      const translated: FlatStrings = {};
      const language = LANGUAGE_NAMES[locale] ?? locale;
      for (const batch of chunk(keys, BATCH)) {
        const got = await this.translateBatch(language, batch.map((k) => ({ key: k, text: source[k] })));
        for (const key of batch) {
          const value = got[key];
          if (typeof value === 'string' && value.trim() && keepsPlaceholders(source[key], value)) translated[key] = value.trim();
        }
      }
      const coverage = Object.keys(translated).length / keys.length;
      if (coverage < MIN_COVERAGE) throw new Error(`only ${Math.round(coverage * 100)}% of the text could be translated`);
      // Anything the translator skipped keeps its English text so no key is ever missing.
      const full: FlatStrings = { ...source, ...translated };
      await this.model.updateOne({ locale }, { $set: { status: 'ready', strings: unflattenStrings(full), keyCount: keys.length, generatingSince: null, error: null } });
      this.logger.log(`UI bundle "${locale}" generated (${Math.round(coverage * 100)}% translated)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`UI bundle "${locale}" failed: ${message}`);
      await this.model.updateOne({ locale }, { $set: { status: 'failed', generatingSince: null, error: message.slice(0, 300) } }, { upsert: true }).catch(() => undefined);
    } finally {
      this.running.delete(locale);
    }
  }

  private async translateBatch(language: string, items: { key: string; text: string }[]): Promise<Record<string, string>> {
    const schema = {
      type: 'object',
      properties: { translations: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'], additionalProperties: false } } },
      required: ['translations'], additionalProperties: false,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.ai.generate({
          tier: 'standard',
          maxTokens: 8000,
          schema,
          system: `You translate the buttons, labels and messages of an online store's storefront into ${language}. Keep every {{placeholder}} exactly as written, keep HTML tags, numbers and brand names. Use the short, natural wording a shop in that language uses (for example "Add to cart", "Checkout"). Return only the JSON.`,
          prompt: `Translate each "text" into ${language}. Return {"translations":[{"key":...,"value":...}]} with the same keys.\n${JSON.stringify(items)}`,
        });
        const out: Record<string, string> = {};
        for (const t of (res.json?.translations ?? []) as { key: string; value: string }[]) if (t?.key) out[t.key] = t.value;
        return out;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    return {};
  }

  /**
   * Labels added to the storefront after a language's bundle was made: translate just those keys once and keep them.
   * Only keys of the English bundle are accepted, so this cannot be used to translate arbitrary text.
   */
  async fill(rawLocale: string, keys: string[]): Promise<Record<string, string>> {
    const locale = String(rawLocale ?? '').toLowerCase();
    if (!isSupportedLanguage(locale) || locale === 'en') return {};
    const english = flattenStrings(STOREFRONT_EN);
    const wanted = [...new Set(keys)].filter((k) => typeof english[k] === 'string');
    if (!wanted.length) return {};

    const rows: any[] = await (this.db.repositories as any).uiLocaleKeyModel.find({ locale, key: { $in: wanted } }).select('key value').lean();
    const out: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const todo = wanted.filter((k) => !(k in out));
    if (todo.length && this.ai.providerName === 'claude') {
      const got = await this.translateBatch(LANGUAGE_NAMES[locale] ?? locale, todo.map((key) => ({ key, text: english[key] }))).catch(() => ({} as Record<string, string>));
      const ops: any[] = [];
      for (const key of todo) {
        const value = got[key];
        if (typeof value === 'string' && value.trim() && keepsPlaceholders(english[key], value)) {
          out[key] = value.trim();
          ops.push({ updateOne: { filter: { locale, key }, update: { $set: { value: value.trim() } }, upsert: true } });
        }
      }
      if (ops.length) await (this.db.repositories as any).uiLocaleKeyModel.bulkWrite(ops, { ordered: false }).catch(() => undefined);
    }
    return out;
  }

  /** Admin: throw the stored bundle away and translate again. */
  async regenerate(rawLocale: string): Promise<UiLocaleResult> {
    const locale = String(rawLocale ?? '').toLowerCase();
    if (!isSupportedLanguage(locale) || STATIC_UI_LOCALES.includes(locale)) return { status: 'unavailable' };
    if (this.ai.providerName !== 'claude') return { status: 'unavailable' };
    await this.model.deleteOne({ locale });
    void this.generate(locale);
    return { status: 'generating' };
  }
}
