/**
 * POS-plan rollout helper — lists stores that have USED POS (any register session or POS sale) but have no
 * active POS plan, so they can be reviewed before `POS_ENTITLEMENT_ENFORCED=true`. Optionally grants them a
 * plan of N days.
 *
 *   DRY RUN (default — changes nothing):
 *     npx ts-node -r tsconfig-paths/register src/scripts/pos-plan-backfill.ts
 *
 *   GRANT 30 days to every listed store:
 *     npx ts-node -r tsconfig-paths/register src/scripts/pos-plan-backfill.ts --grant --days 30 [--reason "text"]
 *
 * Safety:
 *  - Dry-run unless `--grant` is passed; `--grant` also REQUIRES `--days <1..3650>`.
 *  - Idempotent: stores that already have an active plan (including one this script granted a moment ago)
 *    are not listed and are never extended or duplicated. Re-running after a grant lists nothing.
 *  - INSERT-only: writes one manual PosPurchase row (source 'manual', grantedByAdminId 'script:pos-plan-backfill')
 *    and one `admin_audit` activity-log row (with the reason) per store. Edits/deletes nothing.
 *
 * Needs MONGO_URI in the environment (same as the other scripts in this folder).
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { findStoresUsingPosWithoutPlan, grantStores } from './pos-rollout.lib';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }

  const grant = process.argv.includes('--grant');
  const days = Number(arg('days'));
  const reason = arg('reason') ?? 'Pre-enforcement migration grant (existing POS user)';
  if (grant && !(Number.isInteger(days) && days >= 1 && days <= 3650)) {
    console.error('--grant requires --days <whole number 1..3650>');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const stores = await findStoresUsingPosWithoutPlan(db);
  console.log(`${stores.length} store(s) have used POS and have no active POS plan:\n`);
  for (const s of stores) {
    console.log(`  ${s.storeId}  ${s.storeName ?? '(unnamed)'}  [${s.storeStatus}]  sessions=${s.sessions} sales=${s.sales}  last=${s.lastActivityAt?.toISOString() ?? '-'}  plan=${s.planState}${s.lastPlanExpiredAt ? ` (expired ${s.lastPlanExpiredAt.toISOString()})` : ''}`);
  }

  if (!grant) {
    console.log(`\nDRY RUN — nothing was changed. Re-run with --grant --days <N> to grant these stores a plan.`);
  } else if (stores.length) {
    const { granted, skipped } = await grantStores(db, stores, { days, reason, actorId: 'script:pos-plan-backfill' });
    console.log(`\nGranted ${days} day(s) to ${granted.length} store(s); skipped ${skipped.length} that already had an active plan.`);
  }

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
