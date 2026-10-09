/* eslint-disable prettier/prettier */
import { isValidTimeZone } from '../analytics/utils/analytics-date.util';

/**
 * Default zone for countries that have exactly one — used until the seller picks a time zone in Store settings.
 * Countries spanning several zones (US, CA, AU, RU, BR, MX, ID…) are deliberately absent: guessing one would shift
 * their reports by hours, so they fall back to UTC until the seller chooses.
 */
const SINGLE_ZONE_COUNTRIES: Record<string, string> = {
  PK: 'Asia/Karachi', IN: 'Asia/Kolkata', BD: 'Asia/Dhaka', LK: 'Asia/Colombo', NP: 'Asia/Kathmandu', AF: 'Asia/Kabul',
  AE: 'Asia/Dubai', SA: 'Asia/Riyadh', QA: 'Asia/Qatar', KW: 'Asia/Kuwait', BH: 'Asia/Bahrain', OM: 'Asia/Muscat',
  TR: 'Europe/Istanbul', EG: 'Africa/Cairo', JO: 'Asia/Amman', MY: 'Asia/Kuala_Lumpur', SG: 'Asia/Singapore',
  CN: 'Asia/Shanghai', JP: 'Asia/Tokyo', KR: 'Asia/Seoul', HK: 'Asia/Hong_Kong', TH: 'Asia/Bangkok', PH: 'Asia/Manila',
  GB: 'Europe/London', IE: 'Europe/Dublin', FR: 'Europe/Paris', DE: 'Europe/Berlin', IT: 'Europe/Rome', ES: 'Europe/Madrid',
  NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', CH: 'Europe/Zurich', AT: 'Europe/Vienna', SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo', DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki', PL: 'Europe/Warsaw', NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi', ZA: 'Africa/Johannesburg', NZ: 'Pacific/Auckland',
};

/** The time zone a store's reports run in: its own setting, else its country's only zone, else UTC. */
export function resolveStoreTimeZone(store: { timezone?: string | null; country?: string | null } | null | undefined): string {
  if (store?.timezone && isValidTimeZone(store.timezone)) return store.timezone;
  const byCountry = store?.country ? SINGLE_ZONE_COUNTRIES[String(store.country).toUpperCase()] : undefined;
  return byCountry ?? 'UTC';
}
