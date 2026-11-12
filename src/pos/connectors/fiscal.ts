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
export interface FiscalResult { status: 'confirmed' | 'rejected' | 'pending'; fiscalInvoiceNumber: string | null; qrPayload: string | null; message?: string }
export interface FiscalProvider { readonly key: string; readonly testMode: boolean; fiscalise(doc: FiscalDocumentInput): Promise<FiscalResult> }

export class FiscalNotConfiguredError extends Error {
  constructor(readonly key: string) { super(`Fiscal provider "${key}" is not configured — see docs/pos-blueprint/FBR_INTEGRATION_NEEDS.md`); }
}

/** Dev / tests: confirms with a deterministic number; `MOCK_FISCAL_DOWN=true` simulates an outage (pending → retried). */
export class MockFiscalProvider implements FiscalProvider {
  readonly key = 'mock';
  readonly testMode = true;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async fiscalise(d: FiscalDocumentInput): Promise<FiscalResult> {
    if (this.env.MOCK_FISCAL_DOWN === 'true') return { status: 'pending', fiscalInvoiceNumber: null, qrPayload: null, message: 'Mock fiscal service unavailable' };
    const n = `MOCK-FBR-${d.documentType === 'invoice' ? 'I' : 'C'}-${d.documentNumber}`;
    return { status: 'confirmed', fiscalInvoiceNumber: n, qrPayload: `mock-fiscal:${n}:${d.totalMinor}` };
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
