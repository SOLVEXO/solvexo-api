/* eslint-disable prettier/prettier */
import { localDateKey, zonedMidnight, zonedParts } from '../analytics/utils/analytics-date.util';

/**
 * G4.0 — every "day" of the till is a day in the STORE's time zone (Store.timezone, else the country's only zone — Asia/Karachi for PK — else UTC),
 * never the server's clock. DST-safe (the zone maths are the storefront analytics' ones). Days are half-open: [start, end).
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local calendar day named by `input` ('YYYY-MM-DD', or any instant — its local date in `tz`; nothing = today). */
export function localDay(input: string | Date | null | undefined, tz: string, now: Date = new Date()): { key: string; start: Date; end: Date } {
  let y: number, m: number, d: number;
  const s = typeof input === 'string' ? input.trim() : '';
  const hit = s ? DATE_ONLY.exec(s) : null;
  if (hit) { y = Number(hit[1]); m = Number(hit[2]); d = Number(hit[3]); }
  else {
    const at = input instanceof Date ? input : s ? new Date(s) : now;
    const p = zonedParts(Number.isNaN(at.getTime()) ? now : at, tz);
    y = p.year; m = p.month; d = p.day;
  }
  const start = zonedMidnight(y, m, d, tz);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const end = zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz);
  return { key: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, start, end };
}

/** `from` / `to` of a list filter or report: `from` = start of its local day, `to` = END of its local day (inclusive day). Either may be missing. */
export function localRange(from: string | undefined | null, to: string | undefined | null, tz: string): { $gte?: Date; $lt?: Date } {
  const out: { $gte?: Date; $lt?: Date } = {};
  if (from) out.$gte = localDay(from, tz).start;
  if (to) out.$lt = localDay(to, tz).end;
  return out;
}

export const localHour = (at: Date | string, tz: string): number => zonedParts(new Date(at), tz).hour;
export const localKey = (at: Date | string, tz: string): string => localDateKey(new Date(at), tz);
