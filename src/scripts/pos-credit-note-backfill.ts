/* eslint-disable no-console */
/**
 * Backfill of credit notes for refunds / voids made before credit notes existed (series CN-B…). Always run `--dry-run` first.
 *
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-credit-note-backfill.ts up --dry-run
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-credit-note-backfill.ts up [--max-docs N]
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-credit-note-backfill.ts down [--dry-run]
 *
 * Safety (same as the G1b backfill): does NOT read `.env` (MONGO_URI must be given explicitly); refuses a database whose name lacks "dev"/"test" unless BOTH
 * `--production` and `--i-have-a-backup` are passed; `up` is idempotent and resumable (re-run = continue); `down` removes only the notes it added (and its audit
 * events) and needs a user allowed to delete from the append-only collections. Nothing else is created or changed.
 */
import { MongoClient } from 'mongodb';
import { assertSafeTarget, backfillCreditNotes, backfillCreditNotesDown, CNB } from './pos-credit-note-backfill.lib';

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flag = (n: string) => rest.includes(n);
  const val = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const uri = process.env.MONGO_URI;
  if (!uri || (mode !== 'up' && mode !== 'down')) {
    console.error('Usage: MONGO_URI=… pos-credit-note-backfill.ts <up|down> [--dry-run] [--max-docs N] [--production --i-have-a-backup]');
    process.exit(2);
  }
  const client = await MongoClient.connect(uri);
  try {
    const db = client.db();
    assertSafeTarget(db.databaseName, { production: flag('--production'), iHaveABackup: flag('--i-have-a-backup') });
    const dryRun = flag('--dry-run');
    const counts = async () => Object.fromEntries(await Promise.all([CNB.refunds, CNB.sales, CNB.notes, CNB.audit].map(async (c) => [c, await db.collection(c).countDocuments({})])));
    console.log(`[cn-backfill] ${mode}${dryRun ? ' (DRY RUN — nothing is written)' : ''} on database "${db.databaseName}"`);
    console.log('[cn-backfill] document counts BEFORE:', await counts());
    if (mode === 'up') {
      const r = await backfillCreditNotes(db, { dryRun, maxDocs: val('--max-docs') ? Number(val('--max-docs')) : undefined });
      for (const s of r.stores) {
        console.log(`[cn-backfill] store ${s.storeId}: refunds ${s.refundCandidates}  voids ${s.voidCandidates}  ${dryRun ? 'would write' : 'written'} ${s.written}${s.firstNumber ? ` (${s.firstNumber} … ${s.lastNumber})` : ''}  legacy-decimal-amounts ${s.legacyMajorAmounts}  differs-from-proration ${s.deltas.length}  SKIPPED ${s.skipped.length}`);
        for (const d of s.deltas.slice(0, 20)) console.log(`[cn-backfill]    delta: ${d.originalType} ${d.originalId} ${d.deltaMinor} minor units put on the last line`);
        for (const x of s.skipped.slice(0, 50)) console.log(`[cn-backfill]    skipped: ${x.originalType} ${x.originalId} — ${x.reason}`);
      }
      console.log(`[cn-backfill] candidates ${r.totalCandidates}, ${dryRun ? 'would write' : 'written'} ${r.totalWritten}, skipped ${r.totalSkipped}`);
    } else {
      const d = await backfillCreditNotesDown(db, { dryRun });
      console.log(`[cn-backfill] ${dryRun ? 'would remove' : 'removed'} ${d.notes} backfilled credit notes and ${d.audit} audit events`);
    }
    console.log('[cn-backfill] document counts AFTER: ', await counts());
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
