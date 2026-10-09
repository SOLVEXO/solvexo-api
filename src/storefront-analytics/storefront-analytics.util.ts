/* eslint-disable prettier/prettier */

/** Crawlers, link previews and headless tools are not visitors (Shopify excludes bot traffic from sessions). */
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios|node-fetch|postman/i;

export function isBotUserAgent(ua: string | undefined | null): boolean {
  return !ua || BOT_UA.test(ua);
}

export function deviceTypeFromUserAgent(ua: string | undefined | null): 'desktop' | 'mobile' | 'tablet' {
  const s = ua ?? '';
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(s)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|BlackBerry|IEMobile|Opera Mini/i.test(s)) return 'mobile';
  return 'desktop';
}

const SEARCH_HOSTS = /(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|naver|ask)\./i;
const SOCIAL_HOSTS = /(^|\.)(facebook|fb|instagram|twitter|x|t|linkedin|lnkd|pinterest|pin|tiktok|youtube|youtu|reddit|whatsapp|wa|snapchat|telegram|threads)\.(com|me|co|net|it|be|org)$/i;
const EMAIL_HOSTS = /(^|\.)(mail\.google|outlook\.live|mail\.yahoo|mail\.proton)\./i;

export type TrafficSource = 'direct' | 'search' | 'social' | 'email' | 'paid' | 'referral';

/**
 * Shopify-style traffic type of a visit from its first page: UTM medium wins (paid/email/social), then the
 * referring site's kind; no external referrer = direct. `ownHosts` are the store's own hosts (internal, not a source).
 */
export function classifyTrafficSource(input: { referrerHost?: string | null; utmMedium?: string | null; utmSource?: string | null }): TrafficSource {
  const medium = (input.utmMedium ?? '').toLowerCase();
  if (/^(cpc|ppc|paid|paidsocial|paid_social|display|ads?|cpm|retargeting)$/.test(medium)) return 'paid';
  if (medium === 'email' || medium === 'newsletter') return 'email';
  if (medium === 'social' || medium === 'social-media') return 'social';
  const host = (input.referrerHost ?? '').toLowerCase();
  if (!host) return input.utmSource ? 'referral' : 'direct';
  if (EMAIL_HOSTS.test(host)) return 'email';
  if (SEARCH_HOSTS.test(host)) return 'search';
  if (SOCIAL_HOSTS.test(host)) return 'social';
  return 'referral';
}

/** Host of a referrer URL, or null when missing/invalid or one of the store's own hosts (an internal navigation). */
export function externalReferrerHost(referrer: string | undefined | null, ownHosts: string[]): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    if (!host || ownHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
    return host.slice(0, 120);
  } catch {
    return null;
  }
}

/** Path only (no query/hash), bounded — never stores query strings (they can carry personal data). */
export function cleanPath(path: string | undefined | null): string {
  const p = String(path ?? '/').split(/[?#]/)[0] || '/';
  return (p.startsWith('/') ? p : `/${p}`).slice(0, 200);
}

/**
 * Approximate country from the browser time zone — used only when no CDN geo header is present. Zones shared by
 * several countries are left out (better "unknown" than wrong).
 */
const ZONE_COUNTRY: Record<string, string> = {
  'Asia/Karachi': 'PK', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dhaka': 'BD', 'Asia/Colombo': 'LK', 'Asia/Kathmandu': 'NP',
  'Asia/Kabul': 'AF', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Qatar': 'QA', 'Asia/Kuwait': 'KW', 'Asia/Bahrain': 'BH',
  'Asia/Muscat': 'OM', 'Europe/Istanbul': 'TR', 'Africa/Cairo': 'EG', 'Asia/Amman': 'JO', 'Asia/Kuala_Lumpur': 'MY',
  'Asia/Singapore': 'SG', 'Asia/Shanghai': 'CN', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Hong_Kong': 'HK',
  'Asia/Bangkok': 'TH', 'Asia/Manila': 'PH', 'Asia/Jakarta': 'ID', 'Europe/London': 'GB', 'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Rome': 'IT', 'Europe/Madrid': 'ES', 'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
  'Africa/Johannesburg': 'ZA', 'Pacific/Auckland': 'NZ', 'America/New_York': 'US', 'America/Chicago': 'US',
  'America/Denver': 'US', 'America/Phoenix': 'US', 'America/Los_Angeles': 'US', 'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU', 'America/Sao_Paulo': 'BR',
  'America/Mexico_City': 'MX',
};

export function countryFromSignals(geoHeader: string | undefined | null, browserTimeZone: string | undefined | null): string | null {
  const geo = String(geoHeader ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(geo) && geo !== 'XX' && geo !== 'T1') return geo;
  return browserTimeZone ? ZONE_COUNTRY[browserTimeZone] ?? null : null;
}
