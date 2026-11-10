/* eslint-disable prettier/prettier */
import { promises as dns } from 'dns';
import { signPayload, validateWebhookUrl } from '../merchant-api/merchant-api.util';
import { isPrivateIp } from '../messaging-channels/sms.util';
import type { RequestStatus } from './fulfillment.schema';

/** Callback event types a service may send. Field names live ONLY here (unknown vendor shapes are mapped in one place). */
export const CALLBACK_TYPES = ['accepted', 'shipped', 'delivered', 'cancelled', 'stock'] as const;
export type CallbackType = (typeof CALLBACK_TYPES)[number];

const RANK: Record<RequestStatus, number> = { pending: 0, sent: 1, accepted: 2, shipped: 3, delivered: 4, cancelled: 9, failed: 9 };

/** Status a callback leads to, or null when it must be ignored (backwards, or cancelling something already shipped). */
export function nextStatus(current: RequestStatus, type: CallbackType): RequestStatus | null {
  if (type === 'stock') return null;
  if (current === 'cancelled' || current === 'failed' || current === 'delivered') return null;
  if (type === 'cancelled') return RANK[current] >= RANK.shipped ? null : 'cancelled';
  const target = type as RequestStatus;
  return RANK[target] > RANK[current] ? target : null;
}

export interface FulfillmentPayload {
  event: 'fulfillment_request';
  requestId: string;
  orderNumber: string;
  items: { itemId: string; sku: string | null; title: string; quantity: number }[];
  shippingAddress: Record<string, string | null>;
  shippingMethod: string | null;
}

export interface SendContext { endpointUrl: string | null; secret: string; requestId: string }
export interface FulfillmentProvider {
  /** Hands the request to the service. Returns the service's own id. Throws on failure (the queue retries). */
  send(ctx: SendContext, payload: FulfillmentPayload): Promise<{ externalId: string }>;
}

/** Test/dev adapter: never touches the network. */
export const mockProvider: FulfillmentProvider = {
  async send(ctx) { return { externalId: `mock-${ctx.requestId}` }; },
};

/** Signed HTTPS POST (same signature scheme as our webhooks: `X-Solvexo-Signature: t=..,v1=..`). Public hosts only, no redirects. */
export const genericHttpProvider: FulfillmentProvider = {
  async send(ctx, payload) {
    const err = validateWebhookUrl(ctx.endpointUrl);
    if (err || !ctx.endpointUrl) throw new Error(err ?? 'No endpoint');
    const host = new URL(ctx.endpointUrl).hostname;
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('The address resolves to a private network');
    const body = JSON.stringify(payload);
    const res = await fetch(ctx.endpointUrl, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Solvexo-Fulfillment/1.0', 'X-Solvexo-Delivery': ctx.requestId, 'X-Solvexo-Signature': signPayload(ctx.secret, body) },
      body,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`The service answered HTTP ${res.status}`);
    let externalId = ctx.requestId;
    try { const j: any = await res.json(); if (typeof j?.id === 'string' || typeof j?.externalId === 'string') externalId = String(j.id ?? j.externalId).slice(0, 120); } catch { /* an empty body is fine */ }
    return { externalId };
  },
};

export const providerFor = (kind: string): FulfillmentProvider => (kind === 'mock' ? mockProvider : genericHttpProvider);

const str = (v: unknown, n: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/** Address snapshot sent to the service (field names of our Address schema, tolerant of missing ones). */
export function addressPayload(a: any): Record<string, string | null> {
  const x = a ?? {};
  return {
    name: str(x.recipientName ?? x.name, 120), line1: str(x.addressLine1, 200), line2: str(x.addressLine2, 200),
    city: str(x.city, 80), state: str(x.state, 80), postalCode: str(x.zipCode ?? x.postalCode, 20),
    country: str(x.country, 80), phone: str(x.phone ?? x.phoneNumber, 40),
  };
}

/** Validates a callback body. Returns the clean event or an error text. */
export function parseCallback(body: any): { ok: true; eventId: string; type: CallbackType; requestId: string | null; tracking: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null } | null; stock: { sku: string; quantity: number }[]; reason: string | null } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body' };
  const eventId = str(body.eventId, 120); if (!eventId) return { ok: false, error: 'eventId is required' };
  if (!(CALLBACK_TYPES as readonly string[]).includes(body.type)) return { ok: false, error: 'Unknown event type' };
  const type = body.type as CallbackType;
  const requestId = str(body.requestId, 40);
  if (type !== 'stock' && !requestId) return { ok: false, error: 'requestId is required' };
  let tracking = null as { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null } | null;
  if (type === 'shipped') {
    const t = body.tracking ?? {};
    const url = str(t.trackingUrl, 500);
    tracking = { carrier: str(t.carrier, 80), trackingNumber: str(t.trackingNumber, 120), trackingUrl: url && /^https?:\/\//i.test(url) ? url : null };
  }
  const stock: { sku: string; quantity: number }[] = [];
  if (type === 'stock') {
    if (!Array.isArray(body.stock) || !body.stock.length || body.stock.length > 500) return { ok: false, error: 'stock must be a list of 1-500 rows' };
    for (const r of body.stock) {
      const sku = str(r?.sku, 80); const q = r?.quantity;
      if (!sku || !Number.isInteger(q) || q < 0 || q > 10_000_000) return { ok: false, error: 'Each stock row needs a sku and a whole quantity >= 0' };
      stock.push({ sku, quantity: q });
    }
  }
  return { ok: true, eventId, type, requestId, tracking, stock, reason: str(body.reason, 200) };
}
