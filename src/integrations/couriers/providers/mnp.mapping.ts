/* eslint-disable prettier/prettier */
/**
 * M&P (Muller & Phipps) mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX. UNVERIFIED.
 * We do not have M&P (Muller & Phipps)'s API documentation: the hosts below are placeholders (.invalid never resolves), the auth
 * scheme is a guess, and the request/response shape is the generic placeholder in ./placeholder-mapping.ts. Nothing
 * here is courier-confirmed. Open questions: docs/courier-open-questions.md.
 */
import { basicAuth, placeholderMapping } from './placeholder-mapping';

export const MNP_MAPPING = placeholderMapping({
  key: 'mnp',
  label: 'M&P (Muller & Phipps)',
  sandboxBase: 'https://UNVERIFIED-mnp-sandbox.invalid/api',
  liveBase: 'https://UNVERIFIED-mnp-live.invalid/api',
  authHeaders: (ctx) => ({ Authorization: basicAuth(ctx.credentials.username, ctx.credentials.password) }),
});
