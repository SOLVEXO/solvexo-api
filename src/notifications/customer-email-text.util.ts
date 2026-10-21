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
 * The subject + message template a customer email is rendered from, per field. `sourceLanguage` is the language the
 * store is written in (default 'en'); the seller's own "base" text (`settings.events`) is in THAT language.
 *   Buyer in the store's own language: the seller's base text, else the built-in text for that language, else the English default.
 *   Buyer in another language: the seller's translation, else (not English) the seller's base text, else the built-in text
 *   for that language, else the English default. English buyers of a non-English store never get the seller's base text.
 * `draft` (the seller's unsaved text in the editor) takes the place of the saved text of THIS language.
 */
export function pickEmailText(
  event: CustomerEmailEvent,
  locale: string | null | undefined,
  settings: any,
  draft?: { subject?: string | null; body?: string | null },
  sourceLanguage: string | null | undefined = 'en',
): { subject: string; body: string; locale: string } {
  const def = CUSTOMER_EMAIL_CATALOG[event];
  const lang = baseLocale(locale);
  const source = baseLocale(sourceLanguage);
  const isSource = lang === source;
  const base = settings?.events?.[event] ?? {};
  const translated = isSource ? {} : settings?.eventTranslations?.[event]?.[lang] ?? {};
  const builtIn = lang === 'en' ? undefined : CUSTOMER_EMAIL_DEFAULTS_BY_LOCALE[lang]?.[event];

  const field = (name: 'subject' | 'body', defaultText: string): string => {
    // An unsaved editor value (even an emptied one) replaces the saved text of THIS language; empty = "use the default".
    const hasDraft = draft?.[name] !== undefined;
    const mine = hasDraft ? clean(draft![name]) : isSource ? clean(base[name]) : clean(translated[name]);
    if (mine) return mine;
    if (isSource) return builtIn?.[name] || defaultText;
    return (lang === 'en' ? '' : clean(base[name])) || builtIn?.[name] || defaultText;
  };

  return { subject: field('subject', def.defaultSubject), body: field('body', def.defaultBody), locale: lang };
}
