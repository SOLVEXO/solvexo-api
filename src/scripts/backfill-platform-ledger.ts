/**
 * Phase 1: copies every paid Solvexo charge into the read-only shadow ledger (`platform_invoices`).
 *
 * It only READS billing data and writes only `platform_invoices` (and, with --entity, the two entity collections). It does not boot the Nest
 * app (so no cron job starts) and it cannot file anything with a tax authority: the ledger has no connection to the FBR module.
 *
 * Safe by default: a DRY RUN that counts what it would create and writes nothing. Pass `--apply` to write; a real write also needs
 * PLATFORM_LEDGER_ENABLED=true (same switch as the cron). Idempotent: running it again creates 0 new rows.
 *
 * Usage (dry run):  npx ts-node -r tsconfig-paths/register src/scripts/backfill-platform-ledger.ts
 *       (write):    PLATFORM_LEDGER_ENABLED=true npx ts-node -r tsconfig-paths/register src/scripts/backfill-platform-ledger.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { PlatformLedgerService } from '../platform-tax/platform-ledger.service';
import { PlatformEntityService } from '../platform-tax/platform-entity.service';
import { PlatformInvoice, PlatformInvoiceSchema } from '../platform-tax/schemas/platform-invoice.schema';
import { PlatformTaxSettings, PlatformTaxSettingsSchema } from '../platform-tax/schemas/platform-tax-settings.schema';
import { PlatformTaxRule, PlatformTaxRuleSchema } from '../platform-tax/schemas/platform-tax-rule.schema';
import { PlatformLegalEntity, PlatformLegalEntitySchema } from '../platform-tax/schemas/platform-legal-entity.schema';
import { PlatformTaxRegistration, PlatformTaxRegistrationSchema } from '../platform-tax/schemas/platform-tax-registration.schema';
import { PlatformTaxRecord, PlatformTaxRecordSchema } from '../platform-tax/schemas/platform-tax-record.schema';
import { PlatformPlanInvoice, PlatformPlanInvoiceSchema } from '../platform-plans/schemas/platform-plan-invoice.schema';
import { PlatformAddonPurchase, PlatformAddonPurchaseSchema } from '../platform-plans/schemas/platform-addon-purchase.schema';
import { TransactionFeeBill, TransactionFeeBillSchema } from '../platform-plans/schemas/transaction-fee-bill.schema';

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);

  const m = <T>(name: string, schema: mongoose.Schema) => (mongoose.models[name] ?? mongoose.model(name, schema)) as unknown as mongoose.Model<T>;
  const entities = new PlatformEntityService(
    m(PlatformTaxSettings.name, PlatformTaxSettingsSchema) as any, m(PlatformTaxRule.name, PlatformTaxRuleSchema) as any,
    m(PlatformLegalEntity.name, PlatformLegalEntitySchema) as any, m(PlatformTaxRegistration.name, PlatformTaxRegistrationSchema) as any,
  );
  // Only the store collection is read (for the store's country); a plain model on the same collection is enough.
  const storeModel = mongoose.models.Store ?? mongoose.model('Store', new mongoose.Schema({}, { strict: false, collection: 'stores' }));
  const ledger = new PlatformLedgerService(
    { repositories: { storeModel } } as any, entities,
    m(PlatformInvoice.name, PlatformInvoiceSchema) as any, m(PlatformPlanInvoice.name, PlatformPlanInvoiceSchema) as any,
    m(PlatformAddonPurchase.name, PlatformAddonPurchaseSchema) as any, m(TransactionFeeBill.name, TransactionFeeBillSchema) as any,
    m(PlatformTaxRecord.name, PlatformTaxRecordSchema) as any,
  );

  if (apply && !ledger.isEnabled()) {
    console.error('Refusing to write: PLATFORM_LEDGER_ENABLED is not "true". Running a dry run instead.');
  }
  const stats = await ledger.sync({ dryRun: !apply || !ledger.isEnabled() });
  console.log(JSON.stringify(stats, null, 2));
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
