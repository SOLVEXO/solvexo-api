/**
 * PRE-FLIGHT for the unique partial index `uniq_open_session_per_register` (register-session.schema.ts):
 * finds registers that have MORE THAN ONE open session. MongoDB cannot build the index while any exist, so
 * close them first (force-close each stale session from the app's Shift History, or via the admin tooling),
 * then deploy.
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/pos-preflight-open-sessions.ts
 *
 * READ-ONLY — never modifies data. Exit code 0 = safe to deploy; exit code 2 = duplicates found.
 * Needs MONGO_URI in the environment.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { findDuplicateOpenSessions } from './pos-rollout.lib';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const dupes = await findDuplicateOpenSessions(db);
  await mongoose.disconnect();

  if (dupes.length === 0) {
    console.log('OK — no register has more than one open session. Safe to build uniq_open_session_per_register.');
    return;
  }
  console.log(`${dupes.length} register(s) have more than one open session — close all but the intended one:\n`);
  for (const d of dupes) {
    console.log(`  register ${d.registerId} (store ${d.storeId}):`);
    for (const s of d.openSessions) {
      console.log(`    session ${s.sessionId}  employee=${s.employeeId}  opened=${s.openedAt ? new Date(s.openedAt).toISOString() : '-'}  sales=${s.totalSales} cash=${s.cashSales}`);
    }
  }
  process.exit(2);
}

run().catch((err) => { console.error(err); process.exit(1); });
