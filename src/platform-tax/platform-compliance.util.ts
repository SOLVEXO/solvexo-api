/* eslint-disable prettier/prettier */
// Pure rules of the compliance state machine. No database, no network, no clock.
import { createHash } from 'crypto';
import { COMPLIANCE_ORDER, ComplianceState } from '../tax-core/compliance.types';

export interface ComplianceSnapshot {
  registrationNumber: string | null;
  rulePackHash: string | null;
  adapterVersion: string | null;
  tokenFingerprint: string | null;
}

export const rank = (s: ComplianceState): number => COMPLIANCE_ORDER.indexOf(s);
export const minState = (a: ComplianceState, b: ComplianceState): ComplianceState => (rank(a) <= rank(b) ? a : b);

/** The only phrase that approves live filing: typed by a Super Admin, nothing else is accepted. */
export const LIVE_CONFIRMATION = 'APPROVE LIVE';

/** Stable fingerprint of the VERIFIED rules of one registration country: any change of country, supply, treatment or rate changes it. */
export function rulePackHash(rules: Array<{ country: string; supplyType: string; treatment: string; ratePercent: number | null }>): string {
  const lines = rules
    .map((r) => `${String(r.country).toUpperCase()}|${r.supplyType}|${r.treatment}|${r.ratePercent ?? ''}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Where the state must fall to when what it was reached with has changed. Never goes UP.
 *  - registration number or rule pack changed  -> back to 'researched' (the rules must be verified again);
 *  - adapter version changed, or the sandbox token is gone/different -> back to 'rules_verified' (it must be tested again).
 * Returns the unchanged state and no reason when nothing changed.
 */
export function reconcileState(state: ComplianceState, stored: ComplianceSnapshot, current: ComplianceSnapshot): { state: ComplianceState; reason: string | null } {
  if (rank(state) >= rank('rules_verified')) {
    if (stored.registrationNumber !== current.registrationNumber) return { state: minState(state, 'researched'), reason: 'The tax registration number changed. The rules must be verified again.' };
    if (stored.rulePackHash !== current.rulePackHash) return { state: minState(state, 'researched'), reason: 'The verified tax rules changed. They must be verified again.' };
  }
  if (rank(state) >= rank('sandbox_tested')) {
    if (stored.adapterVersion !== current.adapterVersion) return { state: minState(state, 'rules_verified'), reason: 'The filing code (adapter) version changed. It must be tested in the sandbox again.' };
    if (!current.tokenFingerprint) return { state: minState(state, 'rules_verified'), reason: 'No sandbox token is available any more. It must be tested in the sandbox again.' };
    if (stored.tokenFingerprint !== current.tokenFingerprint) return { state: minState(state, 'rules_verified'), reason: 'The sandbox token changed. It must be tested in the sandbox again.' };
  }
  return { state, reason: null };
}

/** Whether the compliance record alone would allow production filing. The hard production lock is a SEPARATE, unconditional switch. */
export function complianceAllowsProduction(state: ComplianceState): boolean { return state === 'live_approved'; }
