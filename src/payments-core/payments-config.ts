/* eslint-disable prettier/prettier */
/**
 * G2.1 tunables, read at call time from the environment (so tests and ops can change them without a rebuild).
 *   PAYMENTS_PROVIDER_POS            provider key; default 'mock' outside production, REQUIRED in production (no silent fallback to the mock)
 *   PAYMENTS_QR_TTL_SECONDS          our QR expiry, default 180 (3 minutes); always capped by the provider's own QR validity
 *   PAYMENTS_QR_TTL_SECONDS_<KEY>    per-provider override (KEY upper-cased, e.g. PAYMENTS_QR_TTL_SECONDS_PAYFAST)
 *   PAYMENTS_MAX_AMOUNT_MINOR        sanity ceiling per payment (default 1e9 minor units)
 *   PAYMENTS_LATE_WINDOW_MINUTES     how long after expiry we keep looking for a late payment at the provider (default 30)
 *   PAYMENTS_UNATTACHED_GRACE_SECONDS a confirmed payment with no sale after this long becomes a "needs attention" item (default 120)
 */
export interface PaymentsConfig {
  providerKey: string;
  qrTtlSeconds: number;
  maxAmountMinor: number;
  lateWindowMs: number;
  unattachedGraceMs: number;
  webhookReplayWindowSeconds: number;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function paymentsConfig(env: NodeJS.ProcessEnv = process.env): PaymentsConfig {
  const providerKey = (env.PAYMENTS_PROVIDER_POS || (env.NODE_ENV === 'production' ? '' : 'mock')).toLowerCase();
  const perProvider = providerKey ? env[`PAYMENTS_QR_TTL_SECONDS_${providerKey.toUpperCase()}`] : undefined;
  return {
    providerKey,
    qrTtlSeconds: num(perProvider, num(env.PAYMENTS_QR_TTL_SECONDS, 180)),
    maxAmountMinor: num(env.PAYMENTS_MAX_AMOUNT_MINOR, 1_000_000_000),
    lateWindowMs: num(env.PAYMENTS_LATE_WINDOW_MINUTES, 30) * 60 * 1000,
    unattachedGraceMs: num(env.PAYMENTS_UNATTACHED_GRACE_SECONDS, 120) * 1000,
    webhookReplayWindowSeconds: 300,
  };
}
