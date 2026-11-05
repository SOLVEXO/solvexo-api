/* eslint-disable prettier/prettier */
import {
  BookedShipment, BookShipmentInput, CourierCapabilities, CourierCity, CourierContext, CourierDocument, CourierError,
  CourierKey, CourierStatus, CourierTrackResult,
} from './courier.types';

/**
 * Contract every per-courier MAPPING FILE fills in. A mapping file is the ONLY place that knows a courier's URLs,
 * auth scheme, request/response field names and raw-status vocabulary; `GenericCourierProvider` does the rest.
 * Each mapping file is headed "VERIFY AGAINST OFFICIAL DOC + SANDBOX" and sets `verified` honestly:
 *  - verified:false  => the adapter refuses live calls unless COURIER_ALLOW_UNVERIFIED=true (tests set it).
 */
export interface CourierEndpoint<I, O> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path appended to baseUrl. */
  path: string | ((input: I, ctx: CourierContext) => string);
  query?: (input: I, ctx: CourierContext) => Record<string, string>;
  body?: (input: I, ctx: CourierContext) => any;
  /** Turns a successful (HTTP 2xx) JSON body into the normalized result; throws CourierError on 200-with-error bodies. */
  parse: (json: any, input: I, ctx: CourierContext) => O;
  /** Binary PDF endpoint (parse then receives {buffer} or {json}). */
  binary?: boolean;
}

export interface CourierMapping {
  key: CourierKey;
  label: string;
  /** false until someone has checked every field below against the courier's official doc AND a real sandbox. */
  verified: boolean;
  capabilities: CourierCapabilities;
  baseUrl(mode: 'sandbox' | 'live', ctx: CourierContext): string;
  /** Auth headers derived from the seller's credentials. */
  authHeaders?(ctx: CourierContext): Record<string, string>;
  /** Auth fields merged into every JSON body (couriers that authenticate in-body). */
  authBody?(ctx: CourierContext): Record<string, any>;
  /** Auth fields added to every query string. */
  authQuery?(ctx: CourierContext): Record<string, string>;
  /** Courier-specific "HTTP 200 but failed" detection; return a CourierError to throw, or null. */
  detectError?(json: any): CourierError | null;
  /** Lowercased raw status text -> normalized status. Unknown raw statuses map to `in_transit` (see mapRawStatus). */
  statusMap: Record<string, CourierStatus>;
  /** Cheap authenticated call used by "Test connection" (cities list when the courier has one). */
  test: CourierEndpoint<void, void>;
  cities?: CourierEndpoint<void, CourierCity[]>;
  book: CourierEndpoint<BookShipmentInput, BookedShipment>;
  bookBulk?: CourierEndpoint<BookShipmentInput[], Array<{ referenceNumber: string; shipment?: BookedShipment; error?: string }>>;
  track: CourierEndpoint<string[], CourierTrackResult[]>;
  cancel?: CourierEndpoint<string, void>;
  airwayBill?: CourierEndpoint<string[], CourierDocument>;
  loadSheet?: CourierEndpoint<string[], CourierDocument>;
}

/** Normalizes a raw courier status string; anything unrecognised stays live as `in_transit` rather than being dropped. */
export function mapRawStatus(map: Record<string, CourierStatus>, raw: unknown): CourierStatus {
  const key = String(raw ?? '').trim().toLowerCase();
  if (map[key]) return map[key];
  return 'in_transit';
}
