/* eslint-disable prettier/prettier */
// Types only (no behaviour). Shared vocabulary of Solvexo's own legal-invoice ledger.

/** Which Solvexo charge a ledger row mirrors. */
export type LedgerSourceType = 'plan_invoice' | 'addon_charge' | 'fee_bill' | 'pos_plan' | 'promotion' | 'store_app';

export const LEDGER_SOURCE_TYPES: LedgerSourceType[] = ['plan_invoice', 'addon_charge', 'fee_bill', 'pos_plan', 'promotion', 'store_app'];

/** What a tax rule says about a supply. `unknown` = nobody has decided: the invoice is held, never treated as zero. */
export type TaxTreatment = 'taxable' | 'zero_rated' | 'exempt' | 'out_of_scope' | 'unknown';

export type RuleVerificationState = 'unverified' | 'legacy_confirmed' | 'verified';

/** Why a row can or cannot go to a tax authority. Never worded by customer nationality. */
export type RoutingReason = 'ok' | 'no_registration' | 'rule_unverified' | 'rule_unknown_treatment' | 'tax_unknown' | 'adapter_missing';

export type LedgerWarning = 'foreign_tax_without_registration' | 'charged_tax_differs_from_rule' | 'customer_country_unknown';

/** The authority adapter a registration is filed through. Only PK_FBR has an adapter today. */
export type TaxAuthorityKey = 'PK_FBR' | 'PK_SRB' | 'PK_PRA' | 'PK_KPRA' | 'PK_BRA' | 'OTHER';
