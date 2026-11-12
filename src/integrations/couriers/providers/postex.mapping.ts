/* eslint-disable prettier/prettier */
/**
 * PostEx mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX.
 *
 * Known public facts (from the brief): base https://api.postex.pk/services/integration/api, auth header `token`,
 * endpoints create-order / cancel-order / track-bulk-order (max 10) / airway bill (max 10) / load sheet /
 * create-merchant-address. PostEx's own PDF differs from the live API — the SANDBOX WINS.
 * Everything below beyond those facts (exact paths, versions, body/response field names, status wording) is
 * recalled, NOT verified — see docs/courier-open-questions.md. `verified` stays false until checked in sandbox.
 */
import { CourierError, CourierStatus } from '../courier.types';
import { CourierMapping, mapRawStatus } from '../courier-mapping';

export const POSTEX_STATUS_MAP: Record<string, CourierStatus> = {
  'unbooked': 'booked',
  'booked': 'booked',
  'picked by postex': 'picked_up',
  'postex warehouse': 'in_transit',
  'en-route to postex warehouse': 'in_transit',
  'out for delivery': 'out_for_delivery',
  'delivery under review': 'failed',
  'attempted': 'failed',
  'delivered': 'delivered',
  'out for return': 'returned',
  'return in transit': 'returned',
  'returned': 'returned',
  'cancelled': 'cancelled',
  'expired': 'cancelled',
  'un-assigned by me': 'booked',
};

/** PostEx wraps results as { statusCode: "200", statusMessage, dist }. A non-200 statusCode inside HTTP 200 is a failure. */
function detectError(json: any): CourierError | null {
  const code = String(json?.statusCode ?? '200');
  if (code === '200') return null;
  const msg = String(json?.statusMessage ?? 'PostEx rejected the request').slice(0, 200);
  if (/city/i.test(msg)) return new CourierError('city_not_serviceable', msg);
  if (code === '401' || /token|unauthori/i.test(msg)) return new CourierError('auth', 'The courier rejected the credentials.');
  return new CourierError('validation', msg);
}

export const POSTEX_MAPPING: CourierMapping = {
  key: 'postex',
  label: 'PostEx',
  verified: false,
  capabilities: { bulkBooking: false, trackBatchSize: 10, airwayBillBatchSize: 10, airwayBill: true, loadSheet: true, cityList: true, cancel: true, codStatus: false, pushWebhook: false },
  baseUrl: () => 'https://api.postex.pk/services/integration/api',
  authHeaders: (ctx) => ({ token: ctx.credentials.apiToken }),
  detectError,
  statusMap: POSTEX_STATUS_MAP,

  cities: {
    method: 'GET',
    path: '/order/v2/get-operational-city',
    parse: (json) => (json.dist as any[]).map((c) => ({ name: String(c.operationalCityName) })),
  },
  test: {
    method: 'GET',
    path: '/order/v2/get-operational-city',
    parse: (json) => { if (!Array.isArray(json.dist)) throw new CourierError('malformed', 'Unexpected PostEx response.'); },
  },
  book: {
    method: 'POST',
    path: '/order/v3/create-order',
    body: (i) => ({
      orderRefNumber: i.referenceNumber,
      customerName: i.consignee.name,
      customerPhone: i.consignee.phone,
      deliveryAddress: i.consignee.address,
      cityName: i.consignee.city,
      invoicePayment: String(i.codAmount), // "0" when already paid
      invoiceDivision: 1,
      items: i.pieces,
      orderType: 'Normal',
      orderDetail: i.description.slice(0, 250),
      transactionNotes: i.remarks ?? '',
      pickupAddressCode: i.pickup.addressCode,
    }),
    parse: (json) => {
      const tn = json?.dist?.trackingNumber;
      if (!tn) throw new CourierError('malformed', 'PostEx did not return a tracking number.');
      return { trackingNumber: String(tn), trackingUrl: null };
    },
  },
  cancel: {
    method: 'PUT',
    path: '/order/v1/cancel-order',
    body: (tn) => ({ trackingNumber: tn }),
    parse: () => undefined,
  },
  track: {
    method: 'GET',
    path: '/order/v1/track-bulk-order',
    query: (tns) => ({ trackingNumbers: tns.join(',') }),
    parse: (json) => (json.dist as any[]).map((d) => {
      const history: any[] = d.transactionStatusHistory ?? [];
      const events = history.map((h) => ({
        status: mapRawStatus(POSTEX_STATUS_MAP, h.transactionStatusMessage),
        rawStatus: String(h.transactionStatusMessage ?? ''),
        description: h.transactionStatusMessage ? String(h.transactionStatusMessage) : undefined,
        occurredAt: new Date(h.updatedAt),
      })).filter((e) => !Number.isNaN(e.occurredAt.getTime()));
      const raw = String(d.transactionStatus ?? history[history.length - 1]?.transactionStatusMessage ?? '');
      return { trackingNumber: String(d.trackingNumber), status: mapRawStatus(POSTEX_STATUS_MAP, raw), rawStatus: raw, events };
    }),
  },
  airwayBill: {
    method: 'GET',
    path: '/order/v1/get-invoice',
    query: (tns) => ({ trackingNumbers: tns.join(',') }),
    binary: true,
    parse: (res: any) => {
      if (res?.buffer) return { pdf: res.buffer };
      if (res?.dist?.url) return { url: String(res.dist.url) };
      throw new CourierError('malformed', 'PostEx did not return an airway bill.');
    },
  },
  loadSheet: {
    method: 'POST',
    path: '/order/v1/generate-load-sheet',
    body: (tns) => ({ trackingNumbers: tns }),
    binary: true,
    parse: (res: any) => {
      if (res?.buffer) return { pdf: res.buffer };
      if (res?.dist?.url) return { url: String(res.dist.url) };
      throw new CourierError('malformed', 'PostEx did not return a load sheet.');
    },
  },
};
