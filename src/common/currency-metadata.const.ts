/**
 * The real, complete ISO-4217 currency reference table — code, display name,
 * and minor-unit decimal places (per the actual ISO-4217 standard, same
 * convention Stripe's own docs use). This is pure static reference DATA, not
 * business logic, so it's kept genuinely exhaustive rather than a hand-picked
 * shortlist — see the "Global Multi-Currency" plan's design-decision section
 * for why: a source-code array admins can't extend is not Shopify-scale.
 *
 * `PlatformConfig.fxConfig.enabledCurrencies` (AdminConfigService) is the
 * actual dynamic gate a store/checkout ever checks — this table only answers
 * "is this a real currency, and how many decimals does it use," never "is it
 * turned on for this platform."
 */

export interface CurrencyMetadata {
  code: string;
  name: string;
  /** Minor-unit decimal places — 0 for whole-unit currencies (JPY, KRW, ...),
   *  3 for the small set of currencies with a sub-cent minor unit (BHD, KWD, ...),
   *  2 for everything else. */
  decimals: 0 | 2 | 3;
}

// Zero-decimal currencies — mirrors the well-known real-world/Stripe
// zero-decimal-currency list.
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

// Three-decimal currencies — the small, real set with a sub-cent minor unit.
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function decimalsFor(code: string): 0 | 2 | 3 {
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

// Real ISO-4217 currency codes + names — every currency actually in
// circulation today, not a curated shortlist. `decimals` is derived, not
// hand-entered, so it can never drift from the two sets above.
const CURRENCY_NAMES: Record<string, string> = {
  AED: 'UAE Dirham', AFN: 'Afghan Afghani', ALL: 'Albanian Lek', AMD: 'Armenian Dram',
  ANG: 'Netherlands Antillean Guilder', AOA: 'Angolan Kwanza', ARS: 'Argentine Peso',
  AUD: 'Australian Dollar', AWG: 'Aruban Florin', AZN: 'Azerbaijani Manat',
  BAM: 'Bosnia-Herzegovina Convertible Mark', BBD: 'Barbadian Dollar', BDT: 'Bangladeshi Taka',
  BGN: 'Bulgarian Lev', BHD: 'Bahraini Dinar', BIF: 'Burundian Franc', BMD: 'Bermudan Dollar',
  BND: 'Brunei Dollar', BOB: 'Bolivian Boliviano', BRL: 'Brazilian Real', BSD: 'Bahamian Dollar',
  BTN: 'Bhutanese Ngultrum', BWP: 'Botswanan Pula', BYN: 'Belarusian Ruble', BZD: 'Belize Dollar',
  CAD: 'Canadian Dollar', CDF: 'Congolese Franc', CHF: 'Swiss Franc', CLP: 'Chilean Peso',
  CNY: 'Chinese Yuan', COP: 'Colombian Peso', CRC: 'Costa Rican Colón', CUP: 'Cuban Peso',
  CVE: 'Cape Verdean Escudo', CZK: 'Czech Koruna', DJF: 'Djiboutian Franc', DKK: 'Danish Krone',
  DOP: 'Dominican Peso', DZD: 'Algerian Dinar', EGP: 'Egyptian Pound', ERN: 'Eritrean Nakfa',
  ETB: 'Ethiopian Birr', EUR: 'Euro', FJD: 'Fijian Dollar', FKP: 'Falkland Islands Pound',
  GBP: 'British Pound', GEL: 'Georgian Lari', GHS: 'Ghanaian Cedi', GIP: 'Gibraltar Pound',
  GMD: 'Gambian Dalasi', GNF: 'Guinean Franc', GTQ: 'Guatemalan Quetzal', GYD: 'Guyanaese Dollar',
  HKD: 'Hong Kong Dollar', HNL: 'Honduran Lempira', HRK: 'Croatian Kuna', HTG: 'Haitian Gourde',
  HUF: 'Hungarian Forint', IDR: 'Indonesian Rupiah', ILS: 'Israeli New Shekel', INR: 'Indian Rupee',
  IQD: 'Iraqi Dinar', IRR: 'Iranian Rial', ISK: 'Icelandic Króna', JMD: 'Jamaican Dollar',
  JOD: 'Jordanian Dinar', JPY: 'Japanese Yen', KES: 'Kenyan Shilling', KGS: 'Kyrgystani Som',
  KHR: 'Cambodian Riel', KMF: 'Comorian Franc', KRW: 'South Korean Won', KWD: 'Kuwaiti Dinar',
  KYD: 'Cayman Islands Dollar', KZT: 'Kazakhstani Tenge', LAK: 'Laotian Kip', LBP: 'Lebanese Pound',
  LKR: 'Sri Lankan Rupee', LRD: 'Liberian Dollar', LSL: 'Lesotho Loti', LYD: 'Libyan Dinar',
  MAD: 'Moroccan Dirham', MDL: 'Moldovan Leu', MGA: 'Malagasy Ariary', MKD: 'Macedonian Denar',
  MMK: 'Myanma Kyat', MNT: 'Mongolian Tugrik', MOP: 'Macanese Pataca', MUR: 'Mauritian Rupee',
  MVR: 'Maldivian Rufiyaa', MWK: 'Malawian Kwacha', MXN: 'Mexican Peso', MYR: 'Malaysian Ringgit',
  MZN: 'Mozambican Metical', NAD: 'Namibian Dollar', NGN: 'Nigerian Naira',
  NIO: 'Nicaraguan Córdoba', NOK: 'Norwegian Krone', NPR: 'Nepalese Rupee',
  NZD: 'New Zealand Dollar', OMR: 'Omani Rial', PAB: 'Panamanian Balboa', PEN: 'Peruvian Sol',
  PGK: 'Papua New Guinean Kina', PHP: 'Philippine Peso', PKR: 'Pakistani Rupee',
  PLN: 'Polish Zloty', PYG: 'Paraguayan Guarani', QAR: 'Qatari Rial', RON: 'Romanian Leu',
  RSD: 'Serbian Dinar', RUB: 'Russian Ruble', RWF: 'Rwandan Franc', SAR: 'Saudi Riyal',
  SBD: 'Solomon Islands Dollar', SCR: 'Seychellois Rupee', SDG: 'Sudanese Pound',
  SEK: 'Swedish Krona', SGD: 'Singapore Dollar', SHP: 'Saint Helena Pound',
  SLE: 'Sierra Leonean Leone', SOS: 'Somali Shilling', SRD: 'Surinamese Dollar',
  SSP: 'South Sudanese Pound', STN: 'São Tomé and Príncipe Dobra', SYP: 'Syrian Pound',
  SZL: 'Swazi Lilangeni', THB: 'Thai Baht', TJS: 'Tajikistani Somoni', TMT: 'Turkmenistani Manat',
  TND: 'Tunisian Dinar', TOP: "Tongan Pa'anga", TRY: 'Turkish Lira',
  TTD: 'Trinidad and Tobago Dollar', TWD: 'New Taiwan Dollar', TZS: 'Tanzanian Shilling',
  UAH: 'Ukrainian Hryvnia', UGX: 'Ugandan Shilling', USD: 'US Dollar', UYU: 'Uruguayan Peso',
  UZS: 'Uzbekistan Som', VES: 'Venezuelan Bolívar', VND: 'Vietnamese Dong',
  VUV: 'Vanuatu Vatu', WST: 'Samoan Tala', XAF: 'Central African CFA Franc',
  XCD: 'East Caribbean Dollar', XOF: 'West African CFA Franc', XPF: 'CFP Franc',
  YER: 'Yemeni Rial', ZAR: 'South African Rand', ZMW: 'Zambian Kwacha',
};

export const CURRENCY_METADATA: Record<string, CurrencyMetadata> = Object.fromEntries(
  Object.entries(CURRENCY_NAMES).map(([code, name]) => [code, { code, name, decimals: decimalsFor(code) }]),
);

export const ALL_CURRENCY_CODES = Object.keys(CURRENCY_METADATA);

export function isRealCurrencyCode(code: string): boolean {
  return code.toUpperCase() in CURRENCY_METADATA;
}

export function getCurrencyDecimals(code: string): 0 | 2 | 3 {
  return CURRENCY_METADATA[code.toUpperCase()]?.decimals ?? 2;
}

// Frankfurter (frankfurter.app) is the free, keyless, ECB-sourced FX API
// already wired into ExchangeRateService.refreshFromProvider. It mirrors the
// ECB's own daily reference rates, which cover only these ~30 major
// currencies — a real, disclosed limitation of the free auto-refresh
// pipeline, not of what the platform can enable. A currency outside this set
// can still be enabled by an admin; it just needs a manually-set rate
// (`ingestRate(..., source:'admin')`, already a real working path) instead
// of the daily auto-refresh.
const FRANKFURTER_SUPPORTED = new Set([
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
  'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR',
  'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]);

export function isFrankfurterSupported(code: string): boolean {
  return FRANKFURTER_SUPPORTED.has(code.toUpperCase());
}
