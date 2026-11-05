/* eslint-disable prettier/prettier */
/**
 * TCS mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX. UNVERIFIED.
 * We do not have TCS's API documentation: the hosts below are placeholders (.invalid never resolves), the auth
 * scheme is a guess, and the request/response shape is the generic placeholder in ./placeholder-mapping.ts. Nothing
 * here is courier-confirmed. Open questions: docs/courier-open-questions.md.
 */
import { basicAuth, placeholderMapping } from './placeholder-mapping';

export const TCS_MAPPING = placeholderMapping({
  key: 'tcs',
  label: 'TCS',
  sandboxBase: 'https://UNVERIFIED-tcs-sandbox.invalid/api',
  liveBase: 'https://UNVERIFIED-tcs-live.invalid/api',
  authHeaders: (ctx) => ({ Authorization: basicAuth(ctx.credentials.username, ctx.credentials.password) }),
});
