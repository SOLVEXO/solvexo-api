// Repairs garbled names ("Ø¹Ø«Ù…Ø§Ù†") saved in sellers/staff/users/admins. DRY RUN unless --apply.
// Run: npx ts-node src/scripts/migrate-repair-mojibake-names.ts [--apply]   (needs MONGO_URI; take an Atlas backup first)
import 'dotenv/config';
import mongoose from 'mongoose';
import { repairMojibake } from '../common/repair-mojibake.util';

const COLLECTIONS = ['sellers', 'staffmembers', 'users', 'admins'];
const FIELDS = ['name', 'firstName', 'lastName', 'fullName'];

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI as string);
  const db = mongoose.connection.db!;
  let changed = 0;
  for (const col of COLLECTIONS) {
    const c = db.collection(col);
    for (const field of FIELDS) {
      const cursor = c.find({ [field]: { $type: 'string', $regex: '[\\u00c2-\\u00f4]' } }, { projection: { [field]: 1 } });
      for await (const doc of cursor) {
        const before = doc[field] as string;
        const after = repairMojibake(before);
        if (after === before) continue;
        changed++;
        console.log(`${col}/${doc._id}.${field}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
        if (apply) await c.updateOne({ _id: doc._id }, { $set: { [field]: after } });
      }
    }
  }
  console.log(`${apply ? 'Updated' : 'Would update (dry run)'}: ${changed} value(s)`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
