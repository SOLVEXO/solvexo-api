/**
 * Geo-personalized background photo for Register/Login/Onboarding
 * (`AuthSplitLayout`, shared by every auth screen). A visitor's IP-detected
 * country (`resolveCountryFromIp`) resolves to one of 8 broad regions —
 * matching real-world geo-personalization practice: big platforms build a
 * handful of region-level visuals for their real markets plus one universal
 * default, never one photo per country. Every photo is a real, licensed
 * (Unsplash free license) photograph, manually curated for this project.
 */

export type AuthVisualRegion =
  | 'south_asia'
  | 'middle_east'
  | 'europe'
  | 'north_america'
  | 'east_asia'
  | 'southeast_asia'
  | 'africa'
  | 'latin_america'
  | 'default';

/** ISO-3166 alpha-2 → region. Anything not listed here (or a null/undetected
 *  country) falls through to `'default'` — never a hard error. */
export const COUNTRY_TO_AUTH_REGION: Record<string, AuthVisualRegion> = {
  // South Asia
  PK: 'south_asia', IN: 'south_asia', BD: 'south_asia', LK: 'south_asia',
  NP: 'south_asia', BT: 'south_asia', MV: 'south_asia', AF: 'south_asia',

  // Middle East
  AE: 'middle_east', SA: 'middle_east', QA: 'middle_east', KW: 'middle_east',
  BH: 'middle_east', OM: 'middle_east', IQ: 'middle_east', IR: 'middle_east',
  IL: 'middle_east', JO: 'middle_east', LB: 'middle_east', SY: 'middle_east',
  YE: 'middle_east', TR: 'middle_east', PS: 'middle_east',

  // Europe
  GB: 'europe', IE: 'europe', FR: 'europe', DE: 'europe', ES: 'europe',
  PT: 'europe', IT: 'europe', NL: 'europe', BE: 'europe', LU: 'europe',
  CH: 'europe', AT: 'europe', SE: 'europe', NO: 'europe', DK: 'europe',
  FI: 'europe', IS: 'europe', PL: 'europe', CZ: 'europe', SK: 'europe',
  HU: 'europe', RO: 'europe', BG: 'europe', GR: 'europe', HR: 'europe',
  SI: 'europe', RS: 'europe', UA: 'europe', BY: 'europe', LT: 'europe',
  LV: 'europe', EE: 'europe', MT: 'europe', CY: 'europe',

  // North America
  US: 'north_america', CA: 'north_america',

  // East Asia
  CN: 'east_asia', JP: 'east_asia', KR: 'east_asia', TW: 'east_asia',
  HK: 'east_asia', MO: 'east_asia', MN: 'east_asia',

  // Southeast Asia
  SG: 'southeast_asia', MY: 'southeast_asia', TH: 'southeast_asia',
  ID: 'southeast_asia', PH: 'southeast_asia', VN: 'southeast_asia',
  MM: 'southeast_asia', KH: 'southeast_asia', LA: 'southeast_asia',
  BN: 'southeast_asia',

  // Africa
  EG: 'africa', MA: 'africa', DZ: 'africa', TN: 'africa', LY: 'africa',
  NG: 'africa', KE: 'africa', ZA: 'africa', GH: 'africa', ET: 'africa',
  TZ: 'africa', UG: 'africa', SN: 'africa', CI: 'africa', CM: 'africa',

  // Latin America
  MX: 'latin_america', BR: 'latin_america', AR: 'latin_america',
  CO: 'latin_america', CL: 'latin_america', PE: 'latin_america',
  VE: 'latin_america', EC: 'latin_america', BO: 'latin_america',
  PY: 'latin_america', UY: 'latin_america', CR: 'latin_america',
  PA: 'latin_america', DO: 'latin_america', GT: 'latin_america',
};

/** Stable, real Unsplash CDN URLs (no API key needed to keep loading —
 *  the key was only used once, at curation time, to search/select these). */
export const AUTH_REGION_IMAGE_URL: Record<AuthVisualRegion, string> = {
  south_asia:     'https://images.unsplash.com/photo-1674502754814-de8b0acb7e22?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  middle_east:    'https://images.unsplash.com/photo-1634007626524-f47fa37810a7?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  europe:         'https://images.unsplash.com/photo-1609971757431-439cf7b4141b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  north_america:  'https://images.unsplash.com/photo-1511881830150-850572962174?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  east_asia:      'https://images.unsplash.com/photo-1602646993760-7b885ba225af?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  southeast_asia: 'https://images.unsplash.com/photo-1628221680019-f28a2716e727?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  africa:         'https://images.unsplash.com/photo-1570133435536-7ececf000ef6?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  latin_america:  'https://images.unsplash.com/photo-1651463378028-60bc2b22ba7b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  default:        'https://images.unsplash.com/photo-1670121180530-cfcba4438038?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
};

export function resolveAuthVisualRegion(country: string | null): AuthVisualRegion {
  if (!country) return 'default';
  return COUNTRY_TO_AUTH_REGION[country] ?? 'default';
}
