/* eslint-disable prettier/prettier */
import { moneyError } from './pos-money.util';

/** How long a device may sit on a sale before syncing it (env POS_OFFLINE_MAX_HOURS, default 72h). */
export const offlineWindowMs = (): number => {
  const h = Number(process.env.POS_OFFLINE_MAX_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 72) * 3600 * 1000;
};

/** Device clocks drift; a sale stamped this far ahead of the server is still accepted. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface OfflineInfo {
  isOffline: boolean;
  /** When the sale was really made (the device's timestamp, validated). `now` for ordinary online sales. */
  at: Date;
}

/**
 * Decides whether a sale request is an offline replay and, if so, validates its device timestamp:
 *  - not in the future (beyond a small clock skew) → OFFLINE_SALE_FROM_FUTURE
 *  - not older than the offline window            → OFFLINE_SALE_TOO_OLD
 * An ordinary online sale (no `offline` flag) ignores `clientCreatedAt` entirely — it is stamped with server time.
 */
export function parseOffline(body: { offline?: boolean; clientCreatedAt?: string } | undefined, now: Date = new Date()): OfflineInfo {
  if (!body?.offline) return { isOffline: false, at: now };
  const at = body.clientCreatedAt ? new Date(body.clientCreatedAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw moneyError('OFFLINE_SALE_NO_TIMESTAMP', 'An offline sale must carry the time it was made (clientCreatedAt)');
  }
  if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw moneyError('OFFLINE_SALE_FROM_FUTURE', 'This sale is dated in the future — check the device clock', { clientCreatedAt: at.toISOString() });
  }
  if (at.getTime() < now.getTime() - offlineWindowMs()) {
    throw moneyError('OFFLINE_SALE_TOO_OLD', `This sale is older than the ${Math.round(offlineWindowMs() / 3600000)}-hour offline limit and can't be synced automatically — a manager must resolve it`, {
      clientCreatedAt: at.toISOString(), windowHours: Math.round(offlineWindowMs() / 3600000),
    });
  }
  return { isOffline: true, at };
}
