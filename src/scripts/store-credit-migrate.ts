/* eslint-disable no-console */
/**
 * Store-credit migration to the minor-unit ledger (option B). Always `--dry-run` first.
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/store-credit-migrate.ts up --dry-run
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/store-credit-migrate.ts up
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/store-credit-migrate.ts down [--dry-run] [--force-lose-activity]
 * Production order: STORE_CREDIT_LEDGER=migrating → up → check → STORE_CREDIT_LEDGER=new (see G3_STORE_CREDIT_LEDGER_PLAN.md). Safety = the G1b backfill's.
 */
import { MongoClient } from 'mongodb';
import { assertSafeTarget, migrateStoreCredit, migrateStoreCreditDown } from './store-credit-migrate.lib';

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flag = (n: string) => rest.includes(n);
  const uri = process.env.MONGO_URI;
  if (!uri || (mode !== 'up' && mode !== 'down')) { console.error('Usage: MONGO_URI=… store-credit-migrate.ts <up|down> [--dry-run] [--force-lose-activity] [--production --i-have-a-backup]'); process.exit(2); }
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db();
    assertSafeTarget(db.databaseName, { production: flag('--production'), iHaveABackup: flag('--i-have-a-backup') });
    const dryRun = flag('--dry-run');
    console.log(`[credit-migrate] ${mode}${dryRun ? ' (DRY RUN — nothing is written)' : ''} on database "${db.databaseName}"`);
    if (mode === 'up') {
      const r = await migrateStoreCredit(db, { dryRun });
      console.log(`[credit-migrate] legacy rows ${r.legacyRows} (already migrated ${r.alreadyMigrated}) · to migrate ${r.toMigrate} · ${dryRun ? 'would write' : 'written'}: entries ${r.entriesWritten}, lots ${r.lotsWritten}`);
      console.log(`[credit-migrate] spendable lots with a FUTURE expiry (kept with their expiry): ${r.futureExpiryLots} · expired / handled credit not carried over: ${r.expiredNotMigrated} · off-grid values rounded DOWN: ${r.offGrid.length}`);
      for (const [cur, v] of Object.entries(r.balancesByCurrency)) console.log(`[credit-migrate] ${cur}: ${v.customers} customer(s) with spendable credit, total ${v.totalMinor} minor units`);
      for (const o of r.offGrid.slice(0, 10)) console.log(`[credit-migrate]    off-grid: ${o.id} ${o.field}=${o.value} → ${o.roundedDownMinor} minor`);
      if (r.mismatches.length) { console.error(`[credit-migrate] SELF-CHECK FAILED for ${r.mismatches.length} customer(s):`, r.mismatches.slice(0, 5)); process.exitCode = 1; }
      else if (!dryRun) console.log('[credit-migrate] self-check OK: every customer\'s spendable balance equals the legacy one');
    } else {
      const d = await migrateStoreCreditDown(db, { dryRun, force: flag('--force-lose-activity') });
      console.log(`[credit-migrate] ${dryRun ? 'would remove' : 'removed'} ${d.entries} entries, ${d.lots} lots and un-marked ${d.unmarked} legacy rows (new-ledger activity of its own: ${d.ownActivity})`);
    }
  } finally { await client.close(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
