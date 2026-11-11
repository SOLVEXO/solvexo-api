/**
 * Phase 2: COPIES the old single `fbrinvoices` collection into the two new ones, by issuer:
 *   issuer 'platform' -> `platform_einvoice_records`   issuer 'store' -> `store_einvoice_records`
 * The old collection is NOT changed or deleted (it stays until Phase 2 is signed off). Idempotent: a row already copied is skipped
 * (matched on source + sourceId + kind + mode, the same key as the new unique index), so running it twice creates nothing.
 *
 * FBR invoicing was never deployed, so a production database has nothing to copy: this is for development databases.
 * Safe by default: a DRY RUN that only counts. Pass `--apply` to write.
 *
 * Usage (dry run):  npx ts-node src/scripts/migrate-fbr-records.ts
 *       (write):    npx ts-node src/scripts/migrate-fbr-records.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const TARGET: Record<string, string> = { platform: 'platform_einvoice_records', store: 'store_einvoice_records' };

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const old = db.collection('fbrinvoices');
  const total = await old.countDocuments({});
  const stats: Record<string, { seen: number; copied: number; alreadyThere: number }> = { platform: { seen: 0, copied: 0, alreadyThere: 0 }, store: { seen: 0, copied: 0, alreadyThere: 0 } };
  let unknownIssuer = 0;

  for await (const doc of old.find({})) {
    const issuer = String(doc.issuer);
    const target = TARGET[issuer];
    if (!target) { unknownIssuer++; continue; }
    stats[issuer].seen++;
    const coll = db.collection(target);
    const key = { source: doc.source, sourceId: doc.sourceId, kind: doc.kind ?? 'sale', mode: doc.mode ?? 'sandbox' };
    if (await coll.findOne(key, { projection: { _id: 1 } })) { stats[issuer].alreadyThere++; continue; }
    if (apply) {
      const { _id, ...rest } = doc;
      await coll.insertOne({ ...rest, _id, authority: doc.authority ?? 'PK_FBR', viaLedger: doc.viaLedger ?? false });
    }
    stats[issuer].copied++;
  }

  console.log(JSON.stringify({ dryRun: !apply, oldCollectionRows: total, unknownIssuer, ...stats, note: 'the old fbrinvoices collection was not changed' }, null, 2));
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
