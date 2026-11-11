/* eslint-disable prettier/prettier */
// Version label of each authority adapter. A change here means the filing code changed, so a compliance state that was reached
// with the old version is no longer trusted (see PlatformComplianceService). Bump it whenever an adapter's behaviour changes.
export const ADAPTER_VERSIONS: Record<string, string> = {
  PK_FBR: 'pral-di-1.12/2026-11',
};
