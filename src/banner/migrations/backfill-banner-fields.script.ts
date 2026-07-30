/* eslint-disable prettier/prettier */
/**
 * One-time backfill for pre-migration `Banner` rows that predate the
 * `placement`/`status` fields (see the Promotion System implementation plan).
 * Not required for correctness — `BannersService.findAll()` already falls back
 * gracefully for legacy rows on the unscoped path — but running this once lets
 * `GET /api/banners?placement=marketplaceHero`-style scoped queries pick up
 * older rows too, and tags them with an explicit `status` instead of relying
 * on the `isActive` fallback indefinitely.
 *
 * Run once via (loads .env through Node's built-in --env-file so no extra
 * dependency is needed): node --env-file=.env -r ts-node/register -r tsconfig-paths/register src/banner/migrations/backfill-banner-fields.script.ts
 */
import mongoose from 'mongoose';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri);

  const banners = mongoose.connection.collection('banners');

  const placementResult = await banners.updateMany(
    { placement: { $exists: false } },
    { $set: { placement: 'marketplaceHero' } },
  );

  const statusResult = await banners.updateMany({ status: { $exists: false } }, [
    { $set: { status: { $cond: ['$isActive', 'active', 'draft'] } } },
  ]);

  console.log(`Backfilled placement on ${placementResult.modifiedCount} banner(s).`);
  console.log(`Backfilled status on ${statusResult.modifiedCount} banner(s).`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Banner backfill failed:', err);
  process.exit(1);
});
