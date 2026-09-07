/**
 * Geo-personalized background photo for Register/Login/Onboarding
 * (`AuthSplitLayout`, shared by every auth screen). A visitor's IP-detected
 * country (`resolveCountryFromIp`) resolves to one of 8 broad regions —
 * matching real-world geo-personalization practice: big platforms build a
 * handful of region-level visuals for their real markets plus one universal
 * default, never one photo per country. Every photo is a real, licensed
 * (Unsplash free license) photograph, manually curated for this project.
 *
 * Each region also has 3 distinct photos, one per `AuthPageContext` — so a
 * visitor sees a genuinely different (but same-region) photo depending on
 * whether they're on Register, Login, or Onboarding, instead of the exact
 * same image everywhere. These are NOT meant to visually depict "someone
 * registering" vs "someone logging in" (real stock photography has no such
 * literal distinction — every candidate for that search is indistinguishable
 * "person looking at a phone"); they're simply 3 different real, high-quality
 * photos of that region, so the 3 screens don't feel identical.
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

export type AuthPageContext = 'register' | 'login' | 'onboarding';

export const AUTH_PAGE_CONTEXTS: AuthPageContext[] = ['register', 'login', 'onboarding'];

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

/** Stable, real Unsplash CDN URLs (no API key needed to keep loading — the
 *  key was only used once, at curation time, to search/select these). Each
 *  region has 3 distinct photos, keyed by `AuthPageContext`. */
export const AUTH_REGION_IMAGE_URL: Record<AuthVisualRegion, Record<AuthPageContext, string>> = {
  south_asia: {
    register:   'https://images.unsplash.com/photo-1674502754814-de8b0acb7e22?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1706043197156-eb4b075b3108?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1658073404255-5c1da0f13f75?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
  middle_east: {
    register:   'https://images.unsplash.com/photo-1634007626524-f47fa37810a7?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1543579596-2c11997c7706?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1526495124232-a04e1849168c?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
  europe: {
    register:   'https://images.unsplash.com/photo-1609971757431-439cf7b4141b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1539424675410-513ddd709ebd?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1547254002-e65e0179fe9f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
  north_america: {
    register:   'https://images.unsplash.com/photo-1511881830150-850572962174?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1541336032412-2048a678540d?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1719858403455-9a2582eca805?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
  east_asia: {
    register:   'https://images.unsplash.com/photo-1602646993760-7b885ba225af?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1573455494057-12684d151bf4?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1596713109885-c94bdfd7f19d?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
  southeast_asia: {
    register:   'https://images.unsplash.com/photo-1628221680019-f28a2716e727?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1631670796270-72ca29fe0c9b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1692533823876-e659c090a4ce?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
  africa: {
    register:   'https://images.unsplash.com/photo-1570133435536-7ececf000ef6?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1529528070131-eda9f3e90919?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1559738933-d69ac3ff674b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
  latin_america: {
    register:   'https://images.unsplash.com/photo-1654086441559-f2e71be7f050?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1651463378028-60bc2b22ba7b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1701397165417-f1db85c8b85f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
  default: {
    // Was a container-ship/crane photo — genuinely read as "industrial
    // shipping yard," not "buyers and sellers marketplace" (a real,
    // confirmed-by-eye critique of Solvexo's own brand fit, not a stock-
    // photo-quality issue). A warm, colorful street-market scene actually
    // represents "commerce" the way this brand means it.
    register:   'https://images.unsplash.com/photo-1759542288517-1160b5adfcf9?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    login:      'https://images.unsplash.com/photo-1631897362327-4842446b5c51?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
    onboarding: 'https://images.unsplash.com/photo-1775883374751-d8157965021b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&q=80&w=1200',
  },
};

export function resolveAuthVisualRegion(country: string | null): AuthVisualRegion {
  if (!country) return 'default';
  return COUNTRY_TO_AUTH_REGION[country] ?? 'default';
}

export function resolveAuthVisualImageUrl(region: AuthVisualRegion, context: string | undefined): string {
  const ctx: AuthPageContext = AUTH_PAGE_CONTEXTS.includes(context as AuthPageContext) ? (context as AuthPageContext) : 'register';
  return AUTH_REGION_IMAGE_URL[region][ctx];
}
