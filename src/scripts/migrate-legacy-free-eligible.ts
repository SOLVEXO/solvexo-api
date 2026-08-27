/**
 * One-time migration for the trial-based billing model (see
 * `SellerPlatformSubscription.legacyFreeEligible`'s schema comment). Every
 * pre-existing subscription document was created under the OLD model, where
 * every new store landed on the free "Starter" plan automatically and
 * forever. Those sellers are explicitly grandfathered — this script marks
 * every subscription that exists BEFORE this migration runs as
 * `legacyFreeEligible: true`, so `applyDunningFailure()`/
 * `finalizeScheduledCancellations()`/the `customer.subscription.deleted`
 * webhook keep sending them to `downgradeToFree()` exactly as before,
 * never to the new `locked` state.
 *
 * Every subscription created AFTER this migration runs defaults to
 * `legacyFreeEligible: false` at the schema level (new sellers enter the
 * trial-based model — see `ensureDefaultSubscription()`), so this script
 * only ever needs to run once.
 *
 * Idempotent — safe to run more than once (only touches documents missing
 * the field).
 *
 * Usage: npx ts-node src/scripts/migrate-legacy-free-eligible.ts
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

  const subs = db.collection('sellerplatformsubscriptions');

  const result = await subs.updateMany(
    { legacyFreeEligible: { $exists: false } },
    { $set: { legacyFreeEligible: true } },
  );
  console.log(`Backfilled legacyFreeEligible:true on ${result.modifiedCount} pre-existing subscription document(s).`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
