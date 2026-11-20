/**
 * One-time migration: bring stores that were GRANTED a paid plan without ever paying (the old billing flow applied
 * the plan the moment a Stripe subscription was created, before the first payment succeeded) into the new
 * "plan only after payment" flow.
 *
 * Candidates: a live Stripe-billed subscription on a paid plan (amountUSD > 0) with totalPaidUSD = 0 and NO paid
 * invoice on record, in status active/past_due. Admin-assigned plans (no Stripe subscription) are never touched.
 *
 * Before touching anything the script asks Stripe (read-only) about the subscription. If Stripe says the seller DID
 * pay (active/trialing subscription whose latest invoice is paid) the row is only reported as REVIEW — that is a
 * missed webhook, to be reconciled by hand, never downgraded.
 *
 * What a migrated store becomes:
 *  - legacy (grandfathered) store  -> the free plan, active            (same as downgradeToFree())
 *  - every other store             -> 'trial_ended' with no plan, so the blocking "Select a plan" gate shows and the
 *                                     seller can pay properly; storefront grace period starts now
 *  - the dead Stripe subscription is cancelled, pending/past-due markers are cleared, a `lastBillingError` explains why
 *  - Store.plan cache is set to 'starter'
 *
 * DRY-RUN BY DEFAULT: prints what it would do and changes nothing. Add --apply to write. Idempotent.
 *
 * Usage:  npx ts-node --transpile-only src/scripts/migrate-unpaid-granted-plans.ts          (dry run)
 *         npx ts-node --transpile-only src/scripts/migrate-unpaid-granted-plans.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Stripe from 'stripe';

const APPLY = process.argv.includes('--apply');
const GRACE_DAYS = 3;
const REASON = 'Your plan payment was never completed, so the plan was not activated. Please choose a plan and pay to continue.';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const subs = db.collection('sellerplatformsubscriptions');
  const invoices = db.collection('platformplaninvoices');
  const plans = db.collection('platformplans');
  const stores = db.collection('stores');
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  if (!stripe) console.warn('STRIPE_SECRET_KEY not set — cannot verify against Stripe, every candidate will be marked REVIEW.');

  console.log(APPLY ? '*** APPLY MODE — writing changes ***' : '--- DRY RUN — nothing will be changed ---');

  const candidates = await subs.find({
    isDelete: { $ne: true }, status: { $in: ['active', 'past_due'] }, paymentProvider: 'stripe',
    amountUSD: { $gt: 0 }, totalPaidUSD: { $lte: 0 }, providerSubscriptionId: { $ne: null }, platformPlanId: { $ne: null },
  }).toArray();
  const freePlan = await plans.findOne({ isFree: true, status: 'active', isDelete: { $ne: true } });

  let migrated = 0, review = 0;
  for (const s of candidates) {
    const paidInvoices = await invoices.countDocuments({ storeId: s.storeId, status: { $in: ['paid', 'partially_refunded', 'refunded'] } });
    const tag = `store ${s.storeId} (${s.status}, $${s.amountUSD}, ${s.legacyFreeEligible ? 'legacy' : 'standard'}, ${s.providerSubscriptionId})`;
    if (paidInvoices > 0) { console.log(`REVIEW  ${tag}: has ${paidInvoices} paid invoice(s) — not a never-paid store, skipped`); review++; continue; }

    let stripeStatus = 'unknown (no Stripe key)', stripePaid = false;
    if (stripe) {
      try {
        const sub: any = await stripe.subscriptions.retrieve(s.providerSubscriptionId, { expand: ['latest_invoice'] });
        stripeStatus = sub.status;
        stripePaid = ['active', 'trialing'].includes(sub.status) && sub.latest_invoice?.status === 'paid' && (sub.latest_invoice?.amount_paid ?? 0) > 0;
      } catch (err: any) {
        stripeStatus = `not found / error: ${err?.message}`;
      }
    }
    if (!stripe || stripePaid) { console.log(`REVIEW  ${tag}: Stripe=${stripeStatus}${stripePaid ? ' and the latest invoice is PAID — missed webhook, reconcile by hand' : ''}`); review++; continue; }

    // A legacy store goes to the free plan only if one exists; otherwise (e.g. production has none) it is gated like everyone else.
    const toFree = !!s.legacyFreeEligible && !!freePlan;
    const target = toFree ? `free plan (${freePlan!.name})` : "'trial_ended' (Select-a-plan gate)";
    console.log(`MIGRATE ${tag}: Stripe=${stripeStatus} -> ${target}`);
    if (!APPLY) { migrated++; continue; }

    if (stripe && !stripeStatus.startsWith('not found') && stripeStatus !== 'canceled') {
      try { await stripe.subscriptions.cancel(s.providerSubscriptionId); }
      catch (err: any) { console.warn(`        could not cancel Stripe subscription: ${err?.message}`); }
    }
    const now = new Date();
    const common = {
      providerSubscriptionId: null, paymentProvider: 'manual', pendingPlanChange: null, scheduledPlanChange: null,
      lastBillingError: REASON, pastDueSince: null, failedPaymentAttempts: 0, cancelAtPeriodEnd: false, canceledAt: null, cancelReason: null,
      amountUSD: 0, creditBalanceUSD: 0,
    };
    const set = toFree
      ? { ...common, platformPlanId: String(freePlan!._id), status: 'active', gracePeriodEndsAt: null, storefrontGatedAt: null }
      : { ...common, platformPlanId: null, status: 'trial_ended', gracePeriodEndsAt: new Date(now.getTime() + GRACE_DAYS * 86400000), storefrontGatedAt: null };
    // Filter on the current status so a row that changed meanwhile (e.g. the seller just paid) is not overwritten.
    const r = await subs.updateOne({ _id: s._id, status: s.status, totalPaidUSD: s.totalPaidUSD }, { $set: { ...set, updatedAt: now } });
    if (r.modifiedCount) {
      await stores.updateOne({ _id: new mongoose.Types.ObjectId(String(s.storeId)) }, { $set: { plan: 'starter' } });
      migrated++;
      console.log('        done.');
    } else {
      console.log('        row changed meanwhile — skipped.');
    }
  }

  console.log(`\n${APPLY ? 'Migrated' : 'Would migrate'}: ${migrated}   Needs manual review / skipped: ${review}   Candidates examined: ${candidates.length}`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
