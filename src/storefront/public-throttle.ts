/**
 * Rate limit for anonymous storefront READS (store, theme, pages, collections, products, markets). One page load fires a
 * dozen of these and many visitors share one IP (offices, mobile carriers), so the platform-wide 100 requests per minute per
 * IP would block real shoppers. Writes, login, payment and every authenticated route keep their own, tighter limits.
 */
export const PUBLIC_BROWSE_LIMIT = { default: { limit: 300, ttl: 60_000 } };
