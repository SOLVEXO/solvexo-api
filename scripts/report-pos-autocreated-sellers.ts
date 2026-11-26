/* eslint-disable */
/**
 * READ-ONLY report (G6.6). Lists seller accounts that look auto-created by a Google / Apple sign-in in the POS app before the
 * login-only change: authProvider google or apple, NO password, and NO store of their own, created on or after --since.
 *
 *   MONGO_URI=<read-only connection string> npx ts-node --transpile-only scripts/report-pos-autocreated-sellers.ts --since=2026-10-01
 *
 * Prints the count and, for each seller, id / email / createdAt to stdout (one line each). Nothing else is read or printed.
 * It only runs `find` and `countDocuments` (two collections: sellers, stores). It refuses to run if any argument other than
 * `--since` is given (so `--write`, `--delete`, `--fix`, `--apply`, … all stop it), and use a database user with the `read` role
 * only, so even a bug here could not write. Do not run it against production without that user.
 */

/** Parses `--since=YYYY-MM-DD` / `--since YYYY-MM-DD`. Throws on anything else (write-looking flags get their own message). */
export function parseArgs(argv: string[]): { since: Date } {
  let since: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--(write|writes|delete|remove|update|fix|apply|execute|commit|drop|force|set|unset|insert|migrate|clean|cleanup|purge|repair)/i.test(a)) {
      throw new Error(`Refusing to run: "${a}" looks like a write flag. This script is read-only.`);
    }
    if (a.startsWith('--since=')) since = a.slice('--since='.length);
    else if (a === '--since') since = argv[++i];
    else throw new Error(`Unknown argument "${a}". Only --since=YYYY-MM-DD is accepted.`);
  }
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('Usage: --since=YYYY-MM-DD (required)');
  const d = new Date(`${since}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${since}"`);
  return { since: d };
}

export interface ReportRow { id: string; email: string; createdAt: string }

/** Only `find` / `countDocuments` on the two collections. `db` is a native Mongo Db handle. */
export async function findAutoCreatedSellers(db: any, since: Date): Promise<{ count: number; rows: ReportRow[] }> {
  const candidateFilter = {
    authProvider: { $in: ['google', 'apple'] },
    $or: [{ password: { $exists: false } }, { password: null }, { password: '' }],
    createdAt: { $gte: since },
  };
  const candidates: any[] = await db.collection('sellers').find(candidateFilter, { projection: { _id: 1, email: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray();
  const rows: ReportRow[] = [];
  for (const c of candidates) {
    // a store whose sellerId is this account (stored as a string in `stores`; ObjectId form checked too)
    const owned = await db.collection('stores').countDocuments({ sellerId: { $in: [String(c._id), c._id] } }, { limit: 1 });
    if (owned === 0) rows.push({ id: String(c._id), email: String(c.email ?? ''), createdAt: new Date(c.createdAt).toISOString() });
  }
  return { count: rows.length, rows };
}

async function main() {
  const { since } = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('Set MONGO_URI (a read-only user).');
  const mongoose = require('mongoose');
  const conn = await mongoose.createConnection(uri, { readPreference: 'secondaryPreferred' }).asPromise();
  try {
    const { count, rows } = await findAutoCreatedSellers(conn.db, since);
    console.log(`sellers auto-created by google/apple sign-in (no password, no store) since ${since.toISOString().slice(0, 10)}: ${count}`);
    for (const r of rows) console.log(`${r.id}\t${r.email}\t${r.createdAt}`);
  } finally {
    await conn.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
