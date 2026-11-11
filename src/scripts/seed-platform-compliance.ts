/**
 * Phase 4: creates the compliance record of Solvexo's FBR registration (state `unsupported`, nothing approved).
 * The API creates it by itself on first use, so this is optional; it only makes the record visible beforehand.
 *
 * Safe by default: a DRY RUN that prints what it would do. Pass `--apply` to write. Idempotent: an existing record is never changed
 * (the state is never reset or raised by this script).
 *
 * Usage:  npx ts-node src/scripts/seed-platform-compliance.ts [--apply]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const SUBJECT = { subjectType: 'registration', subjectId: 'solvexo-platform:PK:PK_FBR', entityKey: 'solvexo-platform', country: 'PK', authority: 'PK_FBR' };

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const coll = db.collection('platform_tax_compliance');
  const existing = await coll.findOne({ subjectType: SUBJECT.subjectType, subjectId: SUBJECT.subjectId });
  if (existing) {
    console.log(JSON.stringify({ dryRun: !apply, action: 'none', reason: 'record already exists', state: existing.state }, null, 2));
  } else if (apply) {
    await coll.insertOne({ ...SUBJECT, state: 'unsupported', snapshot: {}, history: [], liveApprovedAt: null, liveApprovedBy: null, createdAt: new Date(), updatedAt: new Date() });
    console.log(JSON.stringify({ dryRun: false, action: 'created', state: 'unsupported' }, null, 2));
  } else {
    console.log(JSON.stringify({ dryRun: true, action: 'would create', state: 'unsupported', subjectId: SUBJECT.subjectId }, null, 2));
  }
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
