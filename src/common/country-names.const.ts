/**
 * ISO-3166 alpha-2 → real, human-readable country name. Exists purely to
 * build a real, country-specific search query for `AuthVisualService`'s live
 * Unsplash lookup ("Kenya local market", not "KE local market") — this is
 * NOT a UI-facing country picker/label list (the phone-input country
 * dropdown elsewhere in the app has its own, unrelated data source).
 * Covers every code that appears in `auth-visual-region.const.ts`'s
 * `COUNTRY_TO_AUTH_REGION`.
 */
export const COUNTRY_NAMES: Record<string, string> = {
  PK: 'Pakistan', IN: 'India', BD: 'Bangladesh', LK: 'Sri Lanka', NP: 'Nepal',
  BT: 'Bhutan', MV: 'Maldives', AF: 'Afghanistan',

  AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait',
  BH: 'Bahrain', OM: 'Oman', IQ: 'Iraq', IR: 'Iran', IL: 'Israel', JO: 'Jordan',
  LB: 'Lebanon', SY: 'Syria', YE: 'Yemen', TR: 'Turkey', PS: 'Palestine',
  GE: 'Georgia', AM: 'Armenia', AZ: 'Azerbaijan',

  KZ: 'Kazakhstan', UZ: 'Uzbekistan', TM: 'Turkmenistan', TJ: 'Tajikistan',
  KG: 'Kyrgyzstan',

  GB: 'United Kingdom', IE: 'Ireland', FR: 'France', DE: 'Germany',
  ES: 'Spain', PT: 'Portugal', IT: 'Italy', NL: 'Netherlands', BE: 'Belgium',
  LU: 'Luxembourg', CH: 'Switzerland', AT: 'Austria', SE: 'Sweden',
  NO: 'Norway', DK: 'Denmark', FI: 'Finland', IS: 'Iceland', PL: 'Poland',
  CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary', RO: 'Romania', BG: 'Bulgaria',
  GR: 'Greece', HR: 'Croatia', SI: 'Slovenia', RS: 'Serbia', UA: 'Ukraine',
  BY: 'Belarus', LT: 'Lithuania', LV: 'Latvia', EE: 'Estonia', MT: 'Malta',
  CY: 'Cyprus', AD: 'Andorra', MC: 'Monaco', LI: 'Liechtenstein',
  SM: 'San Marino', VA: 'Vatican City', MD: 'Moldova', ME: 'Montenegro',
  MK: 'North Macedonia', BA: 'Bosnia and Herzegovina', AL: 'Albania',
  XK: 'Kosovo', RU: 'Russia', GL: 'Greenland', FO: 'Faroe Islands',

  US: 'United States', CA: 'Canada', BM: 'Bermuda',

  CN: 'China', JP: 'Japan', KR: 'South Korea', KP: 'North Korea',
  TW: 'Taiwan', HK: 'Hong Kong', MO: 'Macau', MN: 'Mongolia',

  SG: 'Singapore', MY: 'Malaysia', TH: 'Thailand', ID: 'Indonesia',
  PH: 'Philippines', VN: 'Vietnam', MM: 'Myanmar', KH: 'Cambodia',
  LA: 'Laos', BN: 'Brunei', TL: 'Timor-Leste',

  EG: 'Egypt', MA: 'Morocco', DZ: 'Algeria', TN: 'Tunisia', LY: 'Libya',
  NG: 'Nigeria', KE: 'Kenya', ZA: 'South Africa', GH: 'Ghana',
  ET: 'Ethiopia', TZ: 'Tanzania', UG: 'Uganda', SN: 'Senegal',
  CI: "Côte d'Ivoire", CM: 'Cameroon', SD: 'Sudan', SS: 'South Sudan',
  BJ: 'Benin', BF: 'Burkina Faso', CV: 'Cabo Verde', GM: 'Gambia',
  GN: 'Guinea', GW: 'Guinea-Bissau', LR: 'Liberia', ML: 'Mali',
  MR: 'Mauritania', NE: 'Niger', SL: 'Sierra Leone', TG: 'Togo',
  AO: 'Angola', CD: 'DR Congo', CG: 'Congo', CF: 'Central African Republic',
  GA: 'Gabon', GQ: 'Equatorial Guinea', TD: 'Chad', ST: 'Sao Tome and Principe',
  BI: 'Burundi', DJ: 'Djibouti', ER: 'Eritrea', KM: 'Comoros',
  MG: 'Madagascar', MW: 'Malawi', MU: 'Mauritius', MZ: 'Mozambique',
  RW: 'Rwanda', SC: 'Seychelles', SO: 'Somalia', ZM: 'Zambia',
  ZW: 'Zimbabwe', BW: 'Botswana', LS: 'Lesotho', NA: 'Namibia',
  SZ: 'Eswatini',

  MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', CO: 'Colombia', CL: 'Chile',
  PE: 'Peru', VE: 'Venezuela', EC: 'Ecuador', BO: 'Bolivia', PY: 'Paraguay',
  UY: 'Uruguay', CR: 'Costa Rica', PA: 'Panama', DO: 'Dominican Republic',
  GT: 'Guatemala', HN: 'Honduras', SV: 'El Salvador', NI: 'Nicaragua',
  BZ: 'Belize', CU: 'Cuba', HT: 'Haiti', JM: 'Jamaica',
  TT: 'Trinidad and Tobago', BS: 'Bahamas', BB: 'Barbados', GY: 'Guyana',
  SR: 'Suriname', AG: 'Antigua and Barbuda', DM: 'Dominica', GD: 'Grenada',
  KN: 'Saint Kitts and Nevis', LC: 'Saint Lucia', VC: 'Saint Vincent',

  AU: 'Australia', NZ: 'New Zealand', FJ: 'Fiji', PG: 'Papua New Guinea',
  SB: 'Solomon Islands', VU: 'Vanuatu', WS: 'Samoa', TO: 'Tonga',
  KI: 'Kiribati', FM: 'Micronesia', MH: 'Marshall Islands', PW: 'Palau',
  NR: 'Nauru', TV: 'Tuvalu', NC: 'New Caledonia', PF: 'French Polynesia',
  GU: 'Guam', AS: 'American Samoa', CK: 'Cook Islands',
};

export function resolveCountryName(code: string | null): string | null {
  if (!code) return null;
  return COUNTRY_NAMES[code] ?? null;
}
