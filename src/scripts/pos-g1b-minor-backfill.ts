/* eslint-disable no-console */
/**
 * G1b step c — backfill of the minor-unit twins. Always run `--dry-run` first.
 *
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g1b-minor-backfill.ts up --dry-run
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g1b-minor-backfill.ts up [--batch 500] [--resume] [--max-docs N]
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g1b-minor-backfill.ts down [--dry-run]
 *
 * Safety: does NOT read `.env` (MONGO_URI must be given explicitly). Refuses a database whose name lacks "dev"/"test" unless BOTH
 * `--production` and `--i-have-a-backup` are passed. `up` is idempotent, resumable and safe under live traffic; `down` removes only
 * what `up` added (rows carrying `minorBackfilledAt`). `down` uses raw collection updates, i.e. it needs a user allowed to update
 * the append-only collections.
 */
import { MongoClient } from 'mongodb';
import { assertSafeTarget, backfillMinor, backfillMinorDown, G1B } from './pos-g1b-minor-backfill.lib';

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flag = (n: string) => rest.includes(n);
  const val = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const uri = process.env.MONGO_URI;
  if (!uri || (mode !== 'up' && mode !== 'down')) {
    console.error('Usage: MONGO_URI=… pos-g1b-minor-backfill.ts <up|down> [--dry-run] [--batch N] [--resume] [--max-docs N] [--production --i-have-a-backup]');
    process.exit(2);
  }
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db();
    assertSafeTarget(db.databaseName, { production: flag('--production'), iHaveABackup: flag('--i-have-a-backup') });
    const dryRun = flag('--dry-run');
    const counts = async () => Object.fromEntries(await Promise.all([G1B.sales, G1B.sessions, G1B.payments, G1B.refunds, G1B.stores].map(async (c) => [c, await db.collection(c).countDocuments({})])));
    console.log(`[g1b-backfill] ${mode}${dryRun ? ' (DRY RUN — nothing is written)' : ''} on database "${db.databaseName}"`);
    console.log('[g1b-backfill] document counts BEFORE:', await counts());

    if (mode === 'up') {
      const batchSize = Number(val('--batch') ?? 500);
      const report = await backfillMinor(db, { dryRun, batchSize, resume: flag('--resume'), maxDocs: val('--max-docs') ? Number(val('--max-docs')) : undefined });
      console.log(`[g1b-backfill] batch size ${report.batchSize}`);
      for (const c of report.collections) {
        console.log(`[g1b-backfill] ${c.collection.padEnd(16)} docs ${String(c.totalDocs).padStart(8)}  to fill ${String(c.candidates).padStart(8)}  written ${String(c.written).padStart(8)}  retried-after-conflict ${c.conflictsRetried}  currency-inferred ${c.currencyInferred}  float-noise ${c.floatNoise}  OFF-GRID ${c.offGrid.length}${c.readComputeDocsPerSec ? `  (read+compute ${c.readComputeDocsPerSec} docs/s)` : ''}`);
        for (const o of c.offGrid.slice(0, 10)) console.log(`[g1b-backfill]    off-grid: ${c.collection} ${o.id} ${o.field}=${o.value} → rounded to ${o.roundedMinor} minor units`);
      }
      console.log(`[g1b-backfill] total documents to fill: ${report.totalCandidates}; estimated duration at ${report.assumedWriteDocsPerSec} docs/s (conservative assumption — rehearse on a restored copy for the real number): ~${report.estimatedSeconds}s (~${Math.ceil(report.estimatedSeconds / 60)} min)`);
    } else {
      const out = await backfillMinorDown(db, { dryRun });
      for (const r of out) console.log(`[g1b-backfill] ${dryRun ? 'would remove' : 'removed'} minor twins from ${r.rows} ${r.collection} rows`);
    }
    console.log('[g1b-backfill] document counts AFTER: ', await counts());
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
