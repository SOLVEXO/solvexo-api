/* eslint-disable prettier/prettier */
/**
 * Swyft Logistics mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX. UNVERIFIED.
 * We do not have Swyft Logistics's API documentation: the hosts below are placeholders (.invalid never resolves), the auth
 * scheme is a guess, and the request/response shape is the generic placeholder in ./placeholder-mapping.ts. Nothing
 * here is courier-confirmed. Open questions: docs/courier-open-questions.md.
 */
import { placeholderMapping } from './placeholder-mapping';

export const SWYFT_MAPPING = placeholderMapping({
  key: 'swyft',
  label: 'Swyft Logistics',
  sandboxBase: 'https://UNVERIFIED-swyft-sandbox.invalid/api',
  liveBase: 'https://UNVERIFIED-swyft-live.invalid/api',
  authHeaders: (ctx) => ({ 'X-Api-Key': ctx.credentials.apiKey }),
});
