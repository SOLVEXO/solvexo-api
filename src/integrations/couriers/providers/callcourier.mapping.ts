/* eslint-disable prettier/prettier */
/**
 * CallCourier mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX. UNVERIFIED.
 * We do not have CallCourier's API documentation: the hosts below are placeholders (.invalid never resolves), the auth
 * scheme is a guess, and the request/response shape is the generic placeholder in ./placeholder-mapping.ts. Nothing
 * here is courier-confirmed. Open questions: docs/courier-open-questions.md.
 */
import { basicAuth, placeholderMapping } from './placeholder-mapping';

export const CALLCOURIER_MAPPING = placeholderMapping({
  key: 'callcourier',
  label: 'CallCourier',
  sandboxBase: 'https://UNVERIFIED-callcourier-sandbox.invalid/api',
  liveBase: 'https://UNVERIFIED-callcourier-live.invalid/api',
  authHeaders: (ctx) => ({ Authorization: basicAuth(ctx.credentials.username, ctx.credentials.password) }),
});
