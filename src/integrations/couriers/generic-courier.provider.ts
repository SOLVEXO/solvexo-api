/* eslint-disable prettier/prettier */
import {
  BookedShipment, BookShipmentInput, CourierCapabilities, CourierCity, CourierContext, CourierDocument, CourierError,
  CourierKey, CourierProvider, CourierTrackResult,
} from './courier.types';
import { CourierEndpoint, CourierMapping } from './courier-mapping';
import { courierRequest } from './courier-http';

/**
 * One implementation of the CourierProvider contract driven entirely by a per-courier CourierMapping. Each of the 9
 * courier adapter classes just passes its mapping to this constructor — nothing courier-specific lives here.
 */
export class GenericCourierProvider implements CourierProvider {
  readonly providerKey: CourierKey;
  readonly capabilities: CourierCapabilities;

  constructor(protected readonly mapping: CourierMapping) {
    this.providerKey = mapping.key;
    this.capabilities = mapping.capabilities;
  }

  get verified() { return this.mapping.verified; }

  private guardVerified() {
    if (!this.mapping.verified && process.env.COURIER_ALLOW_UNVERIFIED !== 'true') {
      throw new CourierError(
        'unverified',
        `${this.mapping.label} integration has not been verified against the courier's sandbox yet, so live calls are blocked.`,
      );
    }
  }

  private secrets(ctx: CourierContext): string[] {
    return Object.values(ctx.credentials ?? {}).filter((v) => typeof v === 'string');
  }

  /** Runs one endpoint of the mapping: builds the request, sends it, parses the result. */
  private async call<I, O>(ep: CourierEndpoint<I, O>, input: I, ctx: CourierContext, opts: { retries: number }): Promise<O> {
    this.guardVerified();
    const m = this.mapping;
    const path = typeof ep.path === 'function' ? ep.path(input, ctx) : ep.path;
    const query = { ...(m.authQuery?.(ctx) ?? {}), ...(ep.query?.(input, ctx) ?? {}) };
    const qs = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    let body = ep.body?.(input, ctx);
    if (m.authBody && ep.method !== 'GET') body = { ...(m.authBody(ctx)), ...(body ?? {}) };

    const res = await courierRequest({
      provider: m.key,
      url: `${m.baseUrl(ctx.mode, ctx).replace(/\/$/, '')}/${path.replace(/^\//, '')}${qs}`,
      method: ep.method,
      headers: m.authHeaders?.(ctx),
      body,
      secrets: this.secrets(ctx),
      retries: opts.retries,
      responseType: ep.binary ? 'buffer' : 'json',
    });

    if (ep.binary && res.buffer) return ep.parse({ buffer: res.buffer }, input, ctx);
    const json = res.json;
    if (json === undefined || json === null) throw new CourierError('malformed', 'The courier returned an empty response.');
    const bodyErr = m.detectError?.(json);
    if (bodyErr) throw bodyErr;
    try {
      return ep.parse(json, input, ctx);
    } catch (err) {
      if (err instanceof CourierError) throw err;
      throw new CourierError('malformed', 'The courier returned a response in an unexpected format.');
    }
  }

  async testConnection(ctx: CourierContext) {
    try {
      await this.call(this.mapping.test, undefined as void, ctx, { retries: 1 });
      return { ok: true, message: `${this.mapping.label} credentials are valid` };
    } catch (err: any) {
      if (err instanceof CourierError) {
        const msg = err.code === 'auth' ? `${this.mapping.label} rejected these credentials` : err.message;
        return { ok: false, message: msg };
      }
      return { ok: false, message: 'Courier test failed' };
    }
  }

  async listCities(ctx: CourierContext): Promise<CourierCity[]> {
    if (!this.mapping.cities) throw new CourierError('unsupported', `${this.mapping.label} does not provide a city list.`);
    return this.call(this.mapping.cities, undefined as void, ctx, { retries: 2 });
  }

  async validateCity(ctx: CourierContext, city: string): Promise<CourierCity> {
    const wanted = normalizeCity(city);
    if (!wanted) throw new CourierError('city_not_serviceable', 'Destination city is missing.');
    // Couriers without a city list accept the free-text city; they reject unserviceable ones at booking time.
    if (!this.mapping.cities) return { name: city.trim() };
    const cities = await this.listCities(ctx);
    const hit = cities.find((c) => normalizeCity(c.name) === wanted);
    if (!hit) throw new CourierError('city_not_serviceable', `${this.mapping.label} does not serve "${city.trim()}".`);
    return hit;
  }

  bookShipment(ctx: CourierContext, input: BookShipmentInput): Promise<BookedShipment> {
    // Never auto-retried — a retried booking after a lost response could create a duplicate parcel.
    return this.call(this.mapping.book, input, ctx, { retries: 0 });
  }

  async bookShipments(ctx: CourierContext, inputs: BookShipmentInput[]) {
    if (!this.mapping.bookBulk) {
      // Sequential fallback keeps the per-item contract identical for callers.
      const out: Array<{ referenceNumber: string; shipment?: BookedShipment; error?: string }> = [];
      for (const input of inputs) {
        try { out.push({ referenceNumber: input.referenceNumber, shipment: await this.bookShipment(ctx, input) }); }
        catch (err: any) { out.push({ referenceNumber: input.referenceNumber, error: err?.message ?? 'Booking failed' }); }
      }
      return out;
    }
    return this.call(this.mapping.bookBulk, inputs, ctx, { retries: 0 });
  }

  async trackShipments(ctx: CourierContext, trackingNumbers: string[]): Promise<CourierTrackResult[]> {
    const size = Math.max(1, this.capabilities.trackBatchSize);
    const out: CourierTrackResult[] = [];
    for (let i = 0; i < trackingNumbers.length; i += size) {
      out.push(...(await this.call(this.mapping.track, trackingNumbers.slice(i, i + size), ctx, { retries: 2 })));
    }
    return out;
  }

  async cancelShipment(ctx: CourierContext, trackingNumber: string): Promise<void> {
    if (!this.mapping.cancel) throw new CourierError('unsupported', `${this.mapping.label} does not support cancelling from here.`);
    await this.call(this.mapping.cancel, trackingNumber, ctx, { retries: 0 });
  }

  async getAirwayBill(ctx: CourierContext, trackingNumbers: string[]): Promise<CourierDocument> {
    if (!this.mapping.airwayBill) throw new CourierError('unsupported', `${this.mapping.label} airway bills are not available.`);
    return this.call(this.mapping.airwayBill, trackingNumbers, ctx, { retries: 2 });
  }

  async getLoadSheet(ctx: CourierContext, trackingNumbers: string[]): Promise<CourierDocument> {
    if (!this.mapping.loadSheet) throw new CourierError('unsupported', `${this.mapping.label} load sheets are not available.`);
    return this.call(this.mapping.loadSheet, trackingNumbers, ctx, { retries: 0 });
  }
}

export function normalizeCity(city: string): string {
  return String(city ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
