/**
 * One-time migration for the Collection Template → generalized Resource
 * Template split (see `collection-template/schemas/collection-template.schema.ts`'s
 * class comment). Every pre-existing `collectiontemplates` document was
 * written under the OLD schema — a single-field unique index on `storeId`
 * alone, no `resourceType`/`templateKey`/`name`/`isDefault`. This script:
 *
 *   1. Backfills `resourceType: 'collection'`, `templateKey: 'default'`,
 *      `name: 'Default'`, `isDefault: true` on every document missing them.
 *   2. Drops the old single-field unique index on `storeId` so the new
 *      compound `{storeId, resourceType, templateKey}` unique index doesn't
 *      collide with it.
 *
 * Idempotent — safe to run more than once.
 *
 * Usage: npx ts-node src/scripts/migrate-resource-templates.ts
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

  const collectionTemplates = db.collection('collectiontemplates');

  const backfillResult = await collectionTemplates.updateMany(
    { resourceType: { $exists: false } },
    { $set: { resourceType: 'collection', templateKey: 'default', name: 'Default', isDefault: true } },
  );
  console.log(`Backfilled ${backfillResult.modifiedCount} collection-template document(s) with resourceType/templateKey/name/isDefault`);

  const collectionExists = await db.listCollections({ name: 'collectiontemplates' }).hasNext();
  if (!collectionExists) {
    console.log('collectiontemplates collection does not exist yet (no store has used Collection Templates) — nothing to migrate.');
  } else {
    const indexes = await collectionTemplates.indexes();
    const legacyUniqueIndex = indexes.find(
      (idx) => JSON.stringify(idx.key) === JSON.stringify({ storeId: 1 }) && idx.unique,
    );
    if (legacyUniqueIndex?.name) {
      await collectionTemplates.dropIndex(legacyUniqueIndex.name);
      console.log(`Dropped legacy unique index "${legacyUniqueIndex.name}" on { storeId: 1 }`);
    } else {
      console.log('No legacy single-field unique storeId index found — nothing to drop');
    }
  }

  await mongoose.disconnect();
  console.log('Done. Restart the API (or call syncIndexes) so the new compound index is created.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
