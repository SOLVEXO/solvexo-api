/* eslint-disable no-console */
/**
 * READ-ONLY. The flip-criteria report for G1b step f.
 *
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-minor-flip-report.ts --from 2026-11-10 --to 2026-11-24 [--store <id>] [--min-days 14] [--json]
 *
 * Shows the checker's mismatch count, an independent re-scan of the rows written in the window, the per-path counts (cash, card, split,
 * full / partial refund, held create / resume / discard, offline synced, shift close with card variance) and a READY / NOT READY verdict
 * against the owner's criteria (≥ 14 consecutive clean days AND every path exercised). Writes nothing; does not read `.env`.
 */
import { MongoClient } from 'mongodb';
import { buildFlipReport, FLIP_PATHS } from './pos-minor-flip-report.lib';

async function main() {
  const a = process.argv.slice(2);
  const val = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const uri = process.env.MONGO_URI;
  const from = val('--from'), to = val('--to');
  if (!uri || !from || !to) { console.error('Usage: MONGO_URI=… pos-minor-flip-report.ts --from YYYY-MM-DD --to YYYY-MM-DD [--store ID] [--min-days 14] [--json]'); process.exit(2); }
  const client = await MongoClient.connect(uri);
  try {
    const r = await buildFlipReport(client.db(), { from: new Date(from + 'T00:00:00.000Z'), to: new Date(to + 'T00:00:00.000Z'), storeId: val('--store'), minCleanDays: val('--min-days') ? Number(val('--min-days')) : 14 });
    if (a.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`G1b flip-criteria report  ${r.from} → ${r.to}   (needs ${r.minCleanDays} clean days + every path)`);
    console.log(`mismatches: ${r.mismatches.total}  (checker audit events ${r.mismatches.auditEvents}, re-scan violations ${r.mismatches.scanViolations})  by kind: ${JSON.stringify(r.mismatches.byKind)}`);
    console.log(`client payload mismatches (informational, accepted at the server's values; do not block the flip): ${r.clientPayloadMismatches}`);
    console.log(`rows re-scanned (dual-written, created in the window): sales ${r.checkedRows.sales}, shifts ${r.checkedRows.sessions}, payments ${r.checkedRows.payments}, refunds ${r.checkedRows.refunds}`);
    console.log(`consecutive clean days ending ${r.to}: ${r.consecutiveCleanDaysEndingAtTo}`);
    console.log('paths exercised:');
    for (const p of FLIP_PATHS) console.log(`  ${r.pathCounts[p] > 0 ? '✔' : '✘'} ${p.padEnd(24)} ${r.pathCounts[p]}`);
    console.log(r.ready ? 'VERDICT: READY to flip reads to minor (subject to the owner approving step f)' : `VERDICT: NOT READY — ${r.reasons.join('; ')}`);
    if (r.mismatches.firstExamples.length) console.log('examples:', JSON.stringify(r.mismatches.firstExamples));
  } finally {
    await client.close();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
