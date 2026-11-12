/* eslint-disable no-console */
/**
 * G1a backfill (reversible, dry-run first). Creates the pos_payments / pos_refunds records for sales that predate them and
 * copies the shift onto old sales.
 *
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g1a-backfill.ts up   --dry-run
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g1a-backfill.ts up
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g1a-backfill.ts down  --dry-run
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g1a-backfill.ts down
 *
 * Safety:
 *  - It does NOT load `.env` (unlike older scripts): MONGO_URI must be given explicitly on the command line.
 *  - It refuses a database whose name does not contain "dev" or "test" unless `--i-have-a-backup` is passed (production
 *    runs follow docs/deploy_runbook.md: mongodump first, dry-run, then run).
 *  - `up` is idempotent (unique indexes make a re-run a no-op); `down` removes ONLY records flagged `backfilled: true`.
 *  - `down` uses raw collection deletes, i.e. it needs a database user that may delete from the append-only collections.
 */
import { MongoClient } from 'mongodb';
import { backfillDown, backfillUp, COLLECTIONS } from './pos-g1a-backfill.lib';

async function main() {
  const [mode, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes('--dry-run');
  const uri = process.env.MONGO_URI;
  if (!uri || (mode !== 'up' && mode !== 'down')) {
    console.error('Usage: MONGO_URI=… pos-g1a-backfill.ts <up|down> [--dry-run] [--i-have-a-backup]');
    process.exit(2);
  }
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db();
    const looksDisposable = /dev|test/i.test(db.databaseName);
    if (!looksDisposable && !flags.includes('--i-have-a-backup')) {
      console.error(`Refusing to touch database "${db.databaseName}" — it does not look like a dev/test database. Take a mongodump, run with --dry-run, then pass --i-have-a-backup.`);
      process.exit(3);
    }
    console.log(`[g1a-backfill] ${mode}${dryRun ? ' (DRY RUN — nothing is written)' : ''} on database "${db.databaseName}"`);

    const before = {
      sales: await db.collection(COLLECTIONS.sales).countDocuments({}),
      payments: await db.collection(COLLECTIONS.payments).countDocuments({}),
      refunds: await db.collection(COLLECTIONS.refunds).countDocuments({}),
    };
    console.log('[g1a-backfill] row counts BEFORE:', before);

    const result = mode === 'up' ? await backfillUp(db, { dryRun }) : await backfillDown(db, { dryRun });
    console.log('[g1a-backfill] result:', result);

    const after = {
      sales: await db.collection(COLLECTIONS.sales).countDocuments({}),
      payments: await db.collection(COLLECTIONS.payments).countDocuments({}),
      refunds: await db.collection(COLLECTIONS.refunds).countDocuments({}),
    };
    console.log('[g1a-backfill] row counts AFTER: ', after);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
