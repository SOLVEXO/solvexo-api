/* eslint-disable */
/**
 * One-time backfill: gives every OLD ledger transaction its own frozen USD value, at the exchange rate that was valid on
 * the day it happened (Shopify keeps each transaction's own rate). Transactions written after the frozen-rate change are
 * stamped automatically (see Transaction schema pre-save hook) — this only touches rows that have no `ratePerUSD` yet.
 *
 * SAFE BY DEFAULT: it only READS and prints a report unless you pass --apply.
 *
 *   node scripts/backfill-transaction-usd.js                # dry run: report only
 *   node scripts/backfill-transaction-usd.js --apply        # write the frozen rate/USD value
 *   node scripts/backfill-transaction-usd.js --revert       # (dry run) how many backfilled rows could be undone
 *   node scripts/backfill-transaction-usd.js --revert --apply   # undo ONLY rows this script wrote
 *
 * Needs MONGO_URI in the environment (or a .env file in the API folder). Take a database backup before --apply.
 * What it writes, per old transaction (raw collection write, only where `ratePerUSD` is null/missing):
 *   ratePerUSD      units of the transaction's currency per 1 USD, at (or nearest before) the transaction's createdAt
 *   amountUSD       amount / ratePerUSD, rounded to cents, signed like `amount`
 *   usdBackfilledAt marker so --revert can find exactly these rows
 * A transaction in USD gets rate 1. A currency with NO rate at all is skipped and counted (never guessed).
 * If a transaction is older than the oldest known rate for its currency, that oldest rate is used (and counted).
 */
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const BATCH = 500;
const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const tx = db.collection('transactions');

  console.log(`Mode: ${REVERT ? 'REVERT' : 'BACKFILL'} — ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);

  if (REVERT) {
    const n = await tx.countDocuments({ usdBackfilledAt: { $exists: true } });
    console.log(`Rows written by this script: ${n}`);
    if (APPLY && n > 0) {
      const r = await tx.updateMany({ usdBackfilledAt: { $exists: true } }, { $unset: { usdBackfilledAt: '' }, $set: { amountUSD: null, ratePerUSD: null } });
      console.log(`Reverted ${r.modifiedCount} rows.`);
    }
    return;
  }

  // Accepted rates per currency, oldest first.
  const rateRows = await db.collection('exchangerates')
    .find({ isRejected: { $ne: true }, ratePerUSD: { $gt: 0 } })
    .project({ currency: 1, ratePerUSD: 1, effectiveFrom: 1 })
    .sort({ effectiveFrom: 1 })
    .toArray();
  const ratesByCurrency = new Map();
  for (const r of rateRows) {
    if (!ratesByCurrency.has(r.currency)) ratesByCurrency.set(r.currency, []);
    ratesByCurrency.get(r.currency).push({ at: new Date(r.effectiveFrom).getTime(), rate: r.ratePerUSD });
  }
  const rateAt = (currency, when) => {
    if (currency === 'USD') return { rate: 1, early: false };
    const list = ratesByCurrency.get(currency);
    if (!list || list.length === 0) return null;
    const t = new Date(when).getTime();
    let lo = 0, hi = list.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].at <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found === -1) return { rate: list[0].rate, early: true }; // older than the oldest known rate
    return { rate: list[found].rate, early: false };
  };

  const filter = { $or: [{ ratePerUSD: null }, { ratePerUSD: { $exists: false } }] };
  const total = await tx.countDocuments(filter);
  console.log(`Transactions without a frozen rate: ${total}`);

  const stats = { updated: 0, noRate: 0, usedOldestRate: 0, byCurrency: {} };
  const noRateCurrencies = new Set();
  let ops = [];
  const flush = async () => {
    if (ops.length === 0) return;
    if (APPLY) await tx.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  const cursor = tx.find(filter).project({ amount: 1, currency: 1, createdAt: 1 });
  let sample = 0;
  for await (const t of cursor) {
    const currency = t.currency || 'USD';
    const hit = rateAt(currency, t.createdAt);
    if (!hit || typeof t.amount !== 'number') { stats.noRate++; noRateCurrencies.add(currency); continue; }
    if (hit.early) stats.usedOldestRate++;
    stats.updated++;
    stats.byCurrency[currency] = (stats.byCurrency[currency] || 0) + 1;
    if (!APPLY && sample < 5) { sample++; console.log(`  e.g. ${t._id} ${t.amount} ${currency} @ ${new Date(t.createdAt).toISOString().slice(0, 10)} → rate ${hit.rate} → ${round2(t.amount / hit.rate)} USD`); }
    ops.push({
      updateOne: {
        filter: { _id: t._id, $or: [{ ratePerUSD: null }, { ratePerUSD: { $exists: false } }] },
        update: { $set: { ratePerUSD: hit.rate, amountUSD: round2(t.amount / hit.rate), usdBackfilledAt: new Date() } },
      },
    });
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  console.log(`${APPLY ? 'Updated' : 'Would update'}: ${stats.updated}`);
  console.log(`  of which older than the oldest known rate (used that oldest rate): ${stats.usedOldestRate}`);
  console.log(`Skipped (currency has no rate at all): ${stats.noRate}${noRateCurrencies.size ? ' — ' + [...noRateCurrencies].join(', ') : ''}`);
  console.log('By currency:', stats.byCurrency);
  if (!APPLY) console.log('\nDry run only. Re-run with --apply to write (take a backup first).');
}

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
