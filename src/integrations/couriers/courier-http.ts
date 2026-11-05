/* eslint-disable prettier/prettier */
import { Logger } from '@nestjs/common';
import { CourierError } from './courier.types';

/**
 * Shared HTTP layer for every courier adapter: timeout, retry-with-backoff on 5xx/network/timeout for IDEMPOTENT
 * calls only, error mapping to CourierError, a per-courier circuit breaker, and secret redaction everywhere a
 * message could leave this file. Uses global fetch (same as the payment providers) so tests mock `global.fetch`.
 *
 * Booking calls are NOT auto-retried (`retries: 0`): a retried POST after a lost response could book the same
 * parcel twice. Only reads (track/cities/labels) retry.
 */
const logger = new Logger('CourierHttp');

export interface CourierRequest {
  provider: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Object => JSON body; string => sent as-is (caller sets content-type). */
  body?: any;
  timeoutMs?: number;
  retries?: number;
  /** Every credential value in play — redacted from any logged/thrown text. */
  secrets?: string[];
  responseType?: 'json' | 'buffer';
}

export interface CourierResponse { status: number; json?: any; buffer?: Buffer }

const DEFAULT_TIMEOUT_MS = 15_000;
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 30_000;

let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
let nowFn: () => number = () => Date.now();
/** Test hooks only. */
export const courierHttpTestHooks = {
  setSleep(fn: (ms: number) => Promise<void>) { sleepFn = fn; },
  setNow(fn: () => number) { nowFn = fn; },
  reset() { sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)); nowFn = () => Date.now(); breakers.clear(); },
};

const breakers = new Map<string, { failures: number; openUntil: number }>();

function breakerCheck(provider: string) {
  const b = breakers.get(provider);
  if (b && b.openUntil > nowFn()) {
    throw new CourierError('circuit_open', 'This courier is temporarily unavailable (repeated failures) — try again in a minute.', true);
  }
}
function breakerFailure(provider: string) {
  const b = breakers.get(provider) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= BREAKER_THRESHOLD) { b.openUntil = nowFn() + BREAKER_OPEN_MS; b.failures = 0; }
  breakers.set(provider, b);
}
function breakerSuccess(provider: string) { breakers.delete(provider); }

/** Replaces known secret values and common secret-looking key/value fragments. */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  }
  return out.replace(/("?(?:token|password|passwd|api[_-]?key|api[_-]?password|authorization|secret)"?\s*[:=]\s*"?)([^",&\s}]+)/gi, '$1[redacted]');
}

function safeSnippet(raw: unknown, secrets: string[]): string {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  return redactSecrets(text, secrets).slice(0, 200);
}

/** Best-effort human message from a courier error body (redacted + truncated). */
export function courierMessageFromBody(json: any, secrets: string[] = []): string {
  const candidate = json?.message ?? json?.Message ?? json?.error ?? json?.statusMessage ?? json?.status_message ?? json?.errors?.[0] ?? '';
  return safeSnippet(candidate, secrets);
}

async function attempt(req: CourierRequest): Promise<CourierResponse> {
  const secrets = req.secrets ?? [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    const isJson = req.body !== undefined && typeof req.body !== 'string';
    res = await fetch(req.url, {
      method: req.method,
      headers: { Accept: 'application/json', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...(req.headers ?? {}) },
      body: req.body === undefined ? undefined : isJson ? JSON.stringify(req.body) : req.body,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new CourierError('timeout', 'The courier did not respond in time.', true);
    throw new CourierError('network', 'Could not reach the courier.', true);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) throw new CourierError('auth', 'The courier rejected the credentials.');
  if (res.status === 429 || res.status >= 500) throw new CourierError('upstream', `The courier is having trouble (HTTP ${res.status}).`, true);

  if (req.responseType === 'buffer' && res.ok) {
    const ct = res.headers?.get?.('content-type') ?? '';
    if (/json/i.test(ct)) {
      // Some couriers answer a label request with a JSON envelope (url or error) instead of bytes.
      try { return { status: res.status, json: await res.json() }; } catch { throw new CourierError('malformed', 'The courier returned an unreadable response.'); }
    }
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  }

  let json: any;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) throw new CourierError('validation', `The courier rejected the request (HTTP ${res.status}).`);
    throw new CourierError('malformed', 'The courier returned an unreadable response.');
  }
  if (res.status === 404) throw new CourierError('not_found', courierMessageFromBody(json, secrets) || 'Not found at the courier.');
  if (!res.ok) throw new CourierError('validation', courierMessageFromBody(json, secrets) || `The courier rejected the request (HTTP ${res.status}).`);
  return { status: res.status, json };
}

export async function courierRequest(req: CourierRequest): Promise<CourierResponse> {
  breakerCheck(req.provider);
  const retries = req.retries ?? 0;
  let lastErr: CourierError | null = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const out = await attempt(req);
      breakerSuccess(req.provider);
      return out;
    } catch (err) {
      const e = err instanceof CourierError ? err : new CourierError('network', 'Could not reach the courier.', true);
      lastErr = e;
      if (e.retryable) breakerFailure(req.provider);
      if (!e.retryable || i === retries) break;
      logger.warn(`${req.provider} ${req.method} failed (${e.code}); retry ${i + 1}/${retries}`);
      await sleepFn(300 * 2 ** i + Math.floor(Math.random() * 100));
    }
  }
  throw lastErr!;
}
