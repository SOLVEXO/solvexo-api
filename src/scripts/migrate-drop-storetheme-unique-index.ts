/**
 * One-time migration for the "Duplicate Theme" feature
 * (`StoreThemeService.duplicateTheme`) — must run once against every real
 * (dev/staging/prod) database before duplicating a theme works there.
 *
 * `store-theme.schema.ts` used to declare `{storeId, themeDefinitionId}` as
 * a UNIQUE index (one installed row per theme package). Duplicate Theme
 * needs a second row with the SAME `themeDefinitionId` on purpose — the
 * schema code was updated to a non-unique index, but Mongoose's `autoIndex`
 * only ever CREATES missing indexes; it never drops or redefines an
 * existing one with a conflicting `unique` setting. Any database that had
 * already synced the old unique index (which is every one — this feature
 * predates Duplicate Theme entirely) keeps silently enforcing it forever
 * until explicitly dropped, at which point `duplicateTheme` fails with a
 * real, confirmed `E11000 duplicate key error ... storeId_1_themeDefinitionId_1`
 * — found via live testing, not theorized.
 *
 * Idempotent — safe to run more than once (a second run finds no matching
 * index and no-ops).
 *
 * Usage: npx ts-node src/scripts/migrate-drop-storetheme-unique-index.ts
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

  const storeThemes = db.collection('storethemes');
  const indexes = await storeThemes.indexes();
  const staleUniqueIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ storeId: 1, themeDefinitionId: 1 }) && idx.unique,
  );

  if (staleUniqueIndex?.name) {
    await storeThemes.dropIndex(staleUniqueIndex.name);
    console.log(`Dropped stale unique index "${staleUniqueIndex.name}" on { storeId: 1, themeDefinitionId: 1 }`);
  } else {
    console.log('No stale unique index found — nothing to drop (already migrated, or a fresh database).');
  }

  await mongoose.disconnect();
  console.log('Done. Restart the API (or call syncIndexes) so the new non-unique index is created.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
