/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import type { LedgerWarning, RoutingReason, RuleVerificationState, TaxTreatment } from '../tax-core/legal-invoice.types';
import type { TaxLine } from '../tax-core/tax-line.types';

export interface EntityView {
  entityKey: string;
  country: string | null;
  registrations: Array<{ country: string; type: string; number: string; authority: string }>;
}
export interface RuleView {
  country: string;
  supplyType: string;
  treatment: TaxTreatment;
  ratePercent: number | null;
  state: RuleVerificationState;
}
export interface DetermineInput {
  entity: EntityView;
  customerCountry: string | null;
  supplyType: string;
  rules: RuleView[];
  taxKnown: boolean;
  chargedTaxUSD: number | null;
  taxLines: TaxLine[] | null;
}
export interface DetermineResult {
  routing: { authority: string | null; eligible: boolean; reason: RoutingReason };
  determination: { treatment: TaxTreatment; ratePercent: number | null; ruleState: RuleVerificationState | null };
  warnings: LedgerWarning[];
}

const STATE_RANK: Record<RuleVerificationState, number> = { verified: 3, legacy_confirmed: 2, unverified: 1 };
/** Adapters that exist today. A registration filed through any other authority is never eligible. */
const ADAPTERS_AVAILABLE = new Set(['PK_FBR']);

/**
 * COMPARISON ONLY. Says what treatment the platform's rules give a supply and whether the row could ever go to an authority.
 * It never changes what was charged, and it never decides by the customer's nationality: the issuer's registration and a VERIFIED rule decide.
 * With no verified rule a row is held (`rule_unverified`), not skipped and not treated as zero.
 */
export function determine(input: DetermineInput): DetermineResult {
  const { entity, customerCountry, supplyType, rules, taxKnown, chargedTaxUSD, taxLines } = input;

  const own = entity.registrations.filter((r) => r.country === entity.country && String(r.number ?? '').trim() !== '');
  const reg = own.find((r) => ADAPTERS_AVAILABLE.has(r.authority)) ?? own[0] ?? null;
  const authority = reg ? reg.authority : null;

  const candidates = customerCountry ? rules.filter((r) => r.country === customerCountry && r.supplyType === supplyType) : [];
  const rule = candidates.sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state])[0] ?? null;
  const determination = rule
    ? { treatment: rule.treatment, ratePercent: rule.ratePercent, ruleState: rule.state }
    : { treatment: 'unknown' as TaxTreatment, ratePercent: null, ruleState: null };

  let reason: RoutingReason;
  if (!taxKnown) reason = 'tax_unknown';
  else if (!reg) reason = 'no_registration';
  else if (!rule || rule.state !== 'verified') reason = 'rule_unverified';
  else if (rule.treatment === 'unknown') reason = 'rule_unknown_treatment';
  else if (!ADAPTERS_AVAILABLE.has(reg.authority)) reason = 'adapter_missing';
  else reason = 'ok';

  const warnings: LedgerWarning[] = [];
  if (!customerCountry) warnings.push('customer_country_unknown');
  if (typeof chargedTaxUSD === 'number' && chargedTaxUSD > 0) {
    const registeredIn = new Set(entity.registrations.filter((r) => String(r.number ?? '').trim() !== '').map((r) => r.country));
    const chargedIn = (taxLines ?? []).map((l) => l.country ?? customerCountry).filter((c): c is string => !!c);
    if (chargedIn.some((c) => !registeredIn.has(c))) warnings.push('foreign_tax_without_registration');
    if (rule && rule.treatment === 'taxable' && typeof rule.ratePercent === 'number') {
      const rated = (taxLines ?? []).find((l) => typeof l.ratePercent === 'number');
      if (rated && Math.abs((rated.ratePercent as number) - rule.ratePercent) > 0.01) warnings.push('charged_tax_differs_from_rule');
    }
  }

  return { routing: { authority, eligible: reason === 'ok', reason }, determination, warnings };
}

@Injectable()
export class PlatformTaxDeterminationService {
  determine(input: DetermineInput): DetermineResult { return determine(input); }
}
