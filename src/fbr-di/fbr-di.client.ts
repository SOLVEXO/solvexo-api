/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { assertProductionAllowed, PRODUCTION_LOCKED_MESSAGE } from './fbr-production-lock';
import { buildPayload, classifyNetworkError, FBR_REFERENCE_URLS, FBR_URLS, FbrInvoiceInput, FbrMode, FbrResult, interpretResponse } from './fbr-di.util';

const TIMEOUT_MS = 25_000;

/** What the HTTP layer saw. `notSent` = the request provably never left (name lookup / connect / TLS refused). */
interface RawResponse { status: number | null; json: any; networkError: string | null; notSent: boolean }

/** The only place that talks to gw.fbr.gov.pk. The token is passed per call and never logged or stored here. */
@Injectable()
export class FbrDiClient {
  private async request(url: string, token: string, method: 'GET' | 'POST', body?: unknown): Promise<RawResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* body is not JSON */ }
      return { status: res.status, json, networkError: null, notSent: false };
    } catch (e: any) {
      const c = classifyNetworkError(e);
      return { status: null, json: null, networkError: c.message, notSent: c.notSent };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Last line of defence: a production call is refused here even if every check above it were bypassed. Nothing is sent. */
  private lockedResult(): { result: FbrResult; payload: Record<string, unknown> } {
    return {
      payload: {},
      result: { ok: false, invoiceNumber: null, dated: null, retryable: false, notSent: true, unknownOutcome: false, authError: false, locked: true, httpStatus: null, errors: [{ code: 'LOCKED', message: PRODUCTION_LOCKED_MESSAGE }] },
    };
  }

  /** postinvoicedata: reports the invoice for real (production, currently locked) or into the sandbox. Returns the FBR invoice number when accepted. */
  async post(input: FbrInvoiceInput, mode: FbrMode, token: string): Promise<{ result: FbrResult; payload: Record<string, unknown> }> {
    if (mode === 'production' && !assertProductionAllowed()) return this.lockedResult();
    const payload = buildPayload(input, mode);
    const r = await this.request(FBR_URLS[mode].post, token, 'POST', payload);
    return { result: interpretResponse(r.status, r.json, r.networkError, true, r.notSent), payload };
  }

  /** validateinvoicedata: asks FBR whether the invoice would be accepted, without filing it. */
  async validate(input: FbrInvoiceInput, mode: FbrMode, token: string): Promise<{ result: FbrResult; payload: Record<string, unknown> }> {
    if (mode === 'production' && !assertProductionAllowed()) return this.lockedResult();
    const payload = buildPayload(input, mode);
    const r = await this.request(FBR_URLS[mode].validate, token, 'POST', payload);
    return { result: interpretResponse(r.status, r.json, r.networkError, false, r.notSent), payload };
  }

  /** Reference data (provinces, units of measure) so the user can pick FBR's own spelling. null on any failure. */
  async reference(kind: keyof typeof FBR_REFERENCE_URLS, token: string): Promise<any[] | null> {
    const r = await this.request(FBR_REFERENCE_URLS[kind], token, 'GET');
    return r.status === 200 && Array.isArray(r.json) ? r.json : null;
  }
}
