/* eslint-disable prettier/prettier */
/**
 * UNVERIFIED PLACEHOLDER wire format for couriers whose API documentation we do not have (TCS, Trax, M&P, BlueEx,
 * CallCourier, Swyft, Daewoo FastEx). NONE of these paths or field names come from a courier's official doc — they
 * are a deliberately generic REST/JSON shape so the adapter, error mapping, normalization and booking flow are
 * complete and testable. Each courier's own mapping file supplies only auth + hosts (both marked UNVERIFIED) and
 * calls `placeholderMapping()`. Replacing this with the real contract = editing that courier's mapping file only.
 * See docs/courier-open-questions.md for the per-courier list of things to confirm.
 */
import { CourierCapabilities, CourierContext, CourierError, CourierKey, CourierStatus } from '../courier.types';
import { CourierMapping, mapRawStatus } from '../courier-mapping';

export const PLACEHOLDER_STATUS_MAP: Record<string, CourierStatus> = {
  booked: 'booked', created: 'booked', pending: 'booked',
  picked_up: 'picked_up', 'picked up': 'picked_up',
  in_transit: 'in_transit', 'in transit': 'in_transit', dispatched: 'in_transit',
  out_for_delivery: 'out_for_delivery', 'out for delivery': 'out_for_delivery',
  delivered: 'delivered',
  returned: 'returned', rto: 'returned', 'return to origin': 'returned',
  cancelled: 'cancelled', canceled: 'cancelled',
  failed: 'failed', 'delivery failed': 'failed', undelivered: 'failed',
};

export interface PlaceholderOptions {
  key: CourierKey;
  label: string;
  sandboxBase: string;
  liveBase: string;
  authHeaders?: (ctx: CourierContext) => Record<string, string>;
  authBody?: (ctx: CourierContext) => Record<string, any>;
  capabilities?: Partial<CourierCapabilities>;
}

function detectError(json: any): CourierError | null {
  if (json?.success === false || json?.error) {
    const msg = String(json.message ?? json.error ?? 'The courier rejected the request').slice(0, 200);
    if (/city|destination/i.test(msg)) return new CourierError('city_not_serviceable', msg);
    if (/auth|credential|unauthori/i.test(msg)) return new CourierError('auth', 'The courier rejected the credentials.');
    return new CourierError('validation', msg);
  }
  return null;
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export function placeholderMapping(o: PlaceholderOptions): CourierMapping {
  const base = (mode: 'sandbox' | 'live') => (mode === 'live' ? o.liveBase : o.sandboxBase);
  return {
    key: o.key,
    label: o.label,
    verified: false,
    capabilities: {
      bulkBooking: false, trackBatchSize: 10, airwayBillBatchSize: 10, airwayBill: true, loadSheet: false,
      cityList: true, cancel: true, codStatus: false, pushWebhook: false, ...(o.capabilities ?? {}),
    },
    baseUrl: base,
    authHeaders: o.authHeaders,
    authBody: o.authBody,
    detectError,
    statusMap: PLACEHOLDER_STATUS_MAP,
    cities: {
      method: 'GET', path: '/cities',
      parse: (json) => (json.cities as any[]).map((c) => ({ id: c.id !== undefined ? String(c.id) : undefined, name: String(c.name) })),
    },
    test: {
      method: 'GET', path: '/cities',
      parse: (json) => { if (!Array.isArray(json.cities)) throw new CourierError('malformed', 'Unexpected courier response.'); },
    },
    book: {
      method: 'POST', path: '/shipments',
      body: (i) => ({
        reference: i.referenceNumber,
        consignee_name: i.consignee.name, consignee_phone: i.consignee.phone, consignee_address: i.consignee.address,
        destination_city: i.consignee.city,
        pickup_address: i.pickup.address, pickup_city: i.pickup.city,
        weight_kg: i.weightKg, pieces: i.pieces, cod_amount: i.codAmount, description: i.description, remarks: i.remarks ?? '',
      }),
      parse: (json) => {
        const tn = json?.tracking_number;
        if (!tn) throw new CourierError('malformed', 'The courier did not return a tracking number.');
        return { trackingNumber: String(tn), trackingUrl: json.tracking_url ?? null, labelUrl: json.label_url ?? null };
      },
    },
    cancel: { method: 'POST', path: '/shipments/cancel', body: (tn) => ({ tracking_number: tn }), parse: () => undefined },
    track: {
      method: 'GET', path: '/track',
      query: (tns) => ({ numbers: tns.join(',') }),
      parse: (json) => (json.shipments as any[]).map((s) => {
        const events = ((s.events ?? []) as any[]).map((e) => ({
          status: mapRawStatus(PLACEHOLDER_STATUS_MAP, e.status), rawStatus: String(e.status ?? ''),
          description: e.description, location: e.location, occurredAt: new Date(e.time),
        })).filter((e) => !Number.isNaN(e.occurredAt.getTime()));
        const raw = String(s.status ?? events[events.length - 1]?.rawStatus ?? '');
        return { trackingNumber: String(s.tracking_number), status: mapRawStatus(PLACEHOLDER_STATUS_MAP, raw), rawStatus: raw, events };
      }),
    },
    airwayBill: {
      method: 'GET', path: '/labels', query: (tns) => ({ numbers: tns.join(',') }), binary: true,
      parse: (res: any) => {
        if (res?.buffer) return { pdf: res.buffer };
        if (res?.url) return { url: String(res.url) };
        throw new CourierError('malformed', 'The courier did not return an airway bill.');
      },
    },
  };
}
