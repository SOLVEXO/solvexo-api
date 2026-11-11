/* eslint-disable prettier/prettier */
/**
 * HARD LOCK on production filing with FBR (platform AND store). Only the FBR sandbox may be used.
 *
 * `assertProductionAllowed()` returns false, always, in this build. It is checked in three independent places so that no single
 * mistake can unlock it: (1) the settings services refuse `mode = production`, (2) the sending code holds any record whose mode is
 * production, (3) the HTTP client itself refuses to call a production URL. No production token is read, stored or requested.
 *
 * It is only replaced when the compliance work (relevant legal verification + sandbox test + Super Admin approval) exists.
 */
export const PRODUCTION_LOCKED_MESSAGE =
  'Live (production) filing with FBR is locked. It stays locked until the tax rules are verified, the sandbox test has passed and a Super Admin has approved it.';

export function assertProductionAllowed(): boolean {
  return false;
}
