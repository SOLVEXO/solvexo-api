/**
 * One-time migration for per-store buyer identity (see `users/schemas/
 * user.schema.ts`'s `storeId` field comment). Every pre-existing `users`
 * document was written under the OLD schema — a single-field unique index
 * on `email` alone, no `storeId`. This script:
 *
 *   1. Runs a pre-flight duplicate-email check (should be structurally
 *      impossible given the old unique index, but this is an identity/
 *      security-sensitive collection — verify, don't assume).
 *   2. Drops the old single-field unique index on `email`.
 *   3. Creates the new compound unique index on `{storeId, email}`
 *      DIRECTLY in this script (not left to app-boot autoIndex) — leaving
 *      it to autoIndex would open a real window with zero uniqueness
 *      enforcement on `email` between steps 2 and whenever the app next
 *      starts.
 *
 * No document backfill is needed — a missing `storeId` already behaves
 * identically to an explicit `null` for indexing purposes, so every
 * existing legacy account is already correctly and uniquely scoped among
 * other legacy (storeId: null) accounts, exactly as it was before this
 * migration.
 *
 * Idempotent — safe to run more than once. Must run once against every real
 * (dev/staging/prod) database before deploying the store-scoped-signup
 * backend code.
 *
 * Usage: npx ts-node src/scripts/migrate-user-store-scoped-email.ts
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

  const users = db.collection('users');

  // 1. Pre-flight safety check — must be empty before touching any index.
  const duplicates = await users
    .aggregate([
      { $group: { _id: '$email', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  if (duplicates.length > 0) {
    console.error(
      `Aborting: found ${duplicates.length} email(s) with more than one existing user document — ` +
        `resolve these manually before running this migration:`,
      duplicates.map((d) => d._id),
    );
    process.exit(1);
  }
  console.log('Pre-flight check passed — no duplicate emails found.');

  // 2. Drop the old single-field unique index on email.
  const indexes = await users.indexes();
  const legacyUniqueIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ email: 1 }) && idx.unique,
  );
  if (legacyUniqueIndex?.name) {
    await users.dropIndex(legacyUniqueIndex.name);
    console.log(`Dropped legacy unique index "${legacyUniqueIndex.name}" on { email: 1 }`);
  } else {
    console.log('No legacy single-field unique email index found — nothing to drop.');
  }

  // 3. Create the new compound unique index right away — never rely on
  // autoIndex to close this gap.
  const alreadyHasCompoundIndex = indexes.some(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ storeId: 1, email: 1 }) && idx.unique,
  );
  if (!alreadyHasCompoundIndex) {
    await users.createIndex({ storeId: 1, email: 1 }, { unique: true });
    console.log('Created new compound unique index on { storeId: 1, email: 1 }');
  } else {
    console.log('Compound unique index on { storeId: 1, email: 1 } already exists — nothing to create.');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
