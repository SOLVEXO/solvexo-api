/* eslint-disable prettier/prettier */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
  CreateChargeInput, CreateChargeResult, PaymentProvider, ProviderOutcome, RefundInput, RefundResult,
  WebhookReplayError, WebhookSignatureError,
} from '../payment-provider.interface';

export type MockScenario = 'confirm' | 'fail' | 'expire';
export const MOCK_REPLAY_WINDOW_SECONDS = 300;

interface MockCharge { providerRef: string; amountMinor: number; expiresAt: Date; state: 'pending' | 'confirmed' | 'failed' | 'expired' | 'cancelled'; autoScenario: string | null }
interface MockRefund { refundId: string; amountMinor: number; status: 'succeeded' | 'pending' | 'failed'; ref: string }

/**
 * A fake provider with CONTROLLABLE outcomes, for tests and demos — never a real money path. Charges live in memory (per process).
 *   • `createCharge` with `mockScenario: 'auto_confirm' | 'auto_fail'` makes the first poll return that outcome; otherwise a charge stays
 *     `pending` until `simulate(...)` (or a signed webhook built with `buildWebhook(...)`) says otherwise.
 *   • Refund scenarios by reason text: 'mock:pending' (async, finishes on `simulate refund`), 'mock:fail'.
 *   • `buildWebhook` produces a correctly signed webhook (or a tampered / stale / duplicate one) exactly as a real provider would send it.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly key = 'mock';
  readonly qrValiditySeconds: number;
  readonly supportsWebhooks: boolean;
  private charges = new Map<string, MockCharge>();
  private refunds = new Map<string, MockRefund>();

  constructor(private readonly opts: { webhookSecret: string; qrValiditySeconds?: number; supportsWebhooks?: boolean }) {
    this.qrValiditySeconds = opts.qrValiditySeconds ?? 600;
    this.supportsWebhooks = opts.supportsWebhooks ?? true;
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const existing = [...this.charges.values()].find((c) => (c as any).idem === input.idempotencyKey);
    if (existing) return { providerRef: existing.providerRef, qrPayload: `mock-raast://pay/${existing.providerRef}?am=${existing.amountMinor}`, expiresAt: existing.expiresAt };
    const providerRef = `mock_${randomUUID()}`;
    const maxExpiry = new Date(Date.now() + this.qrValiditySeconds * 1000);
    const expiresAt = input.expiresAt.getTime() < maxExpiry.getTime() ? input.expiresAt : maxExpiry;
    const c: MockCharge & { idem?: string } = { providerRef, amountMinor: input.amountMinor, expiresAt, state: 'pending', autoScenario: input.mockScenario ?? null };
    c.idem = input.idempotencyKey;
    this.charges.set(providerRef, c);
    return { providerRef, qrPayload: `mock-raast://pay/${providerRef}?am=${input.amountMinor}`, expiresAt };
  }

  async getStatus(providerRef: string): Promise<ProviderOutcome> {
    const c = this.charges.get(providerRef);
    const base = { providerEventId: null, providerRef, amountMinor: c?.amountMinor ?? null, occurredAt: new Date() };
    if (!c) return { ...base, kind: 'failed', reason: 'unknown_charge' };
    if (c.state === 'pending' && c.autoScenario === 'auto_confirm') c.state = 'confirmed';
    if (c.state === 'pending' && c.autoScenario === 'auto_fail') c.state = 'failed';
    const kind = c.state === 'confirmed' ? 'confirmed' : c.state === 'failed' ? 'failed' : (c.state === 'expired' || c.state === 'cancelled') ? 'expired' : 'pending';
    return { ...base, kind };
  }

  async cancel(providerRef: string): Promise<void> {
    const c = this.charges.get(providerRef);
    if (c && c.state === 'pending') c.state = 'cancelled';
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const c = this.charges.get(input.providerRef);
    if (!c || c.state !== 'confirmed') return { status: 'failed', providerRefundRef: null, reason: 'charge_not_confirmed' };
    const prior = this.refunds.get(`${input.providerRef}:${input.refundId}`);
    if (prior) return { status: prior.status, providerRefundRef: prior.ref };
    const status: RefundResult['status'] = /mock:fail/.test(input.reason) ? 'failed' : /mock:pending/.test(input.reason) ? 'pending' : 'succeeded';
    const r: MockRefund = { refundId: input.refundId, amountMinor: input.amountMinor, status, ref: `mockrf_${randomUUID()}` };
    this.refunds.set(`${input.providerRef}:${input.refundId}`, r);
    return { status, providerRefundRef: r.ref, reason: status === 'failed' ? 'mock_refund_declined' : null };
  }

  async getRefundStatus(providerRef: string, refundId: string): Promise<ProviderOutcome | null> {
    const r = this.refunds.get(`${providerRef}:${refundId}`);
    if (!r || r.status === 'pending') return null;
    return { providerEventId: null, providerRef, kind: r.status === 'succeeded' ? 'refund_succeeded' : 'refund_failed', amountMinor: r.amountMinor, refundId, providerRefundRef: r.ref, occurredAt: new Date() };
  }

  // ── test / demo controls ────────────────────────────────────────────────────────────────────────────────────────
  simulate(providerRef: string, scenario: MockScenario): void {
    const c = this.charges.get(providerRef);
    if (!c) throw new Error(`mock charge ${providerRef} not found`);
    c.state = scenario === 'confirm' ? 'confirmed' : scenario === 'fail' ? 'failed' : 'expired';
  }
  finishRefund(providerRef: string, refundId: string, ok = true): void {
    const r = this.refunds.get(`${providerRef}:${refundId}`);
    if (r) r.status = ok ? 'succeeded' : 'failed';
  }

  /** A webhook exactly as the provider would send it: JSON body + `x-mock-signature: t=<unix>,v1=<hmac>`. */
  buildWebhook(o: {
    kind: ProviderOutcome['kind']; providerRef: string; amountMinor?: number | null; eventId?: string; at?: Date;
    refundId?: string | null; badSignature?: boolean; tamperBodyAfterSigning?: boolean;
  }): { body: Buffer; headers: Record<string, string> } {
    const at = o.at ?? new Date();
    const payload = {
      id: o.eventId ?? `evt_${randomUUID()}`, type: o.kind, charge: o.providerRef, amount_minor: o.amountMinor ?? null,
      refund_id: o.refundId ?? null, created: Math.floor(at.getTime() / 1000),
    };
    let body = Buffer.from(JSON.stringify(payload));
    const t = Math.floor(at.getTime() / 1000);
    const sig = o.badSignature ? 'deadbeef'.repeat(8) : this.sign(t, body);
    if (o.tamperBodyAfterSigning) body = Buffer.from(JSON.stringify({ ...payload, amount_minor: (payload.amount_minor ?? 0) + 1 }));
    return { body, headers: { 'x-mock-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' } };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): ProviderOutcome {
    const raw = headers['x-mock-signature'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const m = typeof header === 'string' ? /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header) : null;
    if (!m) throw new WebhookSignatureError('Missing or malformed signature');
    const t = Number(m[1]);
    const expected = Buffer.from(this.sign(t, rawBody), 'hex');
    const given = Buffer.from(m[2], 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookSignatureError();
    // the signature is valid; only now look at the timestamp (so an attacker learns nothing about the window)
    if (Math.abs(now.getTime() / 1000 - t) > MOCK_REPLAY_WINDOW_SECONDS) throw new WebhookReplayError();
    let p: any;
    try { p = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookSignatureError('Unparseable body'); }
    const amount = p.amount_minor;
    return {
      providerEventId: String(p.id), providerRef: String(p.charge), kind: p.type,
      amountMinor: Number.isSafeInteger(amount) ? amount : null, refundId: p.refund_id ?? null,
      occurredAt: new Date(Number(p.created) * 1000),
    };
  }

  private sign(t: number, body: Buffer): string {
    return createHmac('sha256', this.opts.webhookSecret).update(`${t}.`).update(body).digest('hex');
  }
}
