/* eslint-disable prettier/prettier */
// Types only. The compliance state machine itself arrives in Phase 4; nothing here unlocks anything.

export type ComplianceState = 'unsupported' | 'researched' | 'rules_verified' | 'sandbox_tested' | 'live_approved';

export const COMPLIANCE_ORDER: ComplianceState[] = ['unsupported', 'researched', 'rules_verified', 'sandbox_tested', 'live_approved'];
