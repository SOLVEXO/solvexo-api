/* eslint-disable prettier/prettier */
// What the e-invoice engine needs from ANY tax authority. Nothing here knows about Pakistan or FBR.

export type AuthorityMode = 'sandbox' | 'production';

/** The answer of an authority, already interpreted. Mirrors the facts the engine acts on, nothing country-specific. */
export interface AuthorityResult {
  ok: boolean;
  invoiceNumber: string | null;
  dated: string | null;
  errors: { code: string | null; message: string; itemSNo?: string | null }[];
  /** True ONLY when the request provably never reached the authority (so sending again cannot create a duplicate). */
  retryable: boolean;
  notSent: boolean;
  /** The request may have arrived (timeout / reset / 5xx / unreadable answer): never resend by itself. */
  unknownOutcome: boolean;
  authError: boolean;
  /** Production filing is locked: nothing was sent. */
  locked?: boolean;
}

export interface AuthorityCall { result: AuthorityResult; payload: Record<string, unknown> }

export interface TaxAuthorityAdapter {
  /** Registry key, e.g. 'PK_FBR'. Matches `PlatformTaxRegistration.authority`. */
  readonly key: string;
  /** Files an invoice. In production this must refuse while the production lock is on. */
  post(input: any, mode: AuthorityMode, token: string): Promise<AuthorityCall>;
  /** Asks the authority whether an invoice would be accepted, without filing it. */
  validate(input: any, mode: AuthorityMode, token: string): Promise<AuthorityCall>;
  /** Text printed in the invoice QR code for an accepted invoice number. */
  qrFor(invoiceNumber: string): string;
  /** Format check of an invoice number a person typed in after checking the authority's portal. */
  isValidInvoiceNumber(invoiceNumber: string): boolean;
}
