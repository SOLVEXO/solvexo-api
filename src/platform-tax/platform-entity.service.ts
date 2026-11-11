/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PlatformTaxSettings, PlatformTaxSettingsDocument } from './schemas/platform-tax-settings.schema';
import { PlatformTaxRule, PlatformTaxRuleDocument } from './schemas/platform-tax-rule.schema';
import { PlatformLegalEntity, PlatformLegalEntityDocument } from './schemas/platform-legal-entity.schema';
import { PlatformTaxRegistration, PlatformTaxRegistrationDocument } from './schemas/platform-tax-registration.schema';
import type { EntityView, RuleView } from './platform-tax-determination.service';
import type { TaxTreatment } from '../tax-core/legal-invoice.types';

export const PLATFORM_ENTITY_KEY = 'solvexo-platform';
export const PLAN_SUPPLY_TYPE = 'saas_subscription';

const AUTHORITY_KEY: Record<string, string> = { FBR: 'PK_FBR', SRB: 'PK_SRB', PRA: 'PK_PRA', KPRA: 'PK_KPRA', BRA: 'PK_BRA', OTHER: 'OTHER' };

/** Pure: Admin → Settings → Tax (as stored) → the entity + registrations the ledger reasons about. Reads only. */
export function projectEntity(settings: any): EntityView {
  const s = settings ?? {};
  const authority = AUTHORITY_KEY[String(s.authority ?? 'OTHER')] ?? 'OTHER';
  // FBR / SRB / PRA / KPRA / BRA are all Pakistani authorities; "OTHER" says nothing about the country.
  const country = authority === 'OTHER' ? null : 'PK';
  const registrations: EntityView['registrations'] = [];
  if (country && String(s.ntn ?? '').trim()) registrations.push({ country, type: 'NTN', number: String(s.ntn).trim(), authority });
  if (country && String(s.strn ?? '').trim()) registrations.push({ country, type: 'STRN', number: String(s.strn).trim(), authority });
  return { entityKey: PLATFORM_ENTITY_KEY, country, registrations };
}

/** Pure: the legacy country rates of the settings page as rules. A 0% rate is NOT a zero-rating decision, so it stays `unknown`. */
export function projectLegacyRules(settings: any): RuleView[] {
  return ((settings?.rates ?? []) as any[]).map((r) => ({
    country: String(r.country ?? '').toUpperCase(),
    supplyType: PLAN_SUPPLY_TYPE,
    treatment: (Number(r.ratePercent) > 0 ? 'taxable' : 'unknown') as TaxTreatment,
    ratePercent: Number(r.ratePercent) > 0 ? Number(r.ratePercent) : null,
    state: r.status === 'confirmed' ? ('legacy_confirmed' as const) : ('unverified' as const),
  }));
}

@Injectable()
export class PlatformEntityService {
  constructor(
    @InjectModel(PlatformTaxSettings.name) private readonly settingsModel: Model<PlatformTaxSettingsDocument>,
    @InjectModel(PlatformTaxRule.name) private readonly ruleModel: Model<PlatformTaxRuleDocument>,
    @InjectModel(PlatformLegalEntity.name) private readonly entityModel: Model<PlatformLegalEntityDocument>,
    @InjectModel(PlatformTaxRegistration.name) private readonly registrationModel: Model<PlatformTaxRegistrationDocument>,
  ) {}

  /** Entity + rules the ledger uses. READS the settings (never writes them); stored `platform_tax_rules` rows add verified rules if a person made any. */
  async load(): Promise<{ entity: EntityView; rules: RuleView[]; settings: any }> {
    const settings = await this.settingsModel.findOne({ key: 'platform' }).lean();
    const entity = projectEntity(settings);
    const stored = await this.ruleModel.find({ entityKey: PLATFORM_ENTITY_KEY }).lean();
    const rules: RuleView[] = [
      ...projectLegacyRules(settings),
      ...stored.map((r: any) => ({
        country: String(r.country).toUpperCase(), supplyType: r.supplyType, treatment: r.treatment as TaxTreatment,
        ratePercent: r.ratePercent ?? null, state: r.verification?.state ?? 'unverified',
      })),
    ];
    return { entity, rules, settings };
  }

  /** Copies the projection into `platform_legal_entities` / `platform_tax_registrations` (visibility only; the ledger does not need it). Idempotent. */
  async persistProjection(dryRun: boolean): Promise<{ entity: EntityView; wrote: boolean }> {
    const { entity, settings } = await this.load();
    if (dryRun) return { entity, wrote: false };
    await this.entityModel.updateOne(
      { entityKey: entity.entityKey },
      { $set: { legalName: settings?.legalName ?? '', address: settings?.address ?? '', country: entity.country, source: 'settings_projection' }, $setOnInsert: { entityKey: entity.entityKey } },
      { upsert: true },
    );
    for (const r of entity.registrations) {
      await this.registrationModel.updateOne(
        { entityKey: entity.entityKey, country: r.country, type: r.type },
        { $set: { number: r.number, authority: r.authority }, $setOnInsert: { entityKey: entity.entityKey, country: r.country, type: r.type } },
        { upsert: true },
      );
    }
    return { entity, wrote: true };
  }
}
