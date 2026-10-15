/* eslint-disable prettier/prettier */
import { CUSTOMER_EMAIL_CATALOG, type CustomerEmailEvent } from './customer-email-events';
import { CUSTOMER_EMAIL_DEFAULTS_BY_LOCALE } from './customer-email-locales';

/** 'ur-PK' -> 'ur'; anything that is not a short language code -> 'en'. */
export function baseLocale(locale: string | null | undefined): string {
  const v = String(locale ?? '').trim().toLowerCase().split('-')[0];
  return /^[a-z]{2,3}$/.test(v) ? v : 'en';
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The subject + message template a customer email is rendered from, per field, in this order:
 *   1. the seller's own translation for the buyer's language (`eventTranslations[event][lang]`),
 *   2. the seller's own English text (their store language is the fallback — never silently replaced by ours),
 *   3. the built-in text for that language (`customer-email-locales.ts`),
 *   4. the built-in English default.
 * English buyers skip 1 and 3. `draft` (the seller's unsaved text in the editor) takes the place of 1 (or of the
 * English text for English).
 */
export function pickEmailText(
  event: CustomerEmailEvent,
  locale: string | null | undefined,
  settings: any,
  draft?: { subject?: string | null; body?: string | null },
): { subject: string; body: string; locale: string } {
  const def = CUSTOMER_EMAIL_CATALOG[event];
  const lang = baseLocale(locale);
  const english = settings?.events?.[event] ?? {};
  const translated = lang === 'en' ? {} : settings?.eventTranslations?.[event]?.[lang] ?? {};
  const builtIn = lang === 'en' ? undefined : CUSTOMER_EMAIL_DEFAULTS_BY_LOCALE[lang]?.[event];

  const field = (name: 'subject' | 'body', defaultText: string): string => {
    // An unsaved editor value (even an emptied one) replaces the saved text of THIS language; empty = "use the default".
    const hasDraft = draft?.[name] !== undefined;
    const mine = hasDraft ? clean(draft![name]) : lang === 'en' ? clean(english[name]) : clean(translated[name]);
    if (mine) return mine;
    if (lang === 'en') return defaultText;
    return clean(english[name]) || builtIn?.[name] || defaultText;
  };

  return { subject: field('subject', def.defaultSubject), body: field('body', def.defaultBody), locale: lang };
}
