/* eslint-disable prettier/prettier */
import { normalizeLocale } from '@/markets/market-price.util';

/**
 * A storefront URL in another language may carry the TRANSLATED handle (`/ur/product/<translated-handle>`). The page's own
 * slug always keeps working; this is the extra clause that also matches the handle saved in Translate & adapt.
 * `locale` comes from the storefront's `?locale=` query; anything that is not a short language code is ignored.
 */
export function translatedHandleClause(locale: unknown, handle: string): Record<string, string> | null {
  const code = normalizeLocale(locale);
  return code ? { [`translations.${code}.handle`]: handle } : null;
}
