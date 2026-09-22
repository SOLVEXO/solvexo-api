/**
 * One-time backfill for a real bug in `SellerPlatformSubscriptionsService.changePlan()`:
 * converting a trialing/manual store onto a real Stripe subscription set
 * `providerSubscriptionId` but never updated `paymentProvider` to `'stripe'`
 * (it was previously only ever set at `ensureDefaultSubscription()` time,
 * based on whether the seller already happened to have a Stripe customer id
 * BEFORE the store existed — almost never true for a fresh trial).
 *
 * Effect on any subscription this backfill targets, before this migration
 * runs: `expireTrials()`'s `paymentProvider === 'stripe'` check misses it and
 * locks the store out from under a seller who is actually paying via Stripe;
 * `processRenewals()`'s `{ paymentProvider: 'manual' }` query picks it up and
 * attempts a manual off-session charge with no `providerCustomerId`, which
 * can only fail and triggers dunning on an already-paying seller.
 *
 * This script finds every subscription that has a real `providerSubscriptionId`
 * but isn't tagged `paymentProvider: 'stripe'`, and corrects the tag only —
 * no billing/period/status field is touched.
 *
 * Idempotent — safe to run more than once (the query only ever matches rows
 * still needing the fix).
 *
 * Usage: npx ts-node src/scripts/migrate-backfill-stripe-payment-provider.ts
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
    {
      providerSubscriptionId: { $exists: true, $ne: null },
      paymentProvider: { $ne: 'stripe' },
    },
    { $set: { paymentProvider: 'stripe' } },
  );
  console.log(`Backfilled paymentProvider:'stripe' on ${result.modifiedCount} subscription(s) that already had a real Stripe subscription attached.`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
