/* eslint-disable no-console */
/**
 * G3.0 backfill of the supply-side minor twins. Always run `--dry-run` first.
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g3-cost-minor-backfill.ts up --dry-run
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g3-cost-minor-backfill.ts up [--batch 500] [--max-docs N]
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-g3-cost-minor-backfill.ts down [--dry-run]
 * Safety = the G1b backfill's: no `.env`, non-dev databases refused without BOTH `--production` and `--i-have-a-backup`, idempotent, resumable, reversible.
 */
import { MongoClient } from 'mongodb';
import { assertSafeTarget, backfillCostMinor, backfillCostMinorDown } from './pos-g3-cost-minor-backfill.lib';

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flag = (n: string) => rest.includes(n);
  const val = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const uri = process.env.MONGO_URI;
  if (!uri || (mode !== 'up' && mode !== 'down')) { console.error('Usage: MONGO_URI=… pos-g3-cost-minor-backfill.ts <up|down> [--dry-run] [--batch N] [--max-docs N] [--production --i-have-a-backup]'); process.exit(2); }
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db();
    assertSafeTarget(db.databaseName, { production: flag('--production'), iHaveABackup: flag('--i-have-a-backup') });
    const dryRun = flag('--dry-run');
    console.log(`[g3-cost-backfill] ${mode}${dryRun ? ' (DRY RUN — nothing is written)' : ''} on database "${db.databaseName}"`);
    if (mode === 'up') {
      const r = await backfillCostMinor(db, { dryRun, batchSize: Number(val('--batch') ?? 500), maxDocs: val('--max-docs') ? Number(val('--max-docs')) : undefined });
      for (const c of r.collections) {
        console.log(`[g3-cost-backfill] ${c.collection.padEnd(16)} docs ${String(c.totalDocs).padStart(7)}  to fill ${String(c.candidates).padStart(7)}  ${dryRun ? 'would write' : 'written'} ${String(c.written).padStart(7)}  raced-skipped ${c.skippedRaced}  no-store ${c.skippedNoStore}  currency-filled ${c.currencyFilled}  OFF-GRID ${c.offGrid.length}`);
        for (const o of c.offGrid.slice(0, 10)) console.log(`[g3-cost-backfill]    off-grid: ${c.collection} ${o.id} ${o.field}=${o.value} → twin ${o.roundedMinor} minor units (the decimal keeps the sub-minor part)`);
      }
    } else {
      for (const x of await backfillCostMinorDown(db, { dryRun })) console.log(`[g3-cost-backfill] ${dryRun ? 'would remove' : 'removed'} twins from ${x.rows} ${x.collection} rows`);
    }
  } finally { await client.close(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
