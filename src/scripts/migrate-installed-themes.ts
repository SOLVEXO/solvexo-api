/**
 * One-time migration for the Theme Definition ⟷ Installed Theme Instance
 * split (see `store-theme/schemas/store-theme.schema.ts`'s class comment).
 * Every pre-existing `storethemes` document was written under the OLD
 * schema — a single-field unique index on `storeId` alone, no
 * `themeDefinitionId`/`status`/`installedAt`. This script:
 *
 *   1. Backfills `themeDefinitionId: 'warm-craft'`, `status: 'active'`,
 *      `installedAt: <createdAt or now>` on every document missing them.
 *   2. Drops the old single-field unique index on `storeId` so the new
 *      compound `{storeId, themeDefinitionId}` unique index (created
 *      automatically by Mongoose/`autoIndex` on next app boot, or via
 *      `syncIndexes()`) doesn't collide with it.
 *
 * Idempotent — safe to run more than once. Must run once against every real
 * (dev/staging/prod) database before deploying the multi-install backend
 * code; `StoreThemeService.ensureDefaultTheme` also lazily backfills a
 * single store's own row on read, but the index drop is a one-time,
 * connection-level operation this script is the only thing that does.
 *
 * Usage: npx ts-node src/scripts/migrate-installed-themes.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const DEFAULT_THEME_DEFINITION_ID = 'theme-01-atelier';

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

  const backfillResult = await storeThemes.updateMany(
    { themeDefinitionId: { $exists: false } },
    [
      {
        $set: {
          themeDefinitionId: DEFAULT_THEME_DEFINITION_ID,
          status: 'active',
          installedAt: { $ifNull: ['$createdAt', '$$NOW'] },
          'draft.themeDefinitionId': DEFAULT_THEME_DEFINITION_ID,
        },
      },
    ],
  );
  console.log(`Backfilled ${backfillResult.modifiedCount} store-theme document(s) with themeDefinitionId/status/installedAt`);

  const indexes = await storeThemes.indexes();
  const legacyUniqueIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ storeId: 1 }) && idx.unique,
  );
  if (legacyUniqueIndex?.name) {
    await storeThemes.dropIndex(legacyUniqueIndex.name);
    console.log(`Dropped legacy unique index "${legacyUniqueIndex.name}" on { storeId: 1 }`);
  } else {
    console.log('No legacy single-field unique storeId index found — nothing to drop');
  }

  await mongoose.disconnect();
  console.log('Done. Restart the API (or call syncIndexes) so the new compound index is created.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
