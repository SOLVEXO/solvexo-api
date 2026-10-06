/**
 * Backfills existing resource templates to the store's active installed
 * theme, then replaces the old store-wide unique index with a theme-scoped
 * unique index. Run once before deploying the theme-scoped API.
 *
 * Usage: npx ts-node src/scripts/migrate-theme-scoped-resource-templates.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const exists = await db.listCollections({ name: 'collectiontemplates' }).hasNext();
  if (!exists) {
    console.log('collectiontemplates collection does not exist — nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  const templates = db.collection('collectiontemplates');
  const themes = db.collection('storethemes');
  // `$in: [null]` intentionally matches both explicit null and absent fields,
  // covering documents created before/after Mongoose began applying defaults.
  const unassignedFilter = { installedThemeId: null };
  const storeIds = await templates.distinct('storeId', unassignedFilter);
  let migratedCount = 0;
  for (const storeId of storeIds) {
    const active = await themes.findOne({ storeId, status: 'active' }, { projection: { _id: 1 } });
    if (!active) throw new Error(`Store ${storeId} has resource templates but no active installed theme; migration stopped without dropping indexes.`);
    const result = await templates.updateMany(
      { storeId, installedThemeId: null },
      { $set: { installedThemeId: String(active._id) } },
    );
    migratedCount += result.modifiedCount;
  }

  const unassigned = await templates.countDocuments(unassignedFilter);
  if (unassigned) throw new Error(`${unassigned} resource templates remain unassigned; refusing index migration.`);

  await templates.createIndex(
    { storeId: 1, installedThemeId: 1, resourceType: 1, templateKey: 1 },
    { unique: true, name: 'storeId_1_installedThemeId_1_resourceType_1_templateKey_1' },
  );

  const indexes = await templates.indexes();
  const old = indexes.find((idx) => idx.unique && JSON.stringify(idx.key) === JSON.stringify({ storeId: 1, resourceType: 1, templateKey: 1 }));
  if (old?.name) await templates.dropIndex(old.name);

  console.log(`Assigned ${migratedCount} existing template(s) in ${storeIds.length} store(s) to their active theme and installed the theme-scoped unique index.`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
