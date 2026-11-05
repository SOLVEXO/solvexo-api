/* eslint-disable prettier/prettier */
/**
 * Leopards Courier mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX.
 *
 * Known public facts (from the brief): api key + api password, test/live environments, calls bookPacket,
 * getAllCities, trackBookedPacket. Everything else (host names, `format/json` path suffix, field names, weight
 * unit, `status`/`error` envelope, cancel call, status wording) is recalled, NOT verified — see
 * docs/courier-open-questions.md. `verified` stays false until checked in the test environment.
 */
import { CourierError, CourierStatus } from '../courier.types';
import { CourierMapping, mapRawStatus } from '../courier-mapping';

export const LEOPARDS_STATUS_MAP: Record<string, CourierStatus> = {
  'pending': 'booked',
  'booked': 'booked',
  'ready for pickup': 'booked',
  'picked': 'picked_up',
  'pickup completed': 'picked_up',
  'arrival at origin': 'in_transit',
  'dispatched': 'in_transit',
  'in transit': 'in_transit',
  'arrived at destination': 'in_transit',
  'out for delivery': 'out_for_delivery',
  'being delivered': 'out_for_delivery',
  'delivery attempted': 'failed',
  'consignee not available': 'failed',
  'delivered': 'delivered',
  'return to shipper': 'returned',
  'being returned': 'returned',
  'returned to shipper': 'returned',
  'cancelled': 'cancelled',
};

/** Leopards answers HTTP 200 with { status: 0|1, error: "..." } — status 0 is a failure. */
function detectError(json: any): CourierError | null {
  if (json?.status === 1 || String(json?.status) === '1') return null;
  if (json?.status === undefined) return null;
  const msg = String(json?.error ?? 'Leopards rejected the request').slice(0, 200);
  if (/api|password|authenticat|invalid key/i.test(msg)) return new CourierError('auth', 'The courier rejected the credentials.');
  if (/city/i.test(msg)) return new CourierError('city_not_serviceable', msg);
  return new CourierError('validation', msg);
}

export const LEOPARDS_MAPPING: CourierMapping = {
  key: 'leopards',
  label: 'Leopards Courier',
  verified: false,
  capabilities: { bulkBooking: false, trackBatchSize: 50, airwayBillBatchSize: 1, airwayBill: false, loadSheet: false, cityList: true, cancel: true, codStatus: false, pushWebhook: false },
  baseUrl: (mode) => (mode === 'live' ? 'https://merchantapi.leopardscourier.com/api' : 'https://merchantapistaging.leopardscourier.com/api'),
  authBody: (ctx) => ({ api_key: ctx.credentials.apiKey, api_password: ctx.credentials.apiPassword }),
  detectError,
  statusMap: LEOPARDS_STATUS_MAP,

  cities: {
    method: 'POST',
    path: '/getAllCities/format/json/',
    parse: (json) => (json.city_list as any[]).map((c) => ({ id: String(c.id), name: String(c.name) })),
  },
  test: {
    method: 'POST',
    path: '/getAllCities/format/json/',
    parse: (json) => { if (!Array.isArray(json.city_list)) throw new CourierError('malformed', 'Unexpected Leopards response.'); },
  },
  book: {
    method: 'POST',
    path: '/bookPacket/format/json/',
    body: (i) => ({
      booked_packet_weight: Math.max(1, Math.round(i.weightKg * 1000)), // grams
      booked_packet_no_piece: i.pieces,
      booked_packet_collect_amount: i.codAmount, // 0 when already paid
      booked_packet_order_id: i.referenceNumber,
      origin_city: i.pickup.cityId ?? 'self',
      destination_city: i.consignee.cityId ?? 'self',
      shipment_name_eng: i.pickup.name,
      shipment_email: i.pickup.email ?? '',
      shipment_phone: i.pickup.phone,
      shipment_address: i.pickup.address,
      consignment_name_eng: i.consignee.name,
      consignment_email: i.consignee.email ?? '',
      consignment_phone: i.consignee.phone,
      consignment_address: i.consignee.address,
      special_instructions: i.remarks ?? i.description.slice(0, 200),
    }),
    parse: (json) => {
      const tn = json?.track_number;
      if (!tn) throw new CourierError('malformed', 'Leopards did not return a tracking number.');
      return { trackingNumber: String(tn), labelUrl: json.slip_link ? String(json.slip_link) : null, trackingUrl: null };
    },
  },
  cancel: {
    method: 'POST',
    path: '/cancelBookedPackets/format/json/',
    body: (tn) => ({ cn_numbers: tn }),
    parse: () => undefined,
  },
  track: {
    method: 'POST',
    path: '/trackBookedPacket/format/json/',
    body: (tns) => ({ track_numbers: tns.join(',') }),
    parse: (json) => (json.packet_list as any[]).map((p) => {
      const detail: any[] = p['Tracking Detail'] ?? [];
      const events = detail.map((d) => ({
        status: mapRawStatus(LEOPARDS_STATUS_MAP, d.Status),
        rawStatus: String(d.Status ?? ''),
        description: d.Reason ? String(d.Reason) : undefined,
        occurredAt: new Date(`${d.Activity_Date ?? ''} ${d.Activity_Time ?? ''}`.trim()),
      })).filter((e) => !Number.isNaN(e.occurredAt.getTime()));
      const raw = String(p.booked_packet_status ?? events[events.length - 1]?.rawStatus ?? '');
      return { trackingNumber: String(p.track_number), status: mapRawStatus(LEOPARDS_STATUS_MAP, raw), rawStatus: raw, events };
    }),
  },
};
