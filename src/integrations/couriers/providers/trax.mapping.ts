/* eslint-disable prettier/prettier */
/**
 * Trax mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX. UNVERIFIED.
 * We do not have Trax's API documentation: the hosts below are placeholders (.invalid never resolves), the auth
 * scheme is a guess, and the request/response shape is the generic placeholder in ./placeholder-mapping.ts. Nothing
 * here is courier-confirmed. Open questions: docs/courier-open-questions.md.
 */
import { placeholderMapping } from './placeholder-mapping';

export const TRAX_MAPPING = placeholderMapping({
  key: 'trax',
  label: 'Trax',
  sandboxBase: 'https://UNVERIFIED-trax-sandbox.invalid/api',
  liveBase: 'https://UNVERIFIED-trax-live.invalid/api',
  authHeaders: (ctx) => ({ 'X-Api-Key': ctx.credentials.apiKey }),
});
