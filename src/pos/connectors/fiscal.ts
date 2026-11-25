/* eslint-disable prettier/prettier */
/**
 * G5.5 — FISCAL (FBR) provider (pending decision: route not chosen — PRAL direct or a licensed integrator). A provider fiscalises one tax invoice or
 * credit note and answers the fiscal invoice number + the QR payload to print. Per-store flag `connectors.fiscal` (OFF by default). Only the MOCK exists
 * (dev + tests); the real adapters are typed TODOs that throw "not configured". NO PRAL / integrator field, endpoint or certification step is guessed here —
 * see docs/pos-blueprint/FBR_INTEGRATION_NEEDS.md for exactly what must come in, and where it plugs in.
 */
export interface FiscalDocumentInput {
  storeId: string;
  documentType: 'invoice' | 'credit_note';
  documentNumber: string;            // INV-000123 / CN-000004 (our own, immutable)
  againstInvoiceNumber: string | null; // credit notes: the invoice they reverse
  issuedAt: Date;
  currency: string; currencyExponent: number;
  netMinor: number; taxMinor: number; totalMinor: number;
  seller: { ntn: string | null; strn: string | null; legalName: string | null } | null;
  lines: Array<{ name: string; qty: number; hsCode: string | null; netMinor: number; taxMinor: number }>;
}
/** G6.1: one line the till prints / shows exactly as given (label and value chosen by the provider adapter, never by the app). */
export interface FiscalDisplayLine { label: string; value: string }
/**
 * What a provider answers for one attempt (see docs/pos-blueprint/FISCAL_CONTRACT.md):
 * - `confirmed` — accepted; `fiscalInvoiceNumber` (+ `qrPayload`) and the `displayLines` to print;
 * - `pending`   — not fiscalised yet and SAFE to send again (nothing reached the authority / a temporary outage): the sweep retries;
 * - `failed`    — not fiscalised and NOT safe to resend automatically (outcome unknown, auth error, locked …): stops, needs the owner;
 * - `rejected`  — the authority refused the document (validation): final, needs correction.
 * `message` is shown to the cashier / owner for failed and rejected. `logoUrl` is an optional authority logo printed next to the QR.
 */
export interface FiscalResult {
  status: 'confirmed' | 'rejected' | 'pending' | 'failed';
  fiscalInvoiceNumber: string | null;
  qrPayload: string | null;
  message?: string;
  displayLines?: FiscalDisplayLine[];
  logoUrl?: string | null;
}
export interface FiscalProvider { readonly key: string; readonly testMode: boolean; fiscalise(doc: FiscalDocumentInput): Promise<FiscalResult> }

export class FiscalNotConfiguredError extends Error {
  constructor(readonly key: string) { super(`Fiscal provider "${key}" is not configured — see docs/pos-blueprint/FBR_INTEGRATION_NEEDS.md`); }
}

/**
 * Dev / tests: confirms with a deterministic number and its own display lines. `MOCK_FISCAL_MODE` picks another outcome so every status can be
 * exercised end to end: `down` (pending → retried), `fail` (failed: not resent), `reject` (rejected). `MOCK_FISCAL_DOWN=true` = `down` (G5.5).
 */
export class MockFiscalProvider implements FiscalProvider {
  readonly key = 'mock';
  readonly testMode = true;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async fiscalise(d: FiscalDocumentInput): Promise<FiscalResult> {
    const mode = this.env.MOCK_FISCAL_DOWN === 'true' ? 'down' : (this.env.MOCK_FISCAL_MODE ?? '').toLowerCase();
    if (mode === 'down') return { status: 'pending', fiscalInvoiceNumber: null, qrPayload: null, message: 'Mock fiscal service unavailable' };
    if (mode === 'fail') return { status: 'failed', fiscalInvoiceNumber: null, qrPayload: null, message: 'Mock: the outcome is unknown, so it was not sent again. Check it, then retry.' };
    if (mode === 'reject') return { status: 'rejected', fiscalInvoiceNumber: null, qrPayload: null, message: 'Mock: the tax authority refused this document (invalid item code).' };
    const n = `MOCK-FBR-${d.documentType === 'invoice' ? 'I' : 'C'}-${d.documentNumber}`;
    return {
      status: 'confirmed', fiscalInvoiceNumber: n, qrPayload: `mock-fiscal:${n}:${d.totalMinor}`,
      displayLines: [{ label: 'Mock fiscal no.', value: n }, { label: 'Mode', value: 'TEST — not filed' }],
    };
  }
}

/** The real routes — TODO until the documents in FBR_INTEGRATION_NEEDS.md arrive. */
export class NotConfiguredFiscalProvider implements FiscalProvider {
  readonly testMode = false;
  constructor(readonly key: 'pral' | 'integrator' | string) {}
  async fiscalise(): Promise<FiscalResult> { throw new FiscalNotConfiguredError(this.key); }
}

/** `FISCAL_PROVIDER` picks the provider; the mock outside production; anything else is not configured yet. */
export function fiscalProviderFor(env: NodeJS.ProcessEnv = process.env): FiscalProvider | null {
  const key = (env.FISCAL_PROVIDER || (env.NODE_ENV === 'production' ? '' : 'mock')).toLowerCase();
  if (!key) return null;
  return key === 'mock' && env.NODE_ENV !== 'production' ? new MockFiscalProvider(env) : new NotConfiguredFiscalProvider(key);
}
