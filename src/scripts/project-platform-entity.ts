/**
 * Phase 1: copies Admin → Settings → Tax (legal name, NTN/STRN, authority, address) into `platform_legal_entities` and
 * `platform_tax_registrations`, for visibility. The ledger itself reads the settings directly and does not need this.
 *
 * It only READS the tax settings. Safe by default: a dry run that prints the projection and writes nothing; pass `--apply` to write.
 * Idempotent. Does not boot the Nest app (no cron starts).
 *
 * Usage:  npx ts-node -r tsconfig-paths/register src/scripts/project-platform-entity.ts [--apply]
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { PlatformEntityService } from '../platform-tax/platform-entity.service';
import { PlatformTaxSettings, PlatformTaxSettingsSchema } from '../platform-tax/schemas/platform-tax-settings.schema';
import { PlatformTaxRule, PlatformTaxRuleSchema } from '../platform-tax/schemas/platform-tax-rule.schema';
import { PlatformLegalEntity, PlatformLegalEntitySchema } from '../platform-tax/schemas/platform-legal-entity.schema';
import { PlatformTaxRegistration, PlatformTaxRegistrationSchema } from '../platform-tax/schemas/platform-tax-registration.schema';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const m = (name: string, schema: mongoose.Schema) => (mongoose.models[name] ?? mongoose.model(name, schema)) as any;
  const svc = new PlatformEntityService(
    m(PlatformTaxSettings.name, PlatformTaxSettingsSchema), m(PlatformTaxRule.name, PlatformTaxRuleSchema),
    m(PlatformLegalEntity.name, PlatformLegalEntitySchema), m(PlatformTaxRegistration.name, PlatformTaxRegistrationSchema),
  );
  const res = await svc.persistProjection(!apply);
  console.log(JSON.stringify({ dryRun: !apply, wrote: res.wrote, entity: res.entity }, null, 2));
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
