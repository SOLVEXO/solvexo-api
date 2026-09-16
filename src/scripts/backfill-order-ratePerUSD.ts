/**
 * Phase 0 — currency normalization backfill (see `Order.ratePerUSD`'s schema
 * comment in `src/orders/schemas/order.schema.ts` and
 * `src/analytics/utils/order-aggregation.util.ts#toUSD` for the full
 * rationale). Every pre-existing `Order` document has no `ratePerUSD` field
 * at all — this script computes and sets it, using ONLY that order's own
 * immutable, already-stored data:
 *
 *   - `currency === 'USD'` (or missing entirely — the old implicit default
 *     documented on `Order.currency`) → `ratePerUSD: 1`.
 *   - otherwise → the matching entry in that order's own `fxSnapshots` for
 *     `currency`, if one exists → `ratePerUSD: <that entry's ratePerUSD>`.
 *   - otherwise → `ratePerUSD: null` — a genuine historical gap (an order
 *     placed before `fxSnapshots` existed, in a non-USD currency, with
 *     nothing to derive a rate from). NEVER a fresh/live rate lookup here —
 *     that would silently misrepresent what the buyer was actually charged
 *     against, at the time they were charged. A `null` order is correctly
 *     excluded (not zero-filled or guessed) from every USD-normalized
 *     analytics total by `toUSD`/`sumUSD` — this script does not, and must
 *     not, try to eliminate that count to zero.
 *
 * Purely additive — does not read, compute, or touch `subtotal`,
 * `totalAmount`, `settlementAmount`, `settlementCurrency`, or any other
 * existing field on `Order` or `SellerOrder`.
 *
 * Idempotent — only ever touches documents where `ratePerUSD` doesn't
 * already exist (including a previously-backfilled `null`), so re-running
 * this after new orders have been created (which now set `ratePerUSD`
 * themselves at creation time — see `payment.service.ts#createOrder` and
 * `draft-orders.service.ts#complete`) is always safe and a fast no-op over
 * anything already handled.
 *
 * Usage: npx ts-node src/scripts/backfill-order-ratePerUSD.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const BATCH_SIZE = 500;

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const orders = db.collection('orders');

  const cursor = orders.find(
    { ratePerUSD: { $exists: false } },
    { projection: { _id: 1, currency: 1, fxSnapshots: 1 } },
  );

  let scanned = 0;
  let setToOne = 0; // currency === 'USD' (or missing)
  let setFromSnapshot = 0;
  let unconvertibleGap = 0;
  let batch: { updateOne: { filter: { _id: any }; update: { $set: { ratePerUSD: number | null } } } }[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    await orders.bulkWrite(batch, { ordered: false });
    batch = [];
  };

  for await (const order of cursor) {
    scanned++;
    const currency: string = order.currency || 'USD';
    let ratePerUSD: number | null;

    if (currency === 'USD') {
      ratePerUSD = 1;
      setToOne++;
    } else {
      const snapshots: any[] = Array.isArray(order.fxSnapshots) ? order.fxSnapshots : [];
      const match = snapshots.find((s) => s?.currency === currency);
      if (match && typeof match.ratePerUSD === 'number' && match.ratePerUSD > 0) {
        ratePerUSD = match.ratePerUSD;
        setFromSnapshot++;
      } else {
        ratePerUSD = null; // genuine gap — disclosed via unconvertibleGap below, never guessed
        unconvertibleGap++;
      }
    }

    batch.push({ updateOne: { filter: { _id: order._id }, update: { $set: { ratePerUSD } } } });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`Scanned ${scanned} order(s) with no ratePerUSD yet.`);
  console.log(`  ratePerUSD = 1 (USD, or currency missing/implicit-USD): ${setToOne}`);
  console.log(`  ratePerUSD from this order's own fxSnapshots: ${setFromSnapshot}`);
  console.log(`  ratePerUSD = null (genuine historical gap — no matching fxSnapshots entry, excluded from USD totals, never guessed): ${unconvertibleGap}`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
