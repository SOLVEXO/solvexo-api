/* eslint-disable prettier/prettier */

/**
 * Marketing attribution (Shopify: Growth → Attribution). Every order is credited to ONE marketing touch — a visit of the
 * same customer — chosen by the attribution model. We only keep visits (sessions), so a "touch" is a session.
 *
 *  - last_non_direct (default, same as Shopify): the visit that converted; when that was a direct visit, the customer's most
 *    recent earlier visit that came from somewhere (look-back window below). All direct → direct.
 *  - last_click:  the visit that converted, whatever it was.
 *  - first_click: the customer's first visit inside the look-back window.
 */
export const ATTRIBUTION_MODELS = ['last_non_direct', 'last_click', 'first_click'] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];
export const ATTRIBUTION_DIMENSIONS = ['channel', 'source', 'campaign'] as const;
export type AttributionDimension = (typeof ATTRIBUTION_DIMENSIONS)[number];
export const LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;

export interface Touch {
  sessionId: string;
  visitorId: string;
  startedAt: Date;
  trafficSource: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrerHost?: string | null;
}

export function isAttributionModel(v: unknown): v is AttributionModel {
  return typeof v === 'string' && (ATTRIBUTION_MODELS as readonly string[]).includes(v);
}
export function isAttributionDimension(v: unknown): v is AttributionDimension {
  return typeof v === 'string' && (ATTRIBUTION_DIMENSIONS as readonly string[]).includes(v);
}

/**
 * The touch an order is credited to. `visitorTouches` are that customer's visits (any order); only visits inside the
 * look-back window before the conversion count as history.
 */
export function pickTouch(model: AttributionModel, converting: Touch, visitorTouches: Touch[], conversionAt: Date): Touch {
  if (model === 'last_click') return converting;
  const windowStart = conversionAt.getTime() - LOOKBACK_DAYS * DAY_MS;
  const history = visitorTouches
    .filter((t) => t.startedAt.getTime() >= windowStart && t.startedAt.getTime() <= conversionAt.getTime())
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  if (model === 'first_click') return history[0] ?? converting;
  // last_non_direct
  if (converting.trafficSource !== 'direct') return converting;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].trafficSource !== 'direct') return history[i];
  }
  return converting;
}

/** The report row a touch belongs to for the chosen dimension. */
export function dimensionKey(dim: AttributionDimension, t: Pick<Touch, 'trafficSource' | 'utmSource' | 'utmCampaign' | 'referrerHost'>): string | null {
  if (dim === 'channel') return t.trafficSource || 'direct';
  if (dim === 'source') return (t.utmSource || t.referrerHost || t.trafficSource || 'direct').toLowerCase();
  return t.utmCampaign ? t.utmCampaign.toLowerCase() : null; // campaign: visits without a campaign are not part of this view
}

export interface AttributionRow {
  key: string;
  sessions: number;
  orders: number;
  sales: number;
  averageOrderValue: number;
  /** orders / sessions, in percent (0 when there are no sessions) */
  conversionRate: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sessions per key + credited orders/sales per key → report rows, biggest sales first. */
export function buildRows(sessionCounts: Map<string, number>, credited: { key: string; sales: number }[]): AttributionRow[] {
  const byKey = new Map<string, { orders: number; sales: number }>();
  for (const c of credited) {
    const cur = byKey.get(c.key) ?? { orders: 0, sales: 0 };
    cur.orders += 1;
    cur.sales += c.sales;
    byKey.set(c.key, cur);
  }
  const keys = new Set<string>([...sessionCounts.keys(), ...byKey.keys()]);
  const rows: AttributionRow[] = [];
  for (const key of keys) {
    const sessions = sessionCounts.get(key) ?? 0;
    const { orders, sales } = byKey.get(key) ?? { orders: 0, sales: 0 };
    rows.push({
      key,
      sessions,
      orders,
      sales: round2(sales),
      averageOrderValue: orders > 0 ? round2(sales / orders) : 0,
      conversionRate: sessions > 0 ? round2((orders / sessions) * 100) : 0,
    });
  }
  return rows.sort((a, b) => b.sales - a.sales || b.sessions - a.sessions);
}
