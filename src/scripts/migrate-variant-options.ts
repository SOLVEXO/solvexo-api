/**
 * One-time migration: converts legacy ProductVariant.size/color fields into
 * the new generic `options: {name, value}[]` array, then unsets the old
 * fields. Run once after deploying the schema change, before the new
 * variant CRUD endpoints go live.
 *
 * Usage: npx ts-node src/scripts/migrate-variant-options.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const collection = db.collection('productvariants');

  const cursor = collection.find({
    $or: [
      { size: { $exists: true, $ne: null } },
      { color: { $exists: true, $ne: null } },
    ],
  });

  let migrated = 0;
  for await (const doc of cursor) {
    const options: { name: string; value: string }[] = [];
    if (doc.size) options.push({ name: 'Size', value: String(doc.size) });
    if (doc.color) options.push({ name: 'Color', value: String(doc.color) });

    await collection.updateOne(
      { _id: doc._id },
      {
        $set: { options },
        $unset: { size: '', color: '' },
      },
    );
    migrated++;
  }

  console.log(`Migrated ${migrated} variant(s).`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
