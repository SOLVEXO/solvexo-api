/* eslint-disable prettier/prettier */
/**
 * BlueEx mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX. UNVERIFIED.
 * We do not have BlueEx's API documentation: the hosts below are placeholders (.invalid never resolves), the auth
 * scheme is a guess, and the request/response shape is the generic placeholder in ./placeholder-mapping.ts. Nothing
 * here is courier-confirmed. Open questions: docs/courier-open-questions.md.
 */
import { basicAuth, placeholderMapping } from './placeholder-mapping';

export const BLUEEX_MAPPING = placeholderMapping({
  key: 'blueex',
  label: 'BlueEx',
  sandboxBase: 'https://UNVERIFIED-blueex-sandbox.invalid/api',
  liveBase: 'https://UNVERIFIED-blueex-live.invalid/api',
  authHeaders: (ctx) => ({ Authorization: basicAuth(ctx.credentials.username, ctx.credentials.password) }),
});
