/* eslint-disable prettier/prettier */
/**
 * Daewoo FastEx mapping — VERIFY AGAINST OFFICIAL DOC + SANDBOX. UNVERIFIED.
 * We do not have Daewoo FastEx's API documentation: the hosts below are placeholders (.invalid never resolves), the auth
 * scheme is a guess, and the request/response shape is the generic placeholder in ./placeholder-mapping.ts. Nothing
 * here is courier-confirmed. Open questions: docs/courier-open-questions.md.
 */
import { basicAuth, placeholderMapping } from './placeholder-mapping';

export const DAEWOO_FASTEX_MAPPING = placeholderMapping({
  key: 'daewoo_fastex',
  label: 'Daewoo FastEx',
  sandboxBase: 'https://UNVERIFIED-daewoo-fastex-sandbox.invalid/api',
  liveBase: 'https://UNVERIFIED-daewoo-fastex-live.invalid/api',
  authHeaders: (ctx) => ({ Authorization: basicAuth(ctx.credentials.username, ctx.credentials.password) }),
});
