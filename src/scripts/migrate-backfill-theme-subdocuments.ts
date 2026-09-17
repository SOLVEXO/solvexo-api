/**
 * One-time data-hygiene fix, found via a live QA audit crash report
 * ("Cannot read properties of undefined (reading 'headerStyle')" —
 * `resolveStorefrontCfg`) that traced back to a real, pre-existing gap: a
 * small number of `storethemes` documents predate `header`/`footer`/`theme`/
 * `identityBanner` even existing as fields at all — genuinely missing at the
 * top level, not just empty. `migrate-installed-themes.ts`'s earlier
 * backfill only added `themeDefinitionId`/`status`/`installedAt` and,
 * critically, unconditionally set `status: 'active'` on every previously-
 * untagged document — which is exactly what turned this latent gap into a
 * live crash on any store whose one (only) pre-migration document happened
 * to be one of these incomplete rows.
 *
 * The frontend (`resolveStorefrontCfg`, `StorefrontNavbar`, `StorefrontFooter`)
 * was ALSO hardened separately to null-safely handle a missing `header`/
 * `footer` (real defensive fix, not just papering over this data gap) — this
 * script is the complementary data-level fix: backfill the missing
 * top-level keys to `{}` so Mongoose's own subdocument schema defaults
 * (`logoSource:'store'`, `footerStyle:'columns'`, etc.) apply the next time
 * this document is read/saved through the real Model instead of `.lean()`.
 *
 * Idempotent — safe to run more than once (matches every field only when
 * genuinely absent).
 *
 * Usage: npx ts-node src/scripts/migrate-backfill-theme-subdocuments.ts
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

  for (const field of ['header', 'footer', 'theme', 'identityBanner'] as const) {
    const result = await storeThemes.updateMany(
      { [field]: { $exists: false } },
      { $set: { [field]: {} } },
    );
    console.log(`Backfilled ${result.modifiedCount} document(s) missing top-level "${field}"`);
  }

  // Same gap can exist inside `draft` (the seller's working copy) — check
  // and fix identically so the seller-facing Customize surface can't hit
  // the same class of crash either.
  for (const field of ['header', 'footer', 'theme', 'identityBanner'] as const) {
    const result = await storeThemes.updateMany(
      { [`draft.${field}`]: { $exists: false }, draft: { $exists: true } },
      { $set: { [`draft.${field}`]: {} } },
    );
    console.log(`Backfilled ${result.modifiedCount} document(s) missing "draft.${field}"`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
